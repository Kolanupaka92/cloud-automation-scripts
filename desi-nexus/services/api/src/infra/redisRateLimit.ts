/**
 * The shared token-bucket limiter.
 *
 * This exists because the in-process limiter is not a limit once there is more
 * than one replica: each pod keeps its own buckets, so an attacker's effective
 * allowance is the configured one multiplied by the replica count. Moving the
 * buckets into Redis makes the limit mean what it says however many pods are
 * running.
 *
 * Two details carry the correctness:
 *
 * 1. **The whole read-modify-write is one Lua script.** Refilling a bucket and
 *    spending from it is a read, a computation and a write; done as separate
 *    round trips, two concurrent requests both read the same token count and
 *    both spend it. Redis runs a script to completion without interleaving, so
 *    the decision is atomic.
 *
 * 2. **Time comes from Redis, not from the caller.** Pods drift, and a bucket
 *    stamped by a pod whose clock runs fast would refuse traffic on every other
 *    pod until real time caught up. `TIME` inside the script is one clock for
 *    every caller.
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { POLICIES, type PolicyName, type RateDecision, type RateLimiter } from "./rateLimit.js";

/**
 * Refill and spend, atomically.
 *
 * Returns {allowed, remaining, retryAfterSeconds}. Tokens are kept as a float
 * so a slow refill rate -- five OTP sends an hour is one token per 720 seconds
 * -- accumulates properly instead of rounding to zero on every call.
 */
const TOKEN_BUCKET = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

-- One authoritative clock for every pod. TIME returns {seconds, microseconds}.
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + (tonumber(clock[2]) / 1000000)

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

-- A clock that went backwards must not mint tokens.
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end

tokens = math.min(capacity, tokens + (elapsed * refill))

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire idle buckets so the keyspace does not grow without bound. The TTL is
-- the time a bucket needs to refill completely, after which it is
-- indistinguishable from a fresh one.
redis.call('PEXPIRE', key, ttl)

local retry = 0
if allowed == 0 then
  retry = math.ceil((cost - tokens) / refill)
end

return { allowed, math.floor(tokens), retry }
`;

/** SHA1 of TOKEN_BUCKET, which is how Redis addresses a cached script. */
const SCRIPT_SHA = createHash("sha1").update(TOKEN_BUCKET).digest("hex");

export interface RedisRateLimiterOptions {
  /** Prefix for every key, so the limiter can share a Redis with other users. */
  readonly keyPrefix?: string;
  /**
   * What to do when Redis is unreachable. "open" serves the request, "closed"
   * refuses it. See the note on `failOpen` below before changing it.
   */
  readonly onError?: "open" | "closed";
}

export class RedisRateLimiter implements RateLimiter {
  private readonly prefix: string;
  private readonly failOpen: boolean;
  private scriptLoaded = false;

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimiterOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? "rl";
    // Fail open by default: a Redis outage should degrade rate limiting, not
    // take the whole marketplace down. The edge WAF still carries the coarse
    // limits, so this is a reduction in protection rather than its removal --
    // and an outage that blocks every login is a worse incident than one that
    // briefly lets a scraper run faster.
    this.failOpen = (options.onError ?? "open") === "open";
  }

  async check(identity: string, policyName: PolicyName = "default", cost = 1): Promise<RateDecision> {
    const policy = POLICIES[policyName];
    const key = `${this.prefix}:${policyName}:${identity}`;
    // How long a fully drained bucket takes to refill; idle keys expire after
    // that, because by then they are identical to a bucket that never existed.
    const ttlMs = Math.ceil((policy.capacity / policy.refillPerSecond) * 1000) + 1_000;

    try {
      const raw = (await this.evalScript(key, [
        policy.capacity,
        policy.refillPerSecond,
        cost,
        ttlMs,
      ])) as [number, number, number];

      return {
        allowed: raw[0] === 1,
        remaining: raw[1],
        retryAfter: raw[2],
      };
    } catch (error) {
      console.error(`[ratelimit] redis check failed for ${policyName}`, error);
      if (!this.failOpen) {
        return { allowed: false, remaining: 0, retryAfter: 1 };
      }
      return { allowed: true, remaining: policy.capacity, retryAfter: 0 };
    }
  }

  /**
   * Run the script by SHA, shipping the source only when Redis has not seen it.
   * Sending several kilobytes of Lua on every request would make the limiter
   * more expensive than the endpoint it protects.
   */
  private async evalScript(key: string, args: readonly number[]): Promise<unknown> {
    if (this.scriptLoaded) {
      try {
        return await this.redis.evalsha(SCRIPT_SHA, 1, key, ...args.map(String));
      } catch (error) {
        // A failover or a SCRIPT FLUSH empties the cache; fall through and
        // re-send the source rather than failing the request.
        if (!isNoScriptError(error)) throw error;
        this.scriptLoaded = false;
      }
    }
    const result = await this.redis.eval(TOKEN_BUCKET, 1, key, ...args.map(String));
    this.scriptLoaded = true;
    return result;
  }
}

function isNoScriptError(error: unknown): boolean {
  return /NOSCRIPT/.test(String((error as Error)?.message ?? error));
}

export { TOKEN_BUCKET, SCRIPT_SHA };
