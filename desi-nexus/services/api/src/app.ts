/**
 * Application wiring.
 *
 * Everything the service needs is passed in, so a test can build the whole API
 * over an in-memory store and a fake Stripe gateway and exercise real routes.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Router, readBody, send, HttpError, type RequestContext } from "./http/router.js";
import { errorBoundary, rateLimit } from "./http/middleware.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerGigRoutes } from "./http/routes/gigs.js";
import { registerPaymentRoutes } from "./http/routes/payments.js";
import { registerDiscoveryRoutes } from "./http/routes/discovery.js";
import { InMemoryRateLimiter, type RateLimiter } from "./infra/rateLimit.js";
import { RedisRateLimiter } from "./infra/redisRateLimit.js";
import { createInMemoryStore, type Store } from "./infra/store.js";
import { connect } from "./infra/postgres/db.js";
import { createPostgresStore } from "./infra/postgres/store.js";
import type { StripeGateway } from "./infra/stripe/index.js";
import { FakeStripeGateway } from "./infra/stripe/fake.js";
import { liveStripeFromEnv } from "./infra/stripe/live.js";
import { InMemoryEventBus, type EventBus } from "./events/bus.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface AppConfig {
  readonly tokenSecret: string;
  readonly webhookSigningSecret: string;
  /** Set false in production; it exposes OTP codes in responses for local runs. */
  readonly exposeDevSecrets: boolean;
}

export interface AppDeps {
  readonly config: AppConfig;
  readonly store: Store;
  readonly stripe: StripeGateway;
  readonly bus: EventBus;
  readonly limiter: RateLimiter;
}

/**
 * Connections this process opened and must close on the way out. Handing back
 * a closer keeps the ownership obvious: whoever built the dependency closes it,
 * and a caller who passed its own store or limiter in is left alone.
 */
const owned: Array<() => Promise<void>> = [];

export function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const config: AppConfig = overrides.config ?? {
    tokenSecret: process.env.DESI_NEXUS_TOKEN_SECRET ?? randomUUID(),
    webhookSigningSecret: process.env.DESI_NEXUS_WEBHOOK_SECRET ?? randomUUID(),
    exposeDevSecrets: process.env.NODE_ENV !== "production",
  };
  return {
    config,
    store: overrides.store ?? defaultStore(),
    stripe: overrides.stripe ?? defaultStripeGateway(),
    bus: overrides.bus ?? new InMemoryEventBus(),
    limiter: overrides.limiter ?? defaultRateLimiter(),
  };
}

export async function shutdownDeps(): Promise<void> {
  await Promise.allSettled(owned.map((close) => close()));
  owned.length = 0;
}

/**
 * PostgreSQL when a database is configured, in-memory otherwise.
 *
 * Production refuses the in-memory store for the obvious reason: it loses every
 * user, gig and ledger entry on restart, and a marketplace that forgets a
 * booking is worse than one that will not start.
 */
function defaultStore(): Store {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production: the in-memory store is not durable");
    }
    return createInMemoryStore();
  }
  const db = connect({
    connectionString: url,
    // Behind a transaction pooler (Supabase's 6543, PgBouncer) the server holds
    // far fewer connections than clients think they have, so keep this modest.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  owned.push(() => db.close());
  return createPostgresStore(db);
}

/**
 * A shared limiter when Redis is configured, the in-process one otherwise.
 *
 * Production refuses the in-process limiter outright. With more than one
 * replica it is not a limit at all: each pod keeps its own buckets, so the
 * effective allowance is whatever was configured multiplied by the number of
 * pods. Failing to start is the honest outcome, because the alternative is a
 * service that looks rate limited and is not.
 */
function defaultRateLimiter(): RateLimiter {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("REDIS_URL is required in production: per-pod rate limits are not limits");
    }
    return new InMemoryRateLimiter();
  }
  const client = new Redis(url, {
    // Fail fast rather than queueing requests behind a dead Redis; the limiter
    // degrades to fail-open, which is the behaviour we want during an outage.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  client.on("error", (error) => console.error("[redis] client error", error));
  owned.push(async () => {
    await client.quit().catch(() => client.disconnect());
  });
  return new RedisRateLimiter(client);
}

/**
 * Live payments when a key is configured, the fake otherwise.
 *
 * The choice is made by the presence of a key rather than by a flag, so there
 * is no way to be in production with `USE_REAL_STRIPE=false` still set. The
 * production guard in index.ts refuses to start without one.
 */
function defaultStripeGateway(): StripeGateway {
  if (!process.env.STRIPE_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STRIPE_API_KEY is required in production");
    }
    return new FakeStripeGateway();
  }
  return liveStripeFromEnv();
}

export function buildRouter(deps: AppDeps): Router {
  const router = new Router();
  router.use(errorBoundary());
  router.use(rateLimit(deps.limiter, "default"));

  router.get("/healthz", () => ({ status: 200, body: { status: "ok" } }));

  registerAuthRoutes(router, deps);
  registerDiscoveryRoutes(router, deps);
  registerGigRoutes(router, deps);
  registerPaymentRoutes(router, deps);
  return router;
}

/** Turn a node:http request into a RequestContext and dispatch it. */
export function createRequestListener(router: Router) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const traceId = `trc_${randomUUID().slice(0, 12)}`;
    const url = new URL(req.url ?? "/", "http://localhost");
    let rawBody = "";
    try {
      rawBody = await readBody(req);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, { status: error.status, body: { error: { code: error.code, message: error.message } } }, traceId);
        return;
      }
      throw error;
    }

    let body: unknown;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        send(res, { status: 400, body: { error: { code: "invalid_json", message: "request body is not valid JSON" } } }, traceId);
        return;
      }
    }

    const ctx: Omit<RequestContext, "params"> = {
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      rawBody,
      body,
      // Behind the load balancer the real client address is the first hop in
      // X-Forwarded-For; trusting the whole header would let a client spoof its
      // own identity and escape its rate limit bucket.
      ip: firstForwardedFor(req.headers["x-forwarded-for"]) ?? req.socket.remoteAddress ?? "unknown",
      traceId,
    };

    const result = await router.handle(ctx);
    send(res, result, traceId);
  };
}

function firstForwardedFor(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}
