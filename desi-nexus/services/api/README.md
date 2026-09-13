# DESI-NEXUS API

The marketplace backend. TypeScript on Node 20+, no runtime dependencies.

```bash
npm install
npm test     # typecheck + 113 tests
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
  rateLimit.ts  token buckets (move to Redis before the pilot)
  stripe.ts     the payment boundary + webhook signature verification
  store.ts      repository interfaces + in-memory implementations

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

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (8080) | Listen port |
| `DESI_NEXUS_TOKEN_SECRET` | in production | Token signing key |
| `DESI_NEXUS_WEBHOOK_SECRET` | in production | Stripe webhook signing secret |
| `NODE_ENV` | no | `production` disables dev OTP echo and enforces the above |

TLS terminates at the load balancer. This process listens on plain HTTP inside
the mesh and must never be exposed directly.
