import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  ACCESS_TTL_SECONDS,
  generateOtp,
  issueToken,
  verifyToken,
  TokenError,
} from "../src/infra/tokens.js";
import { assertPasswordPolicy, hashPassword, verifyPassword, PasswordPolicyError } from "../src/infra/passwords.js";
import { InMemoryRateLimiter } from "../src/infra/rateLimit.js";
import { verifyWebhookSignature, WEBHOOK_TOLERANCE_SECONDS } from "../src/infra/stripe/index.js";
import { canReceivePayouts, meetsVerification, type BaseUser } from "../src/domain/users.js";

const SECRET = "a-test-signing-secret-that-is-long-enough";
const claims = { sub: "usr_1", roles: ["crew"], mfa: true, typ: "access" as const, sid: "sess_1" };

test("a token round-trips its claims", () => {
  const token = issueToken(claims, SECRET);
  const decoded = verifyToken(token, SECRET);
  assert.equal(decoded.sub, "usr_1");
  assert.equal(decoded.mfa, true);
  assert.equal(decoded.exp - decoded.iat, ACCESS_TTL_SECONDS);
});

test("a token signed with another key is rejected", () => {
  const token = issueToken(claims, SECRET);
  assert.throws(() => verifyToken(token, "a-different-secret-entirely"), TokenError);
});

test("a tampered payload is rejected", () => {
  const token = issueToken(claims, SECRET);
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, roles: ["admin"], iat: 1, exp: 9e9 })).toString("base64url");
  assert.throws(() => verifyToken(`${header}.${forged}.${signature}`, SECRET), TokenError);
});

test("the alg:none confusion attack does not work, because the algorithm is pinned", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ ...claims, roles: ["admin"], iat: 1, exp: 9_999_999_999 }),
  ).toString("base64url");
  assert.throws(() => verifyToken(`${header}.${payload}.`, SECRET), /unsupported token algorithm/);
});

test("an expired token is rejected", () => {
  const issuedAt = new Date("2026-01-01T00:00:00Z");
  const token = issueToken(claims, SECRET, 60, issuedAt);
  assert.throws(() => verifyToken(token, SECRET, new Date("2026-01-01T00:02:00Z")), /expired/);
  assert.doesNotThrow(() => verifyToken(token, SECRET, new Date("2026-01-01T00:00:30Z")));
});

test("malformed tokens are rejected rather than throwing something unhelpful", () => {
  for (const bad of ["", "a.b", "not-a-token", "a.b.c.d"]) {
    assert.throws(() => verifyToken(bad, SECRET), TokenError, `accepted "${bad}"`);
  }
});

test("OTP codes are six uniform digits", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const code = generateOtp();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 350, "OTP codes should not collide this often");
});

test("passwords hash and verify, and a wrong one fails", async () => {
  const hash = await hashPassword("a-perfectly-fine-passphrase");
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(await verifyPassword("a-perfectly-fine-passphrase", hash), true);
  assert.equal(await verifyPassword("a-perfectly-fine-passphraze", hash), false);
});

test("a stored hash never contains the password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.ok(!hash.includes("correct"));
});

test("short and obvious passwords are refused", () => {
  assert.throws(() => assertPasswordPolicy("short"), PasswordPolicyError);
  assert.throws(() => assertPasswordPolicy("mypassword123"), PasswordPolicyError);
  assert.throws(() => assertPasswordPolicy("desinexus2026!"), PasswordPolicyError);
  assert.doesNotThrow(() => assertPasswordPolicy("sangeet-night-in-frisco"));
});

test("the rate limiter drains, refuses, then refills", async () => {
  let now = 0;
  const limiter = new InMemoryRateLimiter(() => now);

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await limiter.check("usr_1", "otp")).allowed, true, `request ${i} should pass`);
  }
  const blocked = await limiter.check("usr_1", "otp");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);

  // An hour later the bucket has refilled.
  now += 3_600_000;
  assert.equal((await limiter.check("usr_1", "otp")).allowed, true);
});

test("one identity's limit does not affect another's", async () => {
  const limiter = new InMemoryRateLimiter(() => 0);
  for (let i = 0; i < 10; i += 1) await limiter.check("noisy", "auth");
  assert.equal((await limiter.check("noisy", "auth")).allowed, false);
  assert.equal((await limiter.check("quiet", "auth")).allowed, true);
});

test("the discovery bucket is the one that stops a portfolio scraper", async () => {
  const limiter = new InMemoryRateLimiter(() => 0);
  let allowed = 0;
  for (let i = 0; i < 500; i += 1) {
    if ((await limiter.check("scraper", "discovery")).allowed) allowed += 1;
  }
  assert.equal(allowed, 120, "a burst should be capped at the bucket capacity");
});

function signWebhook(body: string, secret: string, timestamp: number): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("a genuine webhook signature verifies", () => {
  const body = JSON.stringify({ type: "payment_intent.succeeded" });
  const now = new Date("2026-03-01T12:00:00Z");
  const header = signWebhook(body, "whsec_test", Math.floor(now.getTime() / 1000));
  assert.equal(verifyWebhookSignature(body, header, "whsec_test", now), true);
});

test("a forged or altered webhook is rejected", () => {
  const body = JSON.stringify({ type: "payment_intent.succeeded", amount: 100 });
  const now = new Date("2026-03-01T12:00:00Z");
  const header = signWebhook(body, "whsec_test", Math.floor(now.getTime() / 1000));

  assert.equal(verifyWebhookSignature(body, header, "whsec_wrong", now), false);
  const tampered = JSON.stringify({ type: "payment_intent.succeeded", amount: 1_000_000 });
  assert.equal(verifyWebhookSignature(tampered, header, "whsec_test", now), false);
  assert.equal(verifyWebhookSignature(body, "garbage", "whsec_test", now), false);
});

test("a replayed old webhook is rejected once it falls outside the tolerance", () => {
  const body = "{}";
  const signedAt = new Date("2026-03-01T12:00:00Z");
  const header = signWebhook(body, "whsec_test", Math.floor(signedAt.getTime() / 1000));
  const later = new Date(signedAt.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000);
  assert.equal(verifyWebhookSignature(body, header, "whsec_test", later), false);
});

function user(overrides: Partial<BaseUser> = {}): BaseUser {
  return {
    id: "usr_1",
    email: "a@example.com",
    displayName: "A",
    roles: ["crew"],
    verification: "id_verified",
    mfaEnabled: true,
    homeBase: { lat: 33.15, lng: -96.82 },
    metroId: "dfw",
    languages: ["english"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("payouts require ID verification, MFA and a connected account, with no override", () => {
  assert.equal(canReceivePayouts(user(), "acct_1").ok, true);
  assert.equal(canReceivePayouts(user({ mfaEnabled: false }), "acct_1").ok, false);
  assert.equal(canReceivePayouts(user({ verification: "phone_verified" }), "acct_1").ok, false);
  assert.equal(canReceivePayouts(user(), undefined).ok, false);
  assert.equal(canReceivePayouts(user({ suspendedAt: new Date().toISOString() }), "acct_1").ok, false);
});

test("verification levels are ordered", () => {
  assert.equal(meetsVerification("business_verified", "id_verified"), true);
  assert.equal(meetsVerification("phone_verified", "id_verified"), false);
});
