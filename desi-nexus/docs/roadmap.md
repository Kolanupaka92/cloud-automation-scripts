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
| Live Stripe HTTP client | **built** on the official SDK, tested against a local Stripe stand-in |
| PostgreSQL repository implementations | **built**, with the booking flow tested end to end against a real database |
| Application role and privilege posture | **built** (`003_app_role.sql`) |
| Penetration test | not started |
| App Store / Play Store submission | **deferred** — web-first until demand justifies a mobile build |

## What to build next, in order

1. **The outbox relay.** The table and the publish calls exist; the poller does
   not. Until it does, notifications depend on the in-process bus, so a restart
   between a gig going live and its notifications firing loses them.
2. **A run against Stripe test mode**, once the LLC is registered and keys can
   be issued. The gateway is verified against a local stand-in, which checks the
   request shape and the error handling but not Stripe's own behaviour.
3. **Notification transports**, then the WebSocket layer. The web app already
   tells hosts that vendors are being notified in waves, which is currently only
   true in-process.
4. **Portfolio uploads** (presigned S3), so vendor profiles carry work samples.
5. **Escrow screens**, once the LLC exists and Stripe keys can be issued.

**Mobile is deliberately deferred** until demand justifies it. The web app is
responsive and works at phone width today, so a vendor can accept a gig from
their phone without an app store in the loop.

### Done since the first cut

**PostgreSQL repositories.** Implemented behind the existing interfaces, so the
routes and the domain did not change. Wiring them up found four defects that the
in-memory store could not have surfaced — see the README.

**The live Stripe gateway.** Built on the official SDK, behind the same
`StripeGateway` interface the fake implements. Live payments engage when
`STRIPE_API_KEY` is set; production refuses to start without it, so there is no
configuration in which the service quietly accepts bookings that move no money.

**Shared rate limiting.** Token buckets moved into Redis, refilled and spent
inside one Lua script so concurrent requests cannot overspend them. Production
refuses to start without `REDIS_URL`: per-pod buckets multiply the effective
allowance by the replica count, which is not a limit.

**The web app.** Next.js 15 covering the whole booking loop — register, verify,
post and publish a gig, a vendor's ranked feed, apply, and book. Driven
end to end in a real browser against a real API and a real PostgreSQL. Mobile
is deliberately deferred until demand justifies it; the web app is responsive
and works at phone width today.

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
