# DESI-NEXUS — API specification

Base URL: `/v1`. All request and response bodies are JSON. All amounts are
**integer cents**. All timestamps are ISO 8601 UTC.

Every response carries `x-trace-id`. Errors are shaped:

```json
{ "error": { "code": "mfa_required", "message": "...", "details": {} },
  "traceId": "trc_..." }
```

## Authentication

`Authorization: Bearer <accessToken>`. Access tokens live 15 minutes; refresh
tokens 30 days. A refresh token is rejected on resource endpoints.

**MFA step-up:** a plain login returns a session with `mfa: false`. Clearing an
OTP challenge returns one with `mfa: true`. Endpoints marked **MFA** below
require the latter.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/register` | — | Creates the identity. `admin` cannot be self-assigned. |
| POST | `/v1/auth/login` | — | Returns a token pair plus `mfaRequired`. |
| POST | `/v1/auth/refresh` | refresh token | Rotates the access token. |
| POST | `/v1/auth/otp/send` | bearer | Sends a phone OTP. Strictest rate bucket. |
| POST | `/v1/auth/otp/verify` | bearer | Verifies, promotes the session to MFA. |
| POST | `/v1/auth/mfa/enable` | bearer | Turns on MFA for the account. |
| GET | `/v1/me` | bearer | Current user and session MFA state. |

### `POST /v1/auth/register`

```json
{ "email": "boutique@frisco.example", "password": "at-least-12-characters",
  "displayName": "Saree House Frisco", "roles": ["host"],
  "homeBase": { "lat": 33.1507, "lng": -96.8236 },
  "phone": "+14695550123", "languages": ["english", "telugu"] }
```

`400 outside_footprint` if `homeBase` is outside the Texas pilot metros.

## Taxonomy and discovery

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/taxonomy` | — | Event groups, specialities, cultural tags, languages, metros. Cacheable 1h. |
| GET | `/v1/taxonomy/event/:eventType` | — | The crew an event customarily needs. |
| POST | `/v1/profiles/crew` | crew | Create or replace a crew profile. |
| GET | `/v1/profiles/crew/:userId` | bearer | Public projection. No contact details, no Stripe IDs. |
| POST | `/v1/profiles/creator` | creator | Create or replace a creator profile; returns computed local reach. |
| POST | `/v1/search/crew` | **host** | Ranked talent search against a brief. |
| POST | `/v1/travel/quote` | bearer | Price a trip before anyone commits. |

### `POST /v1/search/crew`

```json
{ "specialty": "mua", "venue": { "lat": 33.1507, "lng": -96.8236 },
  "eventDate": "2027-06-20", "culturalTags": ["telugu_traditional"],
  "languages": ["telugu"], "budgetMinCents": 40000, "budgetMaxCents": 90000 }
```

Returns up to 25 results, each with `score` (0-100) and a `breakdown` naming the
contribution of cultural fit, proximity, budget, language, reputation and
responsiveness.

## Gigs

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/gigs` | host | Creates a `Draft`. |
| GET | `/v1/gigs/:gigId` | bearer | Gig plus the transitions available to *you*. |
| POST | `/v1/gigs/:gigId/publish` | host (owner) | `Draft -> Open`. Runs matching, schedules notification waves. |
| POST | `/v1/gigs/:gigId/applications` | crew/creator | Apply. Moves the gig to `ApplicationsReview`. |
| GET | `/v1/gigs/:gigId/applications` | host (owner) | Applicants, ranked by the same match score. |
| POST | `/v1/gigs/:gigId/offer` | host (owner) | Accept an applicant. Does **not** confirm the booking. |
| POST | `/v1/gigs/:gigId/transition` | bearer | Drive any other permitted transition. |

`publish` returns the shortlist and the notification wave plan:

```json
{ "gig": { "state": "Open" },
  "shortlist": [ { "userId": "usr_...", "score": 94, "travelMiles": 12.4 } ],
  "notificationWaves": [ { "wave": 1, "userIds": ["usr_..."], "delayMinutes": 0 } ] }
