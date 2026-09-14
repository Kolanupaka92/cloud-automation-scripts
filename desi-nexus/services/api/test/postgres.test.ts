/**
 * Integration tests against a real PostgreSQL.
 *
 * These skip cleanly when DESI_NEXUS_TEST_DATABASE_URL is unset, so the suite
 * still runs on a machine with no database; CI sets it and they run for real.
 * There is no mock Postgres here on purpose -- the whole value of this layer is
 * whether the SQL, the constraints and the type mapping actually work, and a
 * fake would answer none of that.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/infra/postgres/db.js";
import { createTestSchema, skipWithoutDatabase, truncateAll } from "./db.js";
import { createPostgresStore } from "../src/infra/postgres/store.js";
import type { Store } from "../src/infra/store.js";
import { quoteBooking } from "../src/domain/money.js";
import { createEscrow, recordDeposit, recordBalance, release } from "../src/domain/escrow.js";
import { transition, type Gig } from "../src/domain/gig.js";
import type { BaseUser, CrewProfile } from "../src/domain/users.js";

const skip = skipWithoutDatabase;


let db: Database;
let store: Store;

before(async () => {
  if (skip) return;
  db = await createTestSchema("test_repos");
  store = createPostgresStore(db);
});

after(async () => {
  if (db) await db.close();
});

beforeEach(async () => {
  if (skip) return;
  await truncateAll(db);
});

const FRISCO = { lat: 33.1507, lng: -96.8236 };
const PLANO = { lat: 33.0198, lng: -96.6989 };

function aUser(overrides: Partial<BaseUser> = {}): BaseUser {
  return {
    id: randomUUID(),
    email: `${randomUUID().slice(0, 8)}@example.test`,
    displayName: "Test Person",
    roles: ["host"],
    verification: "unverified",
    mfaEnabled: false,
    homeBase: FRISCO,
    metroId: "dfw",
    languages: ["english", "telugu"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function aCrewProfile(userId: string, overrides: Partial<CrewProfile> = {}): CrewProfile {
  return {
    userId,
    specialties: ["mua"],
    culturalTags: ["telugu_traditional", "south_indian_bridal"],
    startingRateCents: 55_000,
    travelPolicy: { freeRadiusMiles: 25, perMileCents: 90, maxRadiusMiles: 300 },
    unavailableDates: ["2027-06-21"],
    yearsExperience: 6,
    ratingCount: 0,
    completedGigs: 0,
    portfolioAssetIds: [],
    ...overrides,
  };
}

function aGig(hostId: string): Gig {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    hostId,
    state: "Draft",
    brief: {
      eventType: "half_saree_function",
      specialty: "mua",
      eventDate: "2027-06-20",
      venue: FRISCO,
      metroId: "dfw",
      budgetMinCents: 40_000,
      budgetMaxCents: 90_000,
      culturalTags: ["telugu_traditional"],
      languages: ["telugu"],
      headcount: 120,
      notes: "Morning call time.",
    },
    applicationCount: 0,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

test("a user round-trips, geography and all", { skip }, async () => {
  const user = aUser({ phone: "+14695550123", languages: ["english", "telugu"] });
  const created = await store.users.create(user);
  assert.equal(created.email, user.email);

  const loaded = await store.users.byId(user.id);
  assert.ok(loaded);
  assert.equal(loaded.displayName, "Test Person");
  assert.deepEqual(loaded.languages, ["english", "telugu"]);
  assert.equal(loaded.phone, "+14695550123");
  // Coordinates must survive the geography round trip without swapping.
  assert.ok(Math.abs(loaded.homeBase.lat - FRISCO.lat) < 1e-6, `lat drifted: ${loaded.homeBase.lat}`);
  assert.ok(Math.abs(loaded.homeBase.lng - FRISCO.lng) < 1e-6, `lng drifted: ${loaded.homeBase.lng}`);
});

test("roles come back as an array, not the raw enum-array literal", { skip }, async () => {
  // users.roles is user_role[], and the driver has no parser for a custom enum
  // array: without a cast it arrives as the string "{host,crew}" and the first
  // .map on it throws. Asserting the shape is the only thing that catches it,
  // because every field still reads fine as a string.
  const user = aUser({ roles: ["host", "crew"] });
  await store.users.create(user);

  const loaded = await store.users.byId(user.id);
  assert.ok(Array.isArray(loaded?.roles), `roles came back as ${typeof loaded?.roles}`);
  assert.deepEqual(loaded?.roles.slice().sort(), ["crew", "host"]);

  const byEmail = await store.users.byEmail(user.email);
  assert.ok(Array.isArray(byEmail?.roles), "byEmail must parse roles too");

  const updated = await store.users.update(user.id, { mfaEnabled: true });
  assert.ok(Array.isArray(updated.roles), "update's RETURNING must parse roles too");
});

test("email lookup is case-insensitive, because CITEXT says so", { skip }, async () => {
  const user = aUser({ email: "Boutique@Frisco.Test" });
  await store.users.create(user);
  const found = await store.users.byEmail("boutique@frisco.test");
  assert.equal(found?.id, user.id);
});

test("a duplicate email is refused by the database, not just by the service", { skip }, async () => {
  const user = aUser({ email: "same@frisco.test" });
  await store.users.create(user);
  await assert.rejects(() => store.users.create(aUser({ email: "same@frisco.test" })));
});

test("a partial update leaves the fields it was not given alone", { skip }, async () => {
  const user = aUser({ phone: "+14695550123" });
  await store.users.create(user);

  const updated = await store.users.update(user.id, { verification: "id_verified" });
  assert.equal(updated.verification, "id_verified");
  assert.equal(updated.phone, "+14695550123", "an absent key must not null the column");
  assert.equal(updated.displayName, "Test Person");
  assert.deepEqual(updated.languages, ["english", "telugu"]);
});

test("a crew profile round-trips across its three tables", { skip }, async () => {
  const user = aUser({ roles: ["crew"], homeBase: PLANO });
  await store.users.create(user);
  const saved = await store.profiles.putCrew(aCrewProfile(user.id));

  assert.deepEqual(saved.specialties, ["mua"]);
  assert.deepEqual(saved.culturalTags.slice().sort(), ["south_indian_bridal", "telugu_traditional"]);
  assert.deepEqual(saved.unavailableDates, ["2027-06-21"], "a DATE must not shift by a timezone");
  assert.equal(saved.startingRateCents, 55_000);
  assert.equal(saved.travelPolicy.perMileCents, 90);

  const loaded = await store.profiles.crew(user.id);
  assert.deepEqual(loaded, saved);
});

test("re-saving a profile replaces its specialities rather than accumulating them", { skip }, async () => {
  const user = aUser({ roles: ["crew"] });
  await store.users.create(user);
  await store.profiles.putCrew(aCrewProfile(user.id, { specialties: ["mua", "hair_stylist"] }));

  const narrowed = await store.profiles.putCrew(aCrewProfile(user.id, { specialties: ["mua"] }));
  assert.deepEqual(narrowed.specialties, ["mua"], "a dropped speciality must stop matching gigs");

  const byOldSpecialty = await store.profiles.crewBySpecialty("hair_stylist");
  assert.equal(byOldSpecialty.length, 0);
});

test("the candidate pool is looked up by speciality", { skip }, async () => {
  const mua = aUser({ roles: ["crew"], homeBase: PLANO });
  const dj = aUser({ roles: ["crew"], homeBase: PLANO });
  await store.users.create(mua);
  await store.users.create(dj);
  await store.profiles.putCrew(aCrewProfile(mua.id, { specialties: ["mua"] }));
  await store.profiles.putCrew(aCrewProfile(dj.id, { specialties: ["dj"] }));

  const pool = await store.profiles.crewBySpecialty("mua");
  assert.deepEqual(pool.map((p) => p.userId), [mua.id]);
});

test("a gig round-trips with its tags, languages and brief", { skip }, async () => {
  const host = aUser();
  await store.users.create(host);
  const gig = aGig(host.id);
  const created = await store.gigs.create(gig);

  assert.equal(created.state, "Draft");
  assert.deepEqual(created.brief.culturalTags, ["telugu_traditional"]);
  assert.deepEqual(created.brief.languages, ["telugu"]);
  assert.equal(created.brief.eventDate, "2027-06-20");
  assert.equal(created.brief.headcount, 120);
  assert.ok(Math.abs(created.brief.venue.lat - FRISCO.lat) < 1e-6);

  const loaded = await store.gigs.byId(gig.id);
  assert.deepEqual(loaded?.brief, created.brief);
});

test("the transition log is appended to, never rewritten", { skip }, async () => {
  const host = aUser();
  await store.users.create(host);
  const gig = await store.gigs.create(aGig(host.id));

  transition(gig, "Open", "host", host.id);
  await store.gigs.save(gig);
  gig.applicationCount = 1;
  transition(gig, "ApplicationsReview", "host", host.id);
  const saved = await store.gigs.save(gig);

  assert.equal(saved.state, "ApplicationsReview");
  assert.deepEqual(saved.history.map((h) => h.to), ["Open", "ApplicationsReview"]);

  // Saving again with no new transitions must not duplicate the log. If `save`
  // rewrote the history the append-only trigger would reject it outright.
  const again = await store.gigs.save(saved);
  assert.equal(again.history.length, 2, "a no-op save duplicated the transition log");
});

test("the database refuses a second accepted application on one gig", { skip }, async () => {
  const host = aUser();
  const a = aUser({ roles: ["crew"] });
  const b = aUser({ roles: ["crew"] });
  for (const user of [host, a, b]) await store.users.create(user);
  const gig = await store.gigs.create(aGig(host.id));

  const first = await store.applications.create({
    id: randomUUID(), gigId: gig.id, vendorId: a.id,
    quotedRateCents: 60_000, status: "submitted", createdAt: new Date().toISOString(),
  });
  const second = await store.applications.create({
    id: randomUUID(), gigId: gig.id, vendorId: b.id,
    quotedRateCents: 58_000, status: "submitted", createdAt: new Date().toISOString(),
  });

  await store.applications.save({ ...first, status: "accepted" });
  await assert.rejects(
    () => store.applications.save({ ...second, status: "accepted" }),
    /one_accepted_application_per_gig/,
    "two accepted offers on one gig must be impossible",
  );
});

test("a vendor cannot apply to the same gig twice, enforced by a unique index", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));

  const application = {
    gigId: gig.id, vendorId: vendor.id, quotedRateCents: 60_000,
    status: "submitted" as const, createdAt: new Date().toISOString(),
  };
  await store.applications.create({ ...application, id: randomUUID() });
  await assert.rejects(() => store.applications.create({ ...application, id: randomUUID() }));
});

test("an escrow persists its frozen quote and its ledger", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));

  const quote = quoteBooking(100_000, 12_000);
  const escrow = createEscrow({
    id: randomUUID(), gigId: gig.id, hostId: host.id, vendorId: vendor.id, quote,
  });
  const created = await store.escrows.create(escrow);
  assert.equal(created.state, "AwaitingDeposit");
  assert.deepEqual(created.quote, quote, "the quote must come back exactly as agreed");

  recordDeposit(created, quote.depositDue, "pi_deposit");
  const afterDeposit = await store.escrows.save(created);
  assert.equal(afterDeposit.state, "DepositHeld");
  assert.equal(afterDeposit.entries.length, 1);

  recordBalance(afterDeposit, quote.balanceDue, "pi_balance");
  const funded = await store.escrows.save(afterDeposit);
  assert.equal(funded.state, "FullyFunded");
  assert.equal(funded.entries.length, 2);

  release(funded, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_1");
  const released = await store.escrows.save(funded);
  assert.equal(released.state, "Released");
  assert.equal(released.entries.length, 4, "payout and commission entries must both persist");

  const reloaded = await store.escrows.byGig(gig.id);
  assert.deepEqual(reloaded?.entries.map((e) => e.type), [
    "deposit_captured", "balance_captured", "payout_released", "commission_taken",
  ]);
});

test("one Stripe payment cannot fund two bookings", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));
  const quote = quoteBooking(100_000);

  const escrow = await store.escrows.create(
    createEscrow({ id: randomUUID(), gigId: gig.id, hostId: host.id, vendorId: vendor.id, quote }),
  );
  recordDeposit(escrow, quote.depositDue, "pi_replayed");
  await store.escrows.save(escrow);

  // A second escrow claiming the same Stripe payment is a double-book. Two
  // independent unique constraints stand in the way; escrows.deposit_intent_id
  // is the one that fires, because the escrow row is written before its ledger.
  const other = createEscrow({
    id: randomUUID(),
    gigId: (await store.gigs.create(aGig(host.id))).id,
    hostId: host.id,
    vendorId: vendor.id,
    quote,
  });
  recordDeposit(other, quote.depositDue, "pi_replayed");
  await assert.rejects(() => store.escrows.create(other), /escrows_deposit_intent_id_key/);
});

test("the ledger's own unique index is a second line against a replay", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));
  const quote = quoteBooking(100_000);
  const escrow = await store.escrows.create(
    createEscrow({ id: randomUUID(), gigId: gig.id, hostId: host.id, vendorId: vendor.id, quote }),
  );

  // Written directly, bypassing the domain's own idempotency check, to prove
  // the database would still refuse a duplicated capture on its own.
  await db.query(
    `INSERT INTO ledger_entries (escrow_id, entry_type, amount_cents, stripe_ref)
     VALUES ($1, 'deposit_captured', $2, 'pi_once')`,
    [escrow.id, quote.depositDue],
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO ledger_entries (escrow_id, entry_type, amount_cents, stripe_ref)
       VALUES ($1, 'deposit_captured', $2, 'pi_once')`,
      [escrow.id, quote.depositDue],
    ),
    /ledger_entries_stripe_ref_key/,
  );
});

test("the ledger cannot be edited or erased, even by a direct statement", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));
  const quote = quoteBooking(100_000);
  const escrow = await store.escrows.create(
    createEscrow({ id: randomUUID(), gigId: gig.id, hostId: host.id, vendorId: vendor.id, quote }),
  );
  recordDeposit(escrow, quote.depositDue, "pi_fixed");
  await store.escrows.save(escrow);

  await assert.rejects(
    () => db.query(`UPDATE ledger_entries SET amount_cents = 1 WHERE escrow_id = $1`, [escrow.id]),
    /append-only/,
  );
  await assert.rejects(
    () => db.query(`DELETE FROM ledger_entries WHERE escrow_id = $1`, [escrow.id]),
    /append-only/,
  );
});

test("an unbalanced quote is refused by a check constraint", { skip }, async () => {
  const host = aUser();
  const vendor = aUser({ roles: ["crew"] });
  await store.users.create(host);
  await store.users.create(vendor);
  const gig = await store.gigs.create(aGig(host.id));

  const quote = quoteBooking(100_000);
  const tampered = { ...quote, platformRevenue: quote.platformRevenue + 1 };
  await assert.rejects(
    () => store.escrows.create(
      createEscrow({ id: randomUUID(), gigId: gig.id, hostId: host.id, vendorId: vendor.id, quote: tampered }),
    ),
    /escrow_payout_split_balances/,
    "the database must not accept a split that does not balance",
  );
});

test("a failed unit of work leaves nothing behind", { skip }, async () => {
  const host = aUser();
  await store.users.create(host);
  const before = await store.gigs.byHost(host.id);
  assert.equal(before.length, 0);

  await assert.rejects(() =>
    db.withTransaction(async (tx) => {
      const scoped = createPostgresStore(tx);
      await scoped.gigs.create(aGig(host.id));
      throw new Error("something went wrong after the insert");
    }),
  );

  const after = await store.gigs.byHost(host.id);
  assert.equal(after.length, 0, "a rolled-back transaction left a gig behind");
});

test("credentials round-trip without the password ever being readable as plaintext", { skip }, async () => {
  const user = aUser();
  await store.users.create(user);
  await store.credentials.put({
    userId: user.id,
    passwordHash: "scrypt$131072$8$1$c2FsdA==$aGFzaA==",
    failedAttempts: 2,
    otpHash: "abc123",
    otpExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const loaded = await store.credentials.byUserId(user.id);
  assert.equal(loaded?.failedAttempts, 2);
  assert.equal(loaded?.otpHash, "abc123");
  assert.ok(loaded?.passwordHash.startsWith("scrypt$"));
});
