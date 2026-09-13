# DESI-NEXUS API

The marketplace backend. TypeScript on Node 20+, with `pg`, `stripe` and
`ioredis` as its only runtime dependencies.

```bash
npm install
npm test     # typecheck + 170 tests (128 without Postgres and Redis)
npm start    # :8080
```

## Layout

```
src/domain/     pure business logic, no I/O — the part worth testing hardest
  taxonomy.ts   Desi event types, crew specialities, cultural tags and affinity
  money.ts      integer-cent arithmetic, fee splits, refund splitting
  geo.ts        Texas metros, geofencing, round-trip travel pricing
  gig.ts        the lifecycle state machine and its guards
  matching.ts   candidate scoring and notification wave planning
  escrow.ts     the append-only ledger and its invariants
  users.ts      the polymorphic profile model

src/infra/      adapters — each one swappable without touching the domain
  tokens.ts     HS256 issue/verify, algorithm pinned
  passwords.ts  scrypt at OWASP parameters
  rateLimit.ts      the limiter contract and the in-process implementation
  redisRateLimit.ts shared buckets, refilled and spent in one Lua script
  stripe/       the payment boundary, the live gateway and the fake
  store.ts      repository interfaces + in-memory implementations
  postgres/     PostgreSQL implementations of those same interfaces

src/http/       router, middleware, routes
src/events/     domain event bus (outbox-shaped)
```

The dependency rule is one-directional: `http` may use `domain` and `infra`;
`domain` uses nothing but itself. That is what lets the domain tests run without
a server, a database or a network.

## Why no framework

The whole request path — router, middleware chain, body reading, error boundary
— is about 150 lines and can be read end to end during a security review. On a
service that moves money that is worth more than a middleware ecosystem. The
same reasoning applies to the hand-rolled HS256 in `tokens.ts`: it is auditable
in one screen, has no dependency to patch, and pins the algorithm so the token
confusion attacks are unreachable.

`pg`, `stripe` and `ioredis` are the exceptions, and deliberately so. A
PostgreSQL wire-protocol client is not something to hand-roll, and neither is a
payments integration: the official SDK tracks API-version drift, retries safely
against idempotency keys, and its types follow the API. Each sits behind one
file, so the domain and the routes never import any of them.

## Testing against a database

`test/db.ts` gives each database-backed test file its own PostgreSQL schema.
Node's test runner runs files in parallel, and a shared schema means one file's
`TRUNCATE` wipes another's fixtures mid-test — a failure that only appears in
the full run and passes when the file is re-run alone, which is the worst kind
to debug.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (8080) | Listen port |
| `DESI_NEXUS_TOKEN_SECRET` | in production | Token signing key |
| `DESI_NEXUS_WEBHOOK_SECRET` | in production | Stripe webhook signing secret |
| `REDIS_URL` | in production | Selects the shared rate limiter; the in-process one is used when unset |
| `STRIPE_API_KEY` | in production | Selects the live payment gateway; the fake is used when unset |
| `STRIPE_CONNECT_RETURN_URL` | no | Where Stripe returns a vendor after Express onboarding |
| `STRIPE_CONNECT_REFRESH_URL` | no | Where Stripe sends them if the onboarding link expired |
| `NODE_ENV` | no | `production` disables dev OTP echo and enforces the above |
| `DESI_NEXUS_TEST_DATABASE_URL` | tests only | Points the database-backed tests at a PostgreSQL with PostGIS; they skip when unset |
| `DESI_NEXUS_TEST_REDIS_URL` | tests only | Points the rate-limiter tests at a Redis; they skip when unset |

TLS terminates at the load balancer. This process listens on plain HTTP inside
the mesh and must never be exposed directly.
