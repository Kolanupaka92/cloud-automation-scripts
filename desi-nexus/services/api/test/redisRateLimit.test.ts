/**
 * The shared rate limiter, against a real Redis.
 *
 * These skip when DESI_NEXUS_TEST_REDIS_URL is unset. There is no fake Redis
 * here for the same reason there is no fake Postgres: what is being tested is
 * whether the Lua actually runs atomically, and an in-process imitation would
 * answer a different question.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { RedisRateLimiter } from "../src/infra/redisRateLimit.js";
import { InMemoryRateLimiter, POLICIES } from "../src/infra/rateLimit.js";

const REDIS_URL = process.env.DESI_NEXUS_TEST_REDIS_URL;
const skip = REDIS_URL ? false : "set DESI_NEXUS_TEST_REDIS_URL to run the Redis tests";

let redis: Redis;
/** Connections opened per test, closed afterwards, so nothing leaks. */
let extras: Redis[] = [];

before(async () => {
  if (skip) return;
  redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  await redis.ping();
});

after(async () => {
  if (redis) await redis.quit();
});

beforeEach(async () => {
  if (skip) return;
  for (const client of extras) await client.quit().catch(() => undefined);
  extras = [];
  // Each test starts from an empty keyspace; the limiter owns this database.
  await redis.flushdb();
});

function another(): Redis {
  const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  extras.push(client);
  return client;
}

test("a bucket drains to its capacity and then refuses", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  const capacity = POLICIES.otp.capacity;

  for (let i = 0; i < capacity; i += 1) {
    const decision = await limiter.check("usr_1", "otp");
    assert.equal(decision.allowed, true, `request ${i + 1} should pass`);
  }

  const blocked = await limiter.check("usr_1", "otp");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfter > 0, "a refusal must say when to come back");
});

test("remaining counts down as tokens are spent", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  const first = await limiter.check("usr_1", "otp");
  const second = await limiter.check("usr_1", "otp");
  assert.equal(first.remaining, POLICIES.otp.capacity - 1);
  assert.equal(second.remaining, POLICIES.otp.capacity - 2);
});

/**
 * The reason this module exists. Two limiter instances on separate connections
 * stand in for two pods behind a load balancer.
 */
test("two pods share one budget", { skip }, async () => {
  const podA = new RedisRateLimiter(redis);
  const podB = new RedisRateLimiter(another());
  const capacity = POLICIES.otp.capacity;

  let allowed = 0;
  for (let i = 0; i < capacity * 2; i += 1) {
    const pod = i % 2 === 0 ? podA : podB;
    if ((await pod.check("usr_shared", "otp")).allowed) allowed += 1;
  }

  assert.equal(allowed, capacity, "the limit must not scale with the replica count");
});

test("the in-process limiter is the thing this replaces", { skip }, async () => {
  // Two in-process limiters are two pods that do not talk to each other, and
  // between them they allow twice the configured budget. This test documents
  // the hole rather than asserting a desired behaviour.
  const podA = new InMemoryRateLimiter(() => 0);
  const podB = new InMemoryRateLimiter(() => 0);
  const capacity = POLICIES.otp.capacity;

  let allowed = 0;
  for (let i = 0; i < capacity * 2; i += 1) {
    const pod = i % 2 === 0 ? podA : podB;
    if ((await pod.check("usr_shared", "otp")).allowed) allowed += 1;
  }

  assert.equal(allowed, capacity * 2, "per-process buckets double the effective limit");
});

/**
 * Concurrency is the whole point of doing this in Lua. Fired in parallel, a
 * non-atomic refill-then-spend lets several requests read the same token count
 * and each spend it.
 */
test("concurrent requests cannot overspend a bucket", { skip }, async () => {
  const pods = [new RedisRateLimiter(redis), new RedisRateLimiter(another()), new RedisRateLimiter(another())];
  const capacity = POLICIES.otp.capacity;

  const attempts = Array.from({ length: capacity * 6 }, (_, i) =>
    (pods[i % pods.length] as RedisRateLimiter).check("usr_race", "otp"),
  );
  const decisions = await Promise.all(attempts);
  const allowed = decisions.filter((decision) => decision.allowed).length;

  assert.equal(allowed, capacity, `expected exactly ${capacity} to pass, got ${allowed}`);
});

