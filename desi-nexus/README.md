# DESI-NEXUS

A marketplace connecting Texas South Asian event hosts — boutiques, agencies and
families — with the crew and creators who work their events: MUAs,
photographers, henna artists, pandits, decorators, models and influencers.

The premise is that these are not separate markets. A boutique in Frisco books
the same makeup artist for a lookbook shoot that a family books for a Half-Saree
Function. One supply pool, two demand curves — which is the only way a
hyper-local marketplace reaches liquidity in a single metro.

## What is in this repository

| Path | What it is |
|---|---|
| `apps/web/` | The host and vendor web app (Next.js 15, App Router) |
| `services/api/src/domain/` | The domain core: taxonomy, money, geography, gig state machine, matching, escrow |
| `services/api/src/infra/` | Tokens, password hashing, rate limiting, the Stripe boundary, repositories |
| `services/api/src/http/` | Router, middleware and route modules |
| `services/api/src/infra/postgres/` | PostgreSQL repository implementations |
| `services/api/src/infra/stripe/` | Payment contract, the live gateway, and the fake |
| `services/api/src/infra/redisRateLimit.ts` | Shared token buckets, refilled and spent atomically |
| `services/api/test/` | 176 tests, including the full booking flow run over both stores |
| `db/migrations/` | PostgreSQL schema, seeded reference data, application role |
| `docs/` | Architecture, security posture, API specification, roadmap |

The domain core, the security layer, the HTTP surface, PostgreSQL persistence
the Stripe integration, shared rate limiting and the web app are real and
runnable. Persistence sits behind
repository interfaces with both an in-memory and a PostgreSQL implementation,
and the same end-to-end booking test runs against each — so the swap is proven
transparent rather than assumed. Payments sit behind the same kind of interface,
with a live gateway on the official Stripe SDK and a fake for tests and local
runs. See `docs/roadmap.md` for an honest built-versus-specified breakdown.

## Running it

```bash
cd services/api
npm install
npm test          # typechecks, then runs the suite
npm run build && npm start
```

The service starts on `:8080` with in-memory persistence and the fake payment
gateway, so the whole booking flow works locally with no external dependencies.

To also run the database-backed tests, point them at a PostgreSQL with PostGIS:

```bash
export DESI_NEXUS_TEST_DATABASE_URL=postgresql://user@localhost:5432/desi_nexus_test
npm test          # 176 tests instead of 128
```

The rate limiter's tests want a Redis:

```bash
export DESI_NEXUS_TEST_REDIS_URL=redis://localhost:6379/9
```

Without those variables the 42 service-backed tests skip and the rest still run.
CI sets both and fails the build if anything skips, because a skipped suite
still reports success and would quietly stop covering those layers.

Payments use the fake gateway unless `STRIPE_API_KEY` is set. Production refuses
to start without one, so there is no configuration in which the service quietly
accepts bookings that move no money.

```bash
curl -s localhost:8080/healthz
curl -s localhost:8080/v1/taxonomy | head -c 400
```

In development, OTP codes are returned in the response as `devCode` so you can
complete the flow without an SMS provider. Setting `NODE_ENV=production`
disables that and refuses to start without `DESI_NEXUS_TOKEN_SECRET` and
`DESI_NEXUS_WEBHOOK_SECRET`.

## Applying the schema

```bash
createdb desi_nexus
psql -d desi_nexus -f db/migrations/001_init.sql
psql -d desi_nexus -f db/migrations/002_seed_reference_data.sql
```

```bash
psql -d desi_nexus -f db/migrations/003_app_role.sql   # as the schema owner
```

Requires PostgreSQL 15+ with PostGIS. The schema is exercised by the test suite
on every run: its check constraints, unique indexes, append-only triggers and
privilege grants are each confirmed to reject the writes they exist to prevent.

`003_app_role.sql` creates the role the service connects as. Use it — row-level
security is bypassed by the table owner, so an application connecting as the
owner is protected by none of the policies in `001_init.sql`.

## The decisions worth knowing about

**Money is integer cents, everywhere.** A half-cent of drift in a fee split
becomes a ledger that does not balance. Two identities are asserted in the code,
in the tests, and again as database check constraints:
`hostTotal == vendorPayout + platformRevenue` and
`hostTotal == depositDue + balanceDue`.

**The ledger is append-only.** Balances are folded from entries rather than
stored, so a partial failure mid-release is replayable. `UPDATE` and `DELETE`
are rejected by a database trigger; a correction is a compensating entry.

**No card data touches this service.** The client confirms payment directly
against Stripe; only the signature-verified webhook may assert that a payment
succeeded. A client that can report its own payment succeeded can report one
that did not happen.

**MFA is a property of the session, not the account.** Logging in does not
satisfy it. An attacker with a stolen password gets a read-only session.

**The gig lifecycle is a guarded transition table**, not conditionals in route
handlers, because money moves on some of those edges.

**Cultural fit is the heaviest match weight (0.30).** A MUA who does South
Indian bridal is not interchangeable with one who does Punjabi Sikh bridal, and
booking the wrong one is the most common way a function is ruined. Adjacent
styles earn partial credit rather than being dropped.

