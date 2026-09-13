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
| `services/api/src/domain/` | The domain core: taxonomy, money, geography, gig state machine, matching, escrow |
| `services/api/src/infra/` | Tokens, password hashing, rate limiting, the Stripe boundary, repositories |
| `services/api/src/http/` | Router, middleware and route modules |
| `services/api/test/` | 113 tests, including a full booking flow over the real routes |
| `db/migrations/` | PostgreSQL schema and seeded reference data |
| `docs/` | Architecture, security posture, API specification, roadmap |

The domain core, the security layer and the HTTP surface are real and runnable.
Persistence is behind repository interfaces with in-memory implementations; the
Stripe gateway is behind an interface with a fake. Both are designed to be
swapped without the domain or the routes changing. See `docs/roadmap.md` for an
honest built-versus-specified breakdown.

## Running it

```bash
cd services/api
npm install
npm test          # typechecks, then runs the suite
npm run build && npm start
```

The service starts on `:8080` with in-memory persistence and the fake payment
gateway, so the whole booking flow works locally with no external dependencies.

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

Requires PostgreSQL 15+ with PostGIS. The schema was validated against
PostgreSQL 16; its check constraints, unique indexes, append-only triggers and
row-level security policies were each confirmed to reject the bad writes they
are there to prevent.

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

113 tests. Beyond the unit coverage, the suite asserts the things that would
actually hurt: that a booking cannot be confirmed before its deposit clears,
that a replayed Stripe webhook cannot double-fund, that a released escrow cannot
be refunded, that dispute resolutions account for every held cent, that
`alg: none` tokens are rejected, that a vendor cannot browse the talent roster,
that no response body leaks a Stripe account ID, and that a failed login reveals
nothing about whether the address is registered.

A drift test compares the TypeScript taxonomy against the seeded SQL reference
data, so a new event type cannot be added to one and forgotten in the other.
