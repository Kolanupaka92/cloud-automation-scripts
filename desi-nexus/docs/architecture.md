# DESI-NEXUS — system architecture

## What this is

A marketplace connecting three sides of the Texas South Asian event economy:

- **Hosts** — boutiques, agencies and families booking an event.
- **Crew** — MUAs, photographers, henna artists, pandits, decorators.
- **Creators** — models and influencers, for the commercial side.

The load-bearing observation is that these are not three markets. A boutique in
Frisco books the same makeup artist for a lookbook shoot that a family books for
a Half-Saree Function. Unifying them means one supply pool serves two demand
curves, which is the only reason a hyper-local marketplace can reach liquidity
in a single metro.

## Topology

```
                  [ Web (Next.js) ]   [ iOS / Android ]
                            \             /
                             \  HTTPS / WSS
                              v         v
                        [ Edge: WAF + TLS 1.3 ]
                                   |
                            [ API Gateway ]
                                   |
        +--------------+-----------+-----------+--------------+
        v              v                       v              v
  [ Auth & IAM ]  [ Gig & Match ]        [ Ledger &      [ Messaging ]
                                          Escrow ]
        |              |                       |              |
        +--------------+-----------+-----------+--------------+
                                   v
                     [ Outbox -> Kafka (domain events) ]
                                   |
                 +-----------------+------------------+
                 v                 v                  v
          [ Notification ]   [ Analytics ]     [ Reconciliation ]
```

### Why the outbox

Events are written to `event_outbox` in the **same transaction** as the state
change they describe, and relayed to Kafka by a poller. The alternative —
publishing inline after the commit — fails the way marketplaces actually fail: a
broker blip means a gig goes live and no vendor is ever notified. The host sees
an empty applicant list and concludes the platform has no supply.

This is the single most important structural decision in the system, and it is
why `event_outbox` exists in the schema rather than a direct producer call.

## Services

| Service | Owns | Store |
|---|---|---|
| Auth & IAM | identities, credentials, sessions, OTP, MFA | PostgreSQL |
| Gig & Match | gig lifecycle, applications, match scoring, notification waves | PostgreSQL + search index |
| Ledger & Escrow | quotes, escrow state, the append-only ledger, Stripe | PostgreSQL (strict) |
| Messaging | in-app threads, presence, WebSocket fan-out | document store |
| Notification | push, SMS, email, wave scheduling | consumes Kafka |

The split is along **consistency requirements**, not along noun boundaries.
Money needs serialisable transactions and real constraints; chat needs write
throughput and does not. Putting them in one store means one of them is served
badly.

## Data stores

**PostgreSQL** holds anything that must reconcile: users, gigs, applications,
escrows, the ledger. Foreign keys, check constraints and row-level security are
used heavily — see `db/migrations/001_init.sql`. The invariants that matter are
asserted in *both* the code and the schema, on the principle that the database
is the last line that cannot be bypassed by a bug in a service.

**Document store** (MongoDB or Firestore) holds chat history, portfolio
metadata, and notification state: high write volume, shape varies per user
type, and none of it needs to join against the ledger.

**S3 + CloudFront** holds portfolio media. Uploads are direct-to-S3 via
presigned URLs; media never transits the API. This is why `MAX_BODY_BYTES` on
the API is 256KB.

## Matching and Time-to-Match

The North Star is 60 minutes from posting to a matched vendor. Two mechanisms:

1. **Ranking** (`src/domain/matching.ts`) — a weighted score across cultural
   fit, proximity, budget, language, reputation and responsiveness. Hard filters
   run first and are absolute: wrong speciality, unavailable on the date, out of
   travel range, or not payout-ready removes a candidate outright.

2. **Notification waves** — the shortlist is notified in waves, not all at once.
   Blasting everyone gets the host thirty applications and twenty-nine
   disappointed vendors, and trains the whole supply side to ignore the push.
   The strongest matches get a 15-minute head start; later waves fire only if
   the gig is still short. Gigs inside 72 hours collapse to a single immediate
   wave, because a Saturday-morning cancellation cannot wait for wave three.

Every score is returned with its component breakdown. When a vendor asks why
they stopped seeing Sangeet work, the answer has to be a number.

## Geography

Texas is the hard part. DFW to Greater Houston is further than London to Paris.
A vendor who says "I cover Texas" means something very different from one who
says "I cover Frisco".

- Candidate filtering uses a haversine distance — cheap, runs against the whole
  index. A road-distance Distance Matrix call is made only for the shortlist;
  billing a Maps request per candidate per gig does not survive a busy Saturday.
- Straight-line miles are inflated by a detour factor so quotes are not
  systematically low before the road distance arrives.
- Travel is billed **round trip**. A 9am Griha Pravesham in Katy booked out of
  Plano is two long drives, not one.
- Beyond an overnight threshold, a flat lodging charge applies, because the
  alternative is a vendor who arrives exhausted or does not arrive at all.

## The gig state machine

```
Draft -> Open -> ApplicationsReview -> EscrowLocked -> InTransit
      -> Active -> DeliveryPending -> Completed
```

with `Cancelled` and `Disputed` reachable from the appropriate points. Every
edge is a guarded row in a table (`src/domain/gig.ts`), not an `if` in a route
handler, because money moves on some of these edges. An unguarded jump from
`ApplicationsReview` to `Active` would run a gig with no funds held.

Notable guards:

- `ApplicationsReview -> EscrowLocked` requires an accepted offer **and** a
  deposit that has actually cleared — asserted from the Stripe webhook, never
  from the client.
- `EscrowLocked -> InTransit` requires the event to be inside the call-time
  window, so a vendor cannot claim travel days early.
- `EscrowLocked -> Cancelled` requires a reason, so the refund tier applies.
- A vendor cannot cancel from `InTransit`; only an admin can.

## Money

See `docs/security.md` for the payment security posture and `src/domain/escrow.ts`
for the ledger. In short: integer cents everywhere, an append-only ledger with
balances derived by folding rather than stored, and release gated on two
independent conditions so that neither a host alone nor a timer alone can move
money.

## What is deliberately not built yet

- The real Stripe HTTP client (the interface and the fake are in place).
- The PostgreSQL repository implementations (the interfaces are in place; the
  in-memory ones back the tests).
- WebSocket messaging, the search index, and the notification transports.
- The Next.js dashboard and the mobile clients.

The domain core, the security layer and the HTTP surface are real, tested and
runnable today.
