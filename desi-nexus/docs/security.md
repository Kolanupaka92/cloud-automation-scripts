# DESI-NEXUS — security posture

The platform holds two things worth stealing: thousands of dollars per booking
in transit, and proprietary creative portfolios that are a competitor's fastest
route to a supply side. The controls below are ordered by what an attacker would
actually try.

## Payment security

**No card data touches our infrastructure.** The client collects payment details
directly against Stripe and confirms with a client-side token; this service only
ever handles Stripe object IDs and integer cents. `src/infra/stripe.ts` is the
complete list of places money is touched, and none of them accept a card number.
This is what keeps PCI-DSS scope to SAQ-A.

**Only the webhook may assert that a payment succeeded.** A client that reports
its own payment succeeded is a client that can report a payment that did not
happen. `POST /v1/webhooks/stripe` verifies the Stripe signature over the raw
body with a constant-time comparison, and rejects anything outside a 300-second
timestamp tolerance so a genuine old event cannot be replayed.

**Release requires two independent conditions.** Funds move to a vendor only
when the gig is in `DeliveryPending` *and* either the host has signed off or the
72-hour auto-release window has elapsed. Neither the host alone nor a timer
alone can move money. The auto-release exists because a vendor should not be
held hostage by a host who simply stopped replying.

**The ledger is append-only.** Balances are derived by folding entries, never
stored as a mutable column, so a partial failure mid-release can be replayed
rather than reconciled by hand. `UPDATE` and `DELETE` on `ledger_entries` are
rejected by a database trigger, not merely by convention — a correction is a
compensating entry.

**The API version is pinned.** An unpinned integration silently adopts whatever
version Stripe makes current, which changes response shapes under a running
service. It moves on purpose, with the changelog open.

**Stripe's error copy never reaches a client.** It is written for the
integrator and can name internal decline codes; callers get a stable code and a
retryable flag, and the detail goes to the log with Stripe's request id. That
classification is load-bearing in both directions: retrying a decline annoys the
cardholder and can trip fraud rules, while giving up on a transient rate limit
strands funds mid-booking.

**Every mutating Stripe call is idempotent**, keyed on the escrow and the leg.
A retried request cannot double-charge or double-pay. The idempotency check runs
*before* the state check, so a redelivered webhook is a silent no-op rather than
an error Stripe will keep retrying.

**Reconciliation asserts real invariants.** `assertLedgerBalances` deliberately
does *not* check "captured minus outflow equals held" — held is defined as the
fold of the entries, so that identity is true by construction and checks
nothing. It checks that the ledger and the escrow state agree (money out of a
vault still marked `FullyFunded` is a bug or a tampered row), that nothing left
that never arrived, and that no more was collected than the quote the parties
agreed to.

## Identity and access

- **Deny by default.** A route declares what it needs; anything not explicitly
  allowed is refused.
- **MFA is a property of the session, not the account.** Logging in does not
  satisfy MFA. Every endpoint that can move money or change payout details
  requires a session that actually cleared an OTP challenge (`requireMfa`).
  An attacker with a stolen password gets a read-only session.
- **Payouts require ID verification, MFA and Stripe Connect onboarding**, with
  no admin override (`canReceivePayouts`). This is the control that stops a
  compromised password from redirecting a vendor's earnings.
- **The admin role cannot be self-assigned** at registration.
- **Tokens pin their algorithm.** `alg` is read from a constant, never from the
  token, so the `alg: none` and RS-to-HS confusion families are unreachable. A
  refresh token is typed and cannot open a resource endpoint.
- **Passwords** use scrypt at current OWASP parameters, with the parameters
  stored alongside the hash so they can be raised without invalidating existing
  credentials. Policy is length-based; composition rules only teach people to
  append `!1`.
- **Account enumeration is closed.** A login against an unknown address spends
  comparable time and returns a byte-identical body to a wrong password.
  Registration does not confirm whether an address is already taken.
- **Lockout** after five failed attempts, for fifteen minutes.

## Edge and data

- TLS 1.3 terminates at the load balancer; mTLS inside the mesh. The API process
  listens on plain HTTP and must never be exposed directly.
- Security headers (HSTS, `nosniff`, `DENY`, `no-referrer`, a locked-down CSP,
  `no-store`) are applied to every response *in the application* as well as at
  the edge, so a direct-to-pod request is not quietly weaker.
- AES-256 at rest on every volume, with KMS-managed key rotation. The MFA secret
  column is additionally envelope-encrypted, so a database dump alone does not
  yield second factors.
- Row-level security on `gigs`, `escrows` and `reviews`. Even with a SQL
  injection foothold, a host cannot read another host's bookings. The policies
  read `app.current_user_id`, which the repository layer sets per transaction
  with `set_config(..., true)` so it cannot leak to the next borrower of a
  pooled connection.
- **The service connects as `desi_nexus_app`, never as the schema owner**
  (`db/migrations/003_app_role.sql`). This is what makes the policies real: RLS
  is bypassed by the table owner, so an application connecting as the owner is
  protected by none of it. That role also cannot `DELETE` a user, gig, booking
  or ledger row, and cannot `UPDATE` the append-only tables at all — the
  privilege is withheld, so the attempt is refused before it reaches a trigger.
  There are tests asserting each of those grants.

## Anti-scraping

The talent index is the crown jewel. Controls:

- Talent search is **authenticated and host-only**. A vendor browsing the full
  competitor roster is the other half of the scraping problem.
- The strict `discovery` token bucket (120 burst, 1/sec sustained) applies to
  search and portfolio reads.
- Contact details are returned to nobody. A host reaches a vendor through the
  in-app thread a booking creates, never through a phone number lifted from a
  search result.
- Stripe connected-account IDs are stripped from every client-facing projection;
  there are tests asserting no response body contains `acct_`.

Rate limit buckets are keyed on the authenticated user where there is one, and
on the client address otherwise. Anonymous buckets are the generous ones,
because keying on address is imperfect behind carrier NAT — which is why the
expensive endpoints all require a token. Only the first hop of `X-Forwarded-For`
is trusted; taking the whole header would let a client spoof its way out of its
own bucket.

**The buckets are shared, not per-pod.** They live in Redis, and the refill and
spend happen inside one Lua script. Both halves matter: per-process buckets mean
an attacker's effective allowance is whatever was configured multiplied by the
replica count, and a refill-then-spend done as separate round trips lets
concurrent requests each read the same token count and each spend it. Production
refuses to start without `REDIS_URL`, because a service that looks rate limited
and is not is worse than one that will not boot.

Time inside the script comes from Redis rather than the caller: pods drift, and
a bucket stamped by a fast clock would otherwise refuse traffic everywhere else
until real time caught up.

A Redis outage fails **open** by default. The edge WAF still carries the coarse
limits, so this is a reduction in protection rather than its removal, and an
outage that blocks every login is a worse incident than one that briefly lets a
scraper run faster. Deployments that disagree can pass `onError: "closed"`.

## Error handling

Internal messages and stack traces are never returned to a client. Every
response carries a trace ID, which is the handle support uses to find the real
error in the logs.

## Known gaps before the pilot

1. Secrets are read from environment variables; these should come from a secrets
   manager with rotation.
2. No automated key rotation for the token signing secret yet — needs a key-ID
   claim and a two-key verification window.
3. The dispute resolution flow has no evidence-upload path.
4. Penetration test not yet run. This is Phase 3 work in the roadmap.
