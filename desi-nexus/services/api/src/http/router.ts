/**
 * A minimal router over node:http.
 *
 * No framework, deliberately: the whole request path is about 150 lines and can
 * be read end to end during a security review, which is worth more on a service
 * that moves money than the convenience of a middleware ecosystem.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenClaims } from "../infra/tokens.js";

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage["headers"];
  readonly rawBody: string;
  readonly body: unknown;
  readonly ip: string;
  /** Set by the auth middleware once a bearer token has been verified. */
  auth?: TokenClaims;
  readonly traceId: string;
}

export interface HttpResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export type HandlerFn = (ctx: RequestContext) => Promise<HttpResult> | HttpResult;
export type Middleware = (ctx: RequestContext, next: () => Promise<HttpResult>) => Promise<HttpResult>;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: HandlerFn;
  readonly middleware: readonly Middleware[];
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly global: Middleware[] = [];

  use(middleware: Middleware): this {
    this.global.push(middleware);
    return this;
  }

  add(method: string, pattern: string, handler: HandlerFn, ...middleware: Middleware[]): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter(Boolean),
      handler,
      middleware,
    });
    return this;
  }

  get(pattern: string, handler: HandlerFn, ...mw: Middleware[]): this {
    return this.add("GET", pattern, handler, ...mw);
  }
  post(pattern: string, handler: HandlerFn, ...mw: Middleware[]): this {
    return this.add("POST", pattern, handler, ...mw);
  }
  patch(pattern: string, handler: HandlerFn, ...mw: Middleware[]): this {
    return this.add("PATCH", pattern, handler, ...mw);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i] as string;
        const value = parts[i] as string;
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }

  async handle(ctx: Omit<RequestContext, "params">): Promise<HttpResult> {
    const found = this.match(ctx.method, ctx.path);
    if (!found) {
      return { status: 404, body: { error: { code: "not_found", message: `no route for ${ctx.method} ${ctx.path}` } } };
    }
    const full: RequestContext = { ...ctx, params: found.params };
    const chain = [...this.global, ...found.route.middleware];

    let index = -1;
    const dispatch = async (i: number): Promise<HttpResult> => {
      if (i <= index) throw new Error("next() called more than once");
      index = i;
      const middleware = chain[i];
      if (!middleware) return found.route.handler(full);
      return middleware(full, () => dispatch(i + 1));
    };
    return dispatch(0);
  }
}

/** Cap on request bodies. Portfolio media goes to S3 directly, not through here. */
export const MAX_BODY_BYTES = 256 * 1024;

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Security headers applied to every response. HSTS is set at the edge too, but
 * duplicated here so a direct-to-pod request is not quietly weaker than one
 * through the load balancer.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

export function send(res: ServerResponse, result: HttpResult, traceId: string): void {
  const payload = result.body === undefined ? "" : JSON.stringify(result.body);
  res.writeHead(result.status, {
    ...SECURITY_HEADERS,
    ...(result.headers ?? {}),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-trace-id": traceId,
  });
  res.end(payload);
}
