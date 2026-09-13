/**
 * Request middleware: authentication, authorisation, rate limiting and the
 * error boundary.
 *
 * The posture is deny-by-default. A route says what it needs; anything it does
 * not explicitly allow is refused.
 */
import { HttpError, type Middleware, type RequestContext } from "./router.js";
import { verifyToken, TokenError } from "../infra/tokens.js";
import type { RateLimiter, PolicyName } from "../infra/rateLimit.js";
import type { Role } from "../domain/users.js";

export function errorBoundary(): Middleware {
  return async (ctx, next) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof HttpError) {
        return {
          status: error.status,
          body: {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
            traceId: ctx.traceId,
          },
        };
      }
      // Never leak an internal message or stack to a client. The trace id is
      // the handle support uses to find the real one in the logs.
      console.error(`[${ctx.traceId}] unhandled error on ${ctx.method} ${ctx.path}`, error);
      return {
        status: 500,
        body: { error: { code: "internal_error", message: "something went wrong" }, traceId: ctx.traceId },
      };
    }
  };
}

/**
 * Rate limiting keyed on the authenticated user where there is one, and on the
 * client address otherwise. Keying anonymous traffic on the address is
 * imperfect behind carrier NAT, which is why the anonymous buckets are the
 * generous ones and the expensive endpoints all require a token.
 */
export function rateLimit(limiter: RateLimiter, policy: PolicyName = "default"): Middleware {
  return async (ctx, next) => {
    const identity = ctx.auth?.sub ?? ctx.ip;
    const decision = await limiter.check(identity, policy);
    if (!decision.allowed) {
      throw new HttpError(429, "rate_limited", "too many requests; slow down", {
        retryAfterSeconds: decision.retryAfter,
      });
    }
    return next();
  };
}

/** Verify the bearer token and attach its claims. Access tokens only. */
export function authenticate(secret: string): Middleware {
  return async (ctx, next) => {
    const header = ctx.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "unauthenticated", "a bearer token is required");
    }
    try {
      const claims = verifyToken(header.slice(7).trim(), secret);
      if (claims.typ !== "access") {
        throw new HttpError(401, "unauthenticated", "a refresh token cannot be used to call an endpoint");
      }
      ctx.auth = claims;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof TokenError) throw new HttpError(401, "unauthenticated", error.message);
      throw error;
    }
    return next();
  };
}

export function requireRole(...roles: Role[]): Middleware {
  return async (ctx, next) => {
    const held = ctx.auth?.roles ?? [];
    if (!roles.some((role) => held.includes(role))) {
      throw new HttpError(403, "forbidden", `this endpoint requires one of: ${roles.join(", ")}`);
    }
    return next();
  };
}

/**
 * Step-up authentication. Anything that can move money or change payout details
 * requires a session that actually cleared MFA, not merely an account that has
 * MFA configured.
 */
export function requireMfa(): Middleware {
  return async (ctx, next) => {
    if (!ctx.auth?.mfa) {
      throw new HttpError(403, "mfa_required", "this action requires a multi-factor verified session");
    }
    return next();
  };
}

/** Read a required field off the JSON body with a useful 400 when it is absent. */
export function field<T>(ctx: RequestContext, name: string, check: (value: unknown) => value is T): T {
  const body = ctx.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  if (!check(value)) {
    throw new HttpError(400, "invalid_request", `field "${name}" is missing or invalid`);
  }
  return value;
}

export const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
