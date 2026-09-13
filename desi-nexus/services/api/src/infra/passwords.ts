/**
 * Password hashing with scrypt. Parameters are the current OWASP guidance for
 * scrypt (N=2^17, r=8, p=1); they are stored alongside the hash so that raising
 * them later does not invalidate existing credentials.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const derived = await scrypt(password, Buffer.from(salt, "base64"), KEY_LENGTH, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  const expectedBuffer = Buffer.from(expected, "base64");
  if (expectedBuffer.length !== derived.length) return false;
  return timingSafeEqual(expectedBuffer, derived);
}

export class PasswordPolicyError extends Error {}

/**
 * Length over composition rules. A 12-character passphrase beats an
 * eight-character one with a shouty punctuation requirement, and the latter
 * only teaches people to append "!1".
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < 12) {
    throw new PasswordPolicyError("password must be at least 12 characters");
  }
  if (password.length > 200) {
    throw new PasswordPolicyError("password must be at most 200 characters");
  }
  const common = ["password", "12345678", "qwerty", "desinexus", "letmein"];
  const lowered = password.toLowerCase();
  if (common.some((candidate) => lowered.includes(candidate))) {
    throw new PasswordPolicyError("password contains a commonly guessed sequence");
  }
}
