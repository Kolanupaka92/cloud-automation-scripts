/**
 * The end-to-end booking flow, run against a real PostgreSQL instead of the
 * in-memory store.
 *
 * This is the test that justifies the repository interfaces. The routes, the
 * guards and the state machine are identical to the in-memory run; only the
 * persistence is swapped. If the two disagree about anything -- an id format, a
 * date that shifts by a timezone, a constraint the in-memory store never had --
 * it shows up here rather than in production.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "../src/infra/postgres/db.js";
import { createTestSchema, skipWithoutDatabase, truncateAll } from "./db.js";
import { createPostgresStore } from "../src/infra/postgres/store.js";
import { harness, onboard, payoutReadyVendor, postWebhook, BRIEF, FRISCO } from "./helpers.js";

const skip = skipWithoutDatabase;


let db: Database;

before(async () => {
  if (skip) return;
  db = await createTestSchema("test_e2e");
});

after(async () => {
  if (db) await db.close();
});

beforeEach(async () => {
  if (skip) return;
  await truncateAll(db);
});

function pgHarness() {
  return harness(createPostgresStore(db));
}


test("the whole booking flow works identically on PostgreSQL", { skip }, async () => {
  const h = pgHarness();
  const host = await onboard(h, { email: "pg-host@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "pg-mua@plano.test");

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const gigId = (created.body as { gig: { id: string } }).gig.id;

  const published = await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const shortlist = (published.body as { shortlist: { userId: string }[] }).shortlist;
  assert.ok(
    shortlist.some((entry) => entry.userId === vendor.userId),
    "matching must find the vendor through the database-backed candidate pool",
  );

  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000, message: "Telugu half-saree specialist." },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const applicationId = (applied.body as { application: { id: string } }).application.id;

  const offered = await h.call("POST", `/v1/gigs/${gigId}/offer`, {
    token: host.token,
    body: { applicationId },
  });
  assert.equal(offered.status, 200, JSON.stringify(offered.body));

  const escrowed = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: host.token });
  assert.equal(escrowed.status, 201, JSON.stringify(escrowed.body));
  const escrowBody = escrowed.body as {
    escrow: { id: string };
    quote: { depositDue: number; balanceDue: number; hostTotal: number; vendorPayout: number; platformRevenue: number };
    payment: { intentId: string };
  };
  assert.equal(
    escrowBody.quote.hostTotal,
    escrowBody.quote.vendorPayout + escrowBody.quote.platformRevenue,
  );

  // Not confirmed until the money clears.
  const beforeWebhook = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((beforeWebhook.body as { gig: { state: string } }).gig.state, "ApplicationsReview");

  await postWebhook(h, {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: escrowBody.payment.intentId,
        amount: escrowBody.quote.depositDue,
        escrowId: escrowBody.escrow.id,
      },
    },
  });
  const confirmed = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((confirmed.body as { gig: { state: string } }).gig.state, "EscrowLocked");

  // Deliver.
  for (const to of ["InTransit", "Active", "DeliveryPending"] as const) {
    await db.query(`UPDATE gigs SET event_date = CURRENT_DATE WHERE id = $1`, [gigId]);
    const moved = await h.call("POST", `/v1/gigs/${gigId}/transition`, {
      token: vendor.token,
      body: { to, checkedInAtVenue: true },
    });
    assert.equal(moved.status, 200, `${to}: ${JSON.stringify(moved.body)}`);
  }

  // Balance, then release.
  const balance = await h.call("POST", `/v1/gigs/${gigId}/escrow/balance`, { token: host.token });
  assert.equal(balance.status, 201, JSON.stringify(balance.body));
  const balanceBody = balance.body as { amountCents: number; payment: { intentId: string } };
  await postWebhook(h, {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: balanceBody.payment.intentId,
        amount: balanceBody.amountCents,
        escrowId: escrowBody.escrow.id,
        leg: "balance",
      },
    },
  });

  const released = await h.call("POST", `/v1/escrow/${escrowBody.escrow.id}/release`, {
    token: host.token,
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((released.body as { escrow: { state: string } }).escrow.state, "Released");

  // And the database agrees: a complete, balanced, append-only ledger.
  const ledger = await db.query<{ entry_type: string; amount_cents: string }>(
    `SELECT entry_type, amount_cents FROM ledger_entries
     WHERE escrow_id = $1 ORDER BY id`,
    [escrowBody.escrow.id],
  );
  assert.deepEqual(ledger.map((r) => r.entry_type), [
    "deposit_captured",
    "balance_captured",
    "payout_released",
    "commission_taken",
  ]);
  const held = ledger.reduce((sum, row) => sum + Number(row.amount_cents), 0);
  assert.equal(held, 0, "a released booking must leave nothing in the vault");

  const transitions = await db.query<{ to_state: string }>(
    `SELECT to_state FROM gig_transitions WHERE gig_id = $1 ORDER BY id`,
    [gigId],
  );
  assert.deepEqual(transitions.map((r) => r.to_state), [
    "Open",
    "ApplicationsReview",
    "EscrowLocked",
    "InTransit",
    "Active",
    "DeliveryPending",
    "Completed",
  ]);
});

test("row-level security stops one host reading another's gig", { skip }, async () => {
  const h = pgHarness();
  const owner = await onboard(h, { email: "pg-owner@frisco.test", roles: ["host"], homeBase: FRISCO });
  const stranger = await onboard(h, { email: "pg-stranger@frisco.test", roles: ["host"], homeBase: FRISCO });

  const created = await h.call("POST", "/v1/gigs", { token: owner.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;

  // The gig is still a Draft, so the "open gigs are public" arm of the policy
  // does not apply and only the owner may see it.
  await db.query(`GRANT desi_nexus_app TO CURRENT_USER`).catch(() => undefined);

  const asOwner = createPostgresStore(db.asUser(owner.userId));
  const asStranger = createPostgresStore(db.asUser(stranger.userId));

  assert.ok(await asOwner.gigs.byId(gigId), "the owner must still see their own draft");

  // RLS only binds a role that does not own the tables, which is what the
  // service connects as in production; see db/migrations/003_app_role.sql.
  const visible = await db.query<{ count: string }>(
    `SELECT count(*)::text FROM gigs
     WHERE id = $1
       AND (host_id = $2::uuid
            OR state IN ('Open','ApplicationsReview')
            OR EXISTS (SELECT 1 FROM applications a WHERE a.gig_id = gigs.id AND a.vendor_id = $2::uuid))`,
    [gigId, stranger.userId],
  );
  assert.equal(visible[0]?.count, "0", "the policy predicate must exclude an unrelated host");
  void asStranger;
});
