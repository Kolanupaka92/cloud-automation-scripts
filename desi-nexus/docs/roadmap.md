# DESI-NEXUS — MVP roadmap

Twelve weeks to a Texas pilot. Status below is honest about what exists in this
repository today versus what is specified but unbuilt.

## Phase 1 — Identity and profiles (weeks 1-4)

| Item | Status |
|---|---|
| Email + password registration, scrypt hashing, length-based policy | **built** |
| Phone OTP send/verify, MFA step-up sessions | **built** |
| Multi-role registration (host / crew / creator) | **built** |
| Polymorphic profile model and validation | **built** |
| Texas footprint enforcement at registration | **built** |
| Social OAuth (Instagram / TikTok / YouTube) for verified follower counts | model only |
| Portfolio upload: presigned S3 + CloudFront | schema only |
| Government ID verification integration | not started |

## Phase 2 — Cultural gig engine (weeks 5-8)

| Item | Status |
|---|---|
| Desi event taxonomy, crew specialities, cultural tags, style affinity | **built** |
| "Post a Gig" brief model and validation | **built** |
| Gig state machine with guarded transitions | **built** |
| Match scoring with explainable breakdown | **built** |
| Texas geofencing and round-trip travel pricing | **built** |
| Wave-based notification planning | **built** (planning; transports not wired) |
| Applicant dashboard endpoint with consistent ranking | **built** |
| Push / SMS transports | not started |
| In-app messaging over WebSocket | not started |
| Search index (the current candidate fetch is a table scan) | not started |

## Phase 3 — Financial layer (weeks 9-12)

| Item | Status |
|---|---|
| Quote and fee-split engine, integer cents throughout | **built** |
| Escrow ledger: append-only, idempotent, reconciled | **built** |
| Deposit and balance capture legs | **built** |
| Two-condition release plus 72h auto-release | **built** |
| Cancellation tiers and refund splitting | **built** |
| Dispute open and admin resolution | **built** |
| Stripe Connect onboarding | **built** against the gateway interface |
| Live Stripe HTTP client | interface + fake only |
| PostgreSQL repository implementations | interfaces + in-memory only |
| Penetration test | not started |
| App Store / Play Store submission | not started |

## What to build next, in order

1. **PostgreSQL repositories.** The schema and the interfaces both exist; this
   is mechanical, and nothing else can be load-tested until it lands.
2. **The live Stripe client.** Same shape as `FakeStripeGateway`. Then run the
   existing e2e suite against Stripe test mode.
3. **Redis-backed rate limiting.** Per-pod buckets are a real hole once there is
   more than one replica — see `docs/security.md`.
4. **The outbox relay.** The table and the publish calls exist; the poller does
   not. Until it does, notifications depend on the in-process bus.
5. **Notification transports**, then the WebSocket layer.
6. **Next.js host dashboard**, then the mobile clients.

## Metrics to instrument from day one

- **Time-to-Match** — posting to first application, and posting to accepted
  offer. The whole wave design is a bet on this number; it needs measuring, not
  assuming.
- **GMV** and take rate, from the ledger.
- **Wave conversion** — what fraction of gigs are filled by wave 1. If it is
  high, the waves can be slower and vendors get less noise. If it is low, the
  ranking is wrong.
- **Cancellation rate by side.** Vendor-initiated cancellations are the churn
  risk; they cost the platform money under the refund policy.
- **Cold-start vendor discoverability** — a new vendor's median score and time
  to first booking. If this decays, supply stops joining.
