/**
 * Registration, login, phone OTP and MFA step-up.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError, type Router } from "../router.js";
import { authenticate, field, isObject, isString, isStringArray, rateLimit } from "../middleware.js";
import { hashPassword, verifyPassword, PasswordPolicyError } from "../../infra/passwords.js";
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  generateOtp,
  issueToken,
  newSessionId,
  verifyToken,
  TokenError,
} from "../../infra/tokens.js";
import { validateBaseUser, ValidationError, type BaseUser, type Role } from "../../domain/users.js";
import { nearestMetro } from "../../domain/geo.js";
import { TOPICS } from "../../events/bus.js";
import type { AppDeps } from "../../app.js";

const OTP_TTL_MINUTES = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const hashOtp = (code: string, userId: string): string =>
  createHash("sha256").update(`${userId}:${code}`).digest("hex");

export function registerAuthRoutes(router: Router, deps: AppDeps): void {
  const { config, store, bus, limiter } = deps;
  const authLimit = rateLimit(limiter, "auth");
  const otpLimit = rateLimit(limiter, "otp");
  const requireAuth = authenticate(config.tokenSecret);

  router.post(
    "/v1/auth/register",
    async (ctx) => {
      const email = field(ctx, "email", isString);
      const password = field(ctx, "password", isString);
      const displayName = field(ctx, "displayName", isString);
      const roles = field(ctx, "roles", isStringArray) as Role[];
      const homeBase = field(ctx, "homeBase", isObject) as { lat: number; lng: number };
      const body = ctx.body as Record<string, unknown>;

      const user: BaseUser = {
        id: randomUUID(),
        email: email.toLowerCase(),
        displayName: displayName.trim(),
        roles,
        verification: "unverified",
        mfaEnabled: false,
        homeBase,
        metroId: "",
        languages: (Array.isArray(body.languages) ? body.languages : []) as BaseUser["languages"],
        createdAt: new Date().toISOString(),
        ...(typeof body.phone === "string" ? { phone: body.phone } : {}),
      };

      try {
        validateBaseUser(user);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new HttpError(400, "invalid_request", error.message, { field: error.field });
        }
        throw error;
      }
      // Admin is granted out of band, never self-assigned at registration.
      if (roles.includes("admin")) {
        throw new HttpError(403, "forbidden", "the admin role cannot be self-assigned");
      }
      user.metroId = nearestMetro(user.homeBase).metro.id;

      let passwordHash: string;
      try {
        passwordHash = await hashPassword(password);
      } catch (error) {
        if (error instanceof PasswordPolicyError) {
          throw new HttpError(400, "weak_password", error.message);
        }
        throw error;
      }

      let created: BaseUser;
      try {
        created = await store.users.create(user);
      } catch {
        // Do not confirm whether an address is already registered: that turns
        // this endpoint into an account-enumeration oracle.
        throw new HttpError(409, "registration_failed", "this registration could not be completed");
      }
      await store.credentials.put({ userId: created.id, passwordHash, failedAttempts: 0 });

      return { status: 201, body: { user: publicUser(created) } };
    },
    authLimit,
  );

  router.post(
    "/v1/auth/login",
    async (ctx) => {
      const email = field(ctx, "email", isString);
      const password = field(ctx, "password", isString);

      const user = await store.users.byEmail(email);
      const credentials = user ? await store.credentials.byUserId(user.id) : undefined;

      if (!user || !credentials) {
        // Spend comparable time on a miss so the response time does not reveal
        // whether the address exists.
        await verifyPassword(password, "scrypt$131072$8$1$AAAA$AAAA");
        throw new HttpError(401, "invalid_credentials", "email or password is incorrect");
      }
      if (credentials.lockedUntil && new Date(credentials.lockedUntil) > new Date()) {
        throw new HttpError(423, "account_locked", "too many failed attempts; try again shortly");
      }
      if (user.suspendedAt) {
        throw new HttpError(403, "account_suspended", "this account is suspended");
      }

      if (!(await verifyPassword(password, credentials.passwordHash))) {
        credentials.failedAttempts += 1;
        if (credentials.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          credentials.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
          credentials.failedAttempts = 0;
        }
        await store.credentials.put(credentials);
        throw new HttpError(401, "invalid_credentials", "email or password is incorrect");
      }

      credentials.failedAttempts = 0;
      delete credentials.lockedUntil;
      await store.credentials.put(credentials);

      // MFA is not satisfied by logging in. A user with MFA enabled gets a
      // session that can read, and must step up before touching money.
      const sid = newSessionId();
      return {
        status: 200,
        body: {
          ...tokenPair(user, sid, false, config.tokenSecret),
          mfaRequired: user.mfaEnabled,
          user: publicUser(user),
        },
      };
    },
    authLimit,
  );

  router.post(
    "/v1/auth/refresh",
    async (ctx) => {
      const token = field(ctx, "refreshToken", isString);
      let claims;
      try {
        claims = verifyToken(token, config.tokenSecret);
      } catch (error) {
        throw new HttpError(401, "invalid_token", error instanceof TokenError ? error.message : "invalid token");
      }
      if (claims.typ !== "refresh") {
        throw new HttpError(401, "invalid_token", "that is not a refresh token");
      }
      const user = await store.users.byId(claims.sub);
      if (!user || user.suspendedAt) throw new HttpError(401, "invalid_token", "this session is no longer valid");

      return { status: 200, body: tokenPair(user, claims.sid, claims.mfa, config.tokenSecret) };
    },
    authLimit,
  );

  /** Send a phone OTP. The code is never returned outside local development. */
  router.post(
    "/v1/auth/otp/send",
    async (ctx) => {
      const userId = ctx.auth?.sub as string;
      const user = await store.users.byId(userId);
      if (!user?.phone) throw new HttpError(400, "no_phone", "add a phone number before requesting a code");

      const code = generateOtp();
      const credentials = await store.credentials.byUserId(userId);
      if (!credentials) throw new HttpError(404, "not_found", "no credentials on file");
      credentials.otpHash = hashOtp(code, userId);
      credentials.otpExpiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
      await store.credentials.put(credentials);

      return {
        status: 202,
        body: {
          sentTo: maskPhone(user.phone),
          expiresInMinutes: OTP_TTL_MINUTES,
          ...(config.exposeDevSecrets ? { devCode: code } : {}),
        },
      };
    },
    requireAuth,
    otpLimit,
  );

  router.post(
    "/v1/auth/otp/verify",
    async (ctx) => {
      const code = field(ctx, "code", isString);
      const userId = ctx.auth?.sub as string;
      const credentials = await store.credentials.byUserId(userId);
      if (!credentials?.otpHash || !credentials.otpExpiresAt) {
        throw new HttpError(400, "no_pending_code", "request a code first");
      }
      if (new Date(credentials.otpExpiresAt) < new Date()) {
        throw new HttpError(400, "code_expired", "that code has expired; request another");
      }
      const expected = Buffer.from(credentials.otpHash);
      const actual = Buffer.from(hashOtp(code, userId));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new HttpError(400, "code_incorrect", "that code is not correct");
      }

      // One code, one use.
      delete credentials.otpHash;
      delete credentials.otpExpiresAt;
      await store.credentials.put(credentials);

      const user = await store.users.byId(userId);
      if (!user) throw new HttpError(404, "not_found", "user not found");
      const updated =
        user.verification === "unverified"
          ? await store.users.update(userId, { verification: "phone_verified" })
          : user;
      await bus.publish(TOPICS.userVerified, userId, { userId, level: updated.verification }, ctx.traceId);

      // Clearing an OTP challenge is what promotes a session to MFA-verified.
      const sid = ctx.auth?.sid ?? newSessionId();
      return {
        status: 200,
        body: { ...tokenPair(updated, sid, true, config.tokenSecret), user: publicUser(updated) },
      };
    },
    requireAuth,
    otpLimit,
  );

  router.post(
    "/v1/auth/mfa/enable",
    async (ctx) => {
      const userId = ctx.auth?.sub as string;
      const updated = await store.users.update(userId, { mfaEnabled: true });
      return { status: 200, body: { user: publicUser(updated) } };
    },
    requireAuth,
    authLimit,
  );

  router.get(
    "/v1/me",
    async (ctx) => {
      const user = await store.users.byId(ctx.auth?.sub as string);
      if (!user) throw new HttpError(404, "not_found", "user not found");
      return { status: 200, body: { user: publicUser(user), session: { mfa: ctx.auth?.mfa ?? false } } };
    },
    requireAuth,
  );
}

function tokenPair(user: BaseUser, sid: string, mfa: boolean, secret: string) {
  const base = { sub: user.id, roles: user.roles, mfa, sid };
  return {
    accessToken: issueToken({ ...base, typ: "access" }, secret, ACCESS_TTL_SECONDS),
    refreshToken: issueToken({ ...base, typ: "refresh" }, secret, REFRESH_TTL_SECONDS),
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

/** The projection safe to return over the wire. */
export function publicUser(user: BaseUser) {
  return {
    id: user.id,
    displayName: user.displayName,
    roles: user.roles,
    verification: user.verification,
    mfaEnabled: user.mfaEnabled,
    metroId: user.metroId,
    languages: user.languages,
    createdAt: user.createdAt,
  };
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 2)}*******${phone.slice(-2)}`;
}