test("a bucket refills as time passes", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  const capacity = POLICIES.otp.capacity;
  for (let i = 0; i < capacity; i += 1) await limiter.check("usr_refill", "otp");
  assert.equal((await limiter.check("usr_refill", "otp")).allowed, false);

  // Wind the bucket's own timestamp back rather than sleeping for an hour. The
  // script reads elapsed time from this field, so this is the same arithmetic
  // a real wait would produce.
  const key = "rl:otp:usr_refill";
  const stamped = Number(await redis.hget(key, "ts"));
  await redis.hset(key, "ts", stamped - 3_600);

  assert.equal((await limiter.check("usr_refill", "otp")).allowed, true, "an hour should refill the bucket");
});

test("a bucket never refills past its capacity", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  await limiter.check("usr_cap", "otp");

  const key = "rl:otp:usr_cap";
  const stamped = Number(await redis.hget(key, "ts"));
  // A year of idleness must not mint a year's worth of tokens.
  await redis.hset(key, "ts", stamped - 31_536_000);

  const decision = await limiter.check("usr_cap", "otp");
  assert.equal(decision.remaining, POLICIES.otp.capacity - 1);
});

test("a clock that moved backwards does not mint tokens", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  const capacity = POLICIES.otp.capacity;
  for (let i = 0; i < capacity; i += 1) await limiter.check("usr_skew", "otp");

  // Stamp the bucket in the future, as a pod with a fast clock once could.
  await redis.hset("rl:otp:usr_skew", "ts", Number(await redis.hget("rl:otp:usr_skew", "ts")) + 3_600);

  assert.equal((await limiter.check("usr_skew", "otp")).allowed, false, "negative elapsed time must not refill");
});

test("identities and policies are isolated from one another", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  for (let i = 0; i < POLICIES.otp.capacity; i += 1) await limiter.check("noisy", "otp");

  assert.equal((await limiter.check("noisy", "otp")).allowed, false);
  assert.equal((await limiter.check("quiet", "otp")).allowed, true, "another identity must be unaffected");
  assert.equal((await limiter.check("noisy", "auth")).allowed, true, "another policy must be unaffected");
});

test("idle buckets expire instead of growing the keyspace forever", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  await limiter.check("usr_ttl", "otp");

  const ttl = await redis.pttl("rl:otp:usr_ttl");
  assert.ok(ttl > 0, "a bucket with no expiry would leak a key per identity");
  // The TTL is the time a drained bucket needs to refill completely.
  const expected = (POLICIES.otp.capacity / POLICIES.otp.refillPerSecond) * 1000;
  assert.ok(ttl <= expected + 1_000, `ttl ${ttl} should be about ${expected}`);
});

test("the discovery bucket still caps a scraper's burst", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  const decisions = await Promise.all(
    Array.from({ length: 400 }, () => limiter.check("scraper", "discovery")),
  );
  const allowed = decisions.filter((d) => d.allowed).length;
  assert.equal(allowed, POLICIES.discovery.capacity);
});

test("a flushed script cache is recovered from, not fatal", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis);
  // Prime the cache so the limiter is using EVALSHA.
  assert.equal((await limiter.check("usr_script", "auth")).allowed, true);

  // A failover or an operator's SCRIPT FLUSH empties it underneath us.
  await redis.script("FLUSH");

  const after = await limiter.check("usr_script", "auth");
  assert.equal(after.allowed, true, "the limiter must re-send the script rather than fail the request");
  assert.equal(after.remaining, POLICIES.auth.capacity - 2, "and must not lose the bucket's state");
});

test("an unreachable Redis fails open by default", { skip }, async () => {
  const broken = new Redis("redis://127.0.0.1:6301", {
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  broken.on("error", () => undefined);
  extras.push(broken);

  const limiter = new RedisRateLimiter(broken);
  const decision = await limiter.check("usr_1", "otp");
  assert.equal(decision.allowed, true, "an outage must degrade limiting, not block every login");
});

test("failing closed is available for deployments that prefer it", { skip }, async () => {
  const broken = new Redis("redis://127.0.0.1:6301", {
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  broken.on("error", () => undefined);
  extras.push(broken);

  const limiter = new RedisRateLimiter(broken, { onError: "closed" });
  const decision = await limiter.check("usr_1", "otp");
  assert.equal(decision.allowed, false);
  assert.ok(decision.retryAfter > 0);
});

test("a key prefix keeps the limiter out of another tenant's way", { skip }, async () => {
  const limiter = new RedisRateLimiter(redis, { keyPrefix: "desi" });
  await limiter.check("usr_1", "otp");
  assert.equal(await redis.exists("desi:otp:usr_1"), 1);
  assert.equal(await redis.exists("rl:otp:usr_1"), 0);
});
