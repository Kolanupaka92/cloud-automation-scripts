/**
 * Shared test harness: builds the real router over an injectable store and a
 * fake Stripe gateway, and drives it with plain request contexts.
 *
 * This lives outside a *.test.ts file on purpose. Importing a test module to
 * reuse its helpers would re-register every test it declares, so the in-memory
 * suite would run again inside the PostgreSQL one.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildDeps, buildRouter, type AppDeps } from "../src/app.js";
import type { HttpResult, RequestContext } from "../src/http/router.js";
import { FakeStripeGateway } from "../src/infra/stripe/fake.js";
import { InMemoryRateLimiter } from "../src/infra/rateLimit.js";

export const CONFIG = {
  tokenSecret: "test-token-secret-long-enough-for-hmac",
  webhookSigningSecret: "whsec_test_secret",
  exposeDevSecrets: true,
};

export const FRISCO = { lat: 33.1507, lng: -96.8236 };
export const PLANO = { lat: 33.0198, lng: -96.6989 };

export interface Harness {
  readonly deps: AppDeps;
  readonly stripe: FakeStripeGateway;
  call(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; headers?: Record<string, string>; rawBody?: string },
  ): Promise<HttpResult>;
}

export function harness(store?: AppDeps["store"]): Harness {
  const stripe = new FakeStripeGateway();
  // A generous clock-free limiter, so the flow tests are not throttled.
  const deps = buildDeps({
    config: CONFIG,
    stripe,
    limiter: new InMemoryRateLimiter(() => Date.now()),
    ...(store ? { store } : {}),
  });
  const router = buildRouter(deps);
  let counter = 0;

  return {
    deps,
    stripe,
    async call(method, path, options = {}) {
      counter += 1;
      const rawBody = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body));
      const ctx: Omit<RequestContext, "params"> = {
        method,
        path,
        query: new URLSearchParams(),
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers ?? {}),
        },
        rawBody,
        body: rawBody ? JSON.parse(rawBody) : undefined,
        // A distinct address per call, so the shared limiter is not the thing
        // under test here.
        ip: `10.0.0.${counter % 250}`,
        traceId: `trc_test_${counter}`,
      };
      return router.handle(ctx);
    },
  };
}

/** Register, verify the phone, and come back with an MFA-verified session. */
/** A distinct E.164 number per account: the schema requires phone to be unique. */
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+1469555${String(phoneSeq).padStart(4, "0")}`;
}

export async function onboard(
  h: Harness,
  input: { email: string; roles: string[]; homeBase: { lat: number; lng: number }; languages?: string[] },
): Promise<{ userId: string; token: string }> {
  const registered = await h.call("POST", "/v1/auth/register", {
    body: {
      email: input.email,
      password: "a-long-enough-passphrase",
      displayName: input.email.split("@")[0],
      roles: input.roles,
      homeBase: input.homeBase,
      phone: nextPhone(),
      languages: input.languages ?? ["english", "telugu"],
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const userId = (registered.body as { user: { id: string } }).user.id;

  const loggedIn = await h.call("POST", "/v1/auth/login", {
    body: { email: input.email, password: "a-long-enough-passphrase" },
  });
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
  const firstToken = (loggedIn.body as { accessToken: string }).accessToken;

  const sent = await h.call("POST", "/v1/auth/otp/send", { token: firstToken });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const code = (sent.body as { devCode: string }).devCode;

  const verified = await h.call("POST", "/v1/auth/otp/verify", { token: firstToken, body: { code } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return { userId, token: (verified.body as { accessToken: string }).accessToken };
}

/** Take a vendor all the way to payout-ready. */
export async function payoutReadyVendor(h: Harness, email: string) {
  const vendor = await onboard(h, { email, roles: ["crew"], homeBase: PLANO });
  await h.call("POST", "/v1/auth/mfa/enable", { token: vendor.token });
  await h.deps.store.users.update(vendor.userId, { verification: "id_verified", mfaEnabled: true });

  const profile = await h.call("POST", "/v1/profiles/crew", {
    token: vendor.token,
    body: {
      specialties: ["mua"],
      culturalTags: ["telugu_traditional", "south_indian_bridal"],
      startingRateCents: 55_000,
      yearsExperience: 6,
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));

  const onboarded = await h.call("POST", "/v1/connect/onboard", { token: vendor.token });
  assert.equal(onboarded.status, 201, JSON.stringify(onboarded.body));
  h.stripe.completeOnboarding((onboarded.body as { accountId: string }).accountId);
  return vendor;
}

export const BRIEF = {
  eventType: "half_saree_function",
  specialty: "mua",
  eventDate: "2027-06-20",
  venue: FRISCO,
  budgetMinCents: 40_000,
  budgetMaxCents: 90_000,
  culturalTags: ["telugu_traditional"],
  languages: ["telugu"],
};


/** Sign and post a Stripe webhook exactly as Stripe would. */
export async function postWebhook(h: Harness, event: unknown): Promise<HttpResult> {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", CONFIG.webhookSigningSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return h.call("POST", "/v1/webhooks/stripe", {
    rawBody,
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
  });
}