```

A rejected transition returns `409` naming the guard that failed and what *is*
allowed from here:

```json
{ "error": { "code": "guard_failed",
             "message": "the deposit has not cleared; funds must be held before the booking is confirmed",
             "details": { "from": "ApplicationsReview", "to": "EscrowLocked",
                          "allowed": ["Open", "EscrowLocked", "Cancelled"] } } }
```

## Payments and escrow

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/connect/onboard` | crew/creator, **MFA** | Starts Stripe Connect onboarding. |
| POST | `/v1/gigs/:gigId/escrow` | host (owner), **MFA** | Quotes the booking, creates the deposit intent. |
| POST | `/v1/gigs/:gigId/escrow/balance` | host (owner), **MFA** | Charges the remaining balance. |
| GET | `/v1/escrow/:escrowId` | party | Escrow state, quote and ledger. |
| POST | `/v1/escrow/:escrowId/release` | host, **MFA** | Sign off; pays the vendor. |
| POST | `/v1/escrow/:escrowId/cancel` | party, **MFA** | Cancels and refunds by tier. |
| POST | `/v1/escrow/:escrowId/dispute` | party | Opens a dispute; freezes the funds. |
| POST | `/v1/escrow/:escrowId/resolve` | admin, **MFA** | Splits held funds. Must account for every cent. |
| POST | `/v1/webhooks/stripe` | Stripe signature | The only path that may record a capture. |
| POST | `/v1/internal/escrow/auto-release` | admin | Scheduler sweep, past the 72h window. |

### The booking money flow

```
POST /v1/gigs/{id}/escrow          -> quote + deposit PaymentIntent (client token)
   client confirms against Stripe
   Stripe -> POST /v1/webhooks/stripe  (leg: "deposit")
                                    -> escrow DepositHeld, gig EscrowLocked
POST /v1/gigs/{id}/escrow/balance  -> balance PaymentIntent
   Stripe -> POST /v1/webhooks/stripe  (leg: "balance")
                                    -> escrow FullyFunded
   ... vendor travels, works, marks delivered ...
POST /v1/escrow/{id}/release       -> Transfer to the vendor, gig Completed
```

Funds cannot be released while any part of the fee is still on the host's card;
a partially funded escrow returns `409`.

### The quote

```json
{ "serviceSubtotal": 100000, "travelFee": 12000, "hostServiceFee": 5600,
  "hostTotal": 117600, "depositDue": 35280, "balanceDue": 82320,
  "vendorCommission": 12000, "vendorPayout": 100000, "platformRevenue": 17600 }
```

Two identities always hold, and are asserted by both the tests and a database
check constraint:

```
hostTotal == vendorPayout + platformRevenue
hostTotal == depositDue + balanceDue
```

Commission is charged on the service only, never on mileage. Billing commission
on travel pushes vendors to quote it off-platform, which is exactly the leakage
the escrow prevents.

### Cancellation tiers

Refund of funds held, by time remaining, when the **host** cancels:

| Notice | Refund |
|---|---|
| 30+ days | 100% |
| 14-30 days | 75% |
| 7-14 days | 50% |
| 48h-7 days | 25% |
| under 48h | 0% |

A **vendor** who cancels refunds the host in full, however late. Vendor ghosting
is the loudest complaint in this market; the platform eats the processing cost
rather than passing it to the family.

## Rate limits

`429` with `details.retryAfterSeconds`.

| Bucket | Burst | Sustained | Applies to |
|---|---|---|---|
| `otp` | 5 | 5/hour | OTP sends |
| `auth` | 10 | 10/15min | register, login, refresh |
| `payments` | 30 | 0.5/sec | everything that moves money |
| `discovery` | 120 | 1/sec | search, portfolio reads |
| `default` | 300 | 5/sec | everything else |
