/**
 * Token issuing and verification.
 *
 * Deliberately a compact HMAC (HS256) implementation over node:crypto rather
 * than a JWT library: it is auditable in one screen, has no dependency to
 * patch, and pins the algorithm so the `alg: none` and RS-to-HS confusion
 * families cannot be reached at all. When the IdP moves to OIDC with rotating
 * JWKS, this becomes the verifier for an upstream-issued token and the issuing
 * half goes away.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  /** Subject: the user id. */
  sub: string;
  roles: string[];
  /** Whether this session cleared MFA. Payout surfaces demand it. */
  mfa: boolean;
  /** "access" or "refresh"; a refresh token must never open a resource. */
  typ: "access" | "refresh";
  /** Session id, so a single device can be revoked. */
  sid: string;
  iat: number;
  exp: number;
}

export class TokenError extends Error {}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export function issueToken(
  claims: Omit<TokenClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds: number = ACCESS_TTL_SECONDS,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const body: TokenClaims = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(body));
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

export function verifyToken(token: string, secret: string, now: Date = new Date()): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [header, payload, signature] = parts as [string, string, string];

  let decodedHeader: { alg?: string };
  try {
    decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed token header");
  }
  // Pinned, not read from the token. This is the whole point.
  if (decodedHeader.alg !== "HS256") throw new TokenError("unsupported token algorithm");

  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenError("bad token signature");
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed token payload");
  }
  if (Math.floor(now.getTime() / 1000) >= claims.exp) throw new TokenError("token has expired");
  return claims;
}

/** Opaque, single-use OTP for phone verification. Six digits, uniform. */
export function generateOtp(): string {
  // rejection-sampled so the modulo does not bias the low digits
  for (;;) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < 4_294_000_000) return String(value % 1_000_000).padStart(6, "0");
  }
}

export function newSessionId(): string {
  return `sess_${randomBytes(16).toString("hex")}`;
}