**Travel is billed round trip and never commissioned.** Texas is large enough
that mileage is a real cost; charging commission on it pushes vendors to quote
travel off-platform, which is the leakage the escrow exists to prevent.

## Testing

```bash
cd services/api && npm test
```

176 tests. Beyond the unit coverage, the suite asserts the things that would
actually hurt: that a booking cannot be confirmed before its deposit clears,
that a replayed Stripe webhook cannot double-fund, that a released escrow cannot
be refunded, that dispute resolutions account for every held cent, that
`alg: none` tokens are rejected, that a vendor cannot browse the talent roster,
that no response body leaks a Stripe account ID, and that a failed login reveals
nothing about whether the address is registered.

A drift test compares the TypeScript taxonomy against the seeded SQL reference
data, so a new event type cannot be added to one and forgotten in the other.

The database tests run against a real PostgreSQL — there is no mock, because the
entire value of that layer is whether the SQL, the constraints and the type
mapping actually work, and a fake answers none of that. The complete booking
flow is run twice, once over each store, so the two cannot drift apart.

The Stripe gateway is tested against a local server standing in for Stripe — no
key, no network. What that checks is the part that is actually ours: that every
mutating call carries an idempotency key, that the API version is pinned, that
no PaymentIntent carries `transfer_data` (which would pay the vendor at capture
and leave no escrow to release from), and that failures are classified
retryable or final the way the booking flow depends on.

### What wiring up PostgreSQL found

Four defects the in-memory store could not have surfaced:

1. **IDs were the wrong type.** The routes generated `usr_a1b2c3d4e5f6`; every
   id column in the schema is `UUID`. Every insert would have failed the moment
   a real database was attached. They are full UUIDs now — which also fixed the
   second bug.
2. **IDs were 48 bits, not 128.** `randomUUID().slice(0, 12)` throws away most
   of the entropy, and a primary-key collision there is a hard failure for
   someone signing up.
3. **Phone numbers were unique in the schema but not in the store.** Two
   accounts sharing a number means an OTP that authenticates the wrong person.
   The in-memory store now enforces it too, so the two agree.
4. **`003_app_role.sql` granted and revoked against different schemas.**
   `GRANT ... ON ALL TABLES IN SCHEMA public` names a schema; the follow-up
   `REVOKE UPDATE ON ledger_entries` was unqualified and resolved through
   `search_path`. Where those differed, the ledger stayed updatable — exactly
   the guarantee the migration exists to provide.

### What building the web app found

Four defects that neither a type-check nor a unit test can see, all of them
surfaced by driving a real browser through the real forms:

1. **A function was being passed from a server component to a client
   component.** React Server Components cannot serialise one, so the whole
   register page 500'd. The helper is now imported on the client side instead.
2. **`users.roles` came back as a string, not an array.** It is declared
   `user_role[]`, and node-postgres has parsers only for the built-in array
   types — a custom enum array arrives as the literal `"{host}"` and the first
   `.map` on it throws. The column is cast to `text[]` on the way out. The
   Postgres tests asserted `languages` (a `text[]`, which *is* parsed) but never
   asserted `roles`, which is exactly how it slipped through.
3. **`min="1" step="25"` on the rate inputs silently blocked the form.** Those
   attributes make 1, 26, 51… the only valid values, so a vendor typing any
   round number got a dead button and no message.
4. **The publish confirmation could never be read.** On success the action
   revalidates, the gig stops being a draft, and the button unmounts along with
   the message it was holding. The confirmation now lives on the page itself,
   which survives the re-render.

There was also a fifth, found before the browser was involved: the PostgreSQL
store was implemented and tested but **never actually selected at runtime** —
`DATABASE_URL` was not read anywhere, so the service would have lost every
booking on restart. It is now chosen the same way Stripe and Redis are, and
production refuses to start without it.

### What moving the rate limiter to Redis is for

Per-process buckets are not a limit once there is more than one replica: each
pod keeps its own, so an attacker's effective allowance is whatever was
configured multiplied by the number of pods. There is a test asserting exactly
that failure against the in-process limiter, next to one asserting two Redis-
backed limiters share a single budget.

The refill and the spend happen inside one Lua script, because done as separate
round trips two concurrent requests both read the same token count and both
spend it — so a test fires six times the capacity in parallel across three
connections and asserts exactly the capacity is allowed. Time comes from Redis
rather than the caller, since a bucket stamped by a pod with a fast clock would
otherwise refuse traffic on every other pod until real time caught up.

### What wiring up Stripe found

Error classification cannot dispatch on the SDK's error classes. In the current
SDK every error built from an API response arrives as a `StripeAPIError`
whatever actually failed, so `instanceof StripeCardError` is false for a real
decline and the obvious implementation sends everything to the default branch.
The discriminator is `rawType`, the wire vocabulary; errors raised locally
rather than by the API carry no `rawType` and are identified by `type` instead,
so both are read. Had this gone unnoticed, a transient rate limit would have
been classified non-retryable and a booking would have been stranded rather
than retried.
