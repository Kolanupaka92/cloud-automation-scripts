import test from "node:test";
import assert from "node:assert/strict";
import {
  GIG_STATES,
  TRANSITIONS,
  allowedTransitions,
  canTransition,
  refundFraction,
  transition,
  TransitionError,
  type Gig,
} from "../src/domain/gig.js";

function draft(overrides: Partial<Gig> = {}): Gig {
  const now = new Date("2026-01-01T00:00:00Z").toISOString();
  return {
    id: "gig_1",
    hostId: "usr_host",
    state: "Draft",
    brief: {
      eventType: "half_saree_function",
      specialty: "mua",
      eventDate: "2026-06-20",
      venue: { lat: 33.1507, lng: -96.8236 },
      metroId: "dfw",
      budgetMinCents: 40_000,
      budgetMaxCents: 90_000,
      culturalTags: ["telugu_traditional"],
      languages: ["telugu"],
    },
    applicationCount: 0,
    createdAt: now,
    updatedAt: now,
    history: [],
    ...overrides,
  };
}

test("every transition names states that exist", () => {
  for (const edge of TRANSITIONS) {
    assert.ok(GIG_STATES.includes(edge.from), `unknown from-state ${edge.from}`);
    assert.ok(GIG_STATES.includes(edge.to), `unknown to-state ${edge.to}`);
    assert.ok(edge.actors.length > 0, `${edge.from}>${edge.to} has no permitted actor`);
  }
});

test("terminal states have no outgoing transitions", () => {
  for (const state of ["Completed", "Cancelled"] as const) {
    assert.equal(
      TRANSITIONS.filter((edge) => edge.from === state).length,
      0,
      `${state} should be terminal`,
    );
  }
});

test("every non-terminal state is reachable from Draft", () => {
  const seen = new Set(["Draft"]);
  const queue = ["Draft"];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of TRANSITIONS.filter((candidate) => candidate.from === current)) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const state of GIG_STATES) {
    assert.ok(seen.has(state), `${state} is unreachable from Draft`);
  }
});

test("an incomplete brief cannot be published", () => {
  const gig = draft();
  gig.brief = { ...gig.brief, eventDate: "" };
  assert.throws(() => transition(gig, "Open", "host", "usr_host"), TransitionError);
  assert.equal(gig.state, "Draft", "a rejected transition must leave no trace");
  assert.equal(gig.history.length, 0);
});

test("a gig cannot be confirmed until the deposit has actually cleared", () => {
  const gig = draft({ state: "ApplicationsReview", applicationCount: 2, acceptedOfferId: "app_1" });

  assert.throws(
    () => transition(gig, "EscrowLocked", "host", "usr_host", { depositFunded: false }),
    /deposit has not cleared/,
  );
  assert.equal(gig.state, "ApplicationsReview");

  transition(gig, "EscrowLocked", "host", "usr_host", { depositFunded: true });
  assert.equal(gig.state, "EscrowLocked");
});

test("a gig cannot be confirmed with no accepted offer", () => {
  const gig = draft({ state: "ApplicationsReview", applicationCount: 1 });
  assert.throws(
    () => transition(gig, "EscrowLocked", "host", "usr_host", { depositFunded: true }),
    /no offer has been accepted/,
  );
});

test("a vendor cannot cancel a gig out from under a host mid-travel", () => {
  const gig = draft({ state: "InTransit" });
  assert.throws(
    () => transition(gig, "Cancelled", "vendor", "usr_vendor"),
    /may not move a gig/,
  );
  // Admin override exists precisely for this case.
  transition(gig, "Cancelled", "admin", "usr_admin");
  assert.equal(gig.state, "Cancelled");
});

test("a cancellation with funds held demands a reason", () => {
  const gig = draft({ state: "EscrowLocked" });
  assert.throws(() => transition(gig, "Cancelled", "host", "usr_host"), /cancellation reason is required/);
  transition(gig, "Cancelled", "host", "usr_host", { cancellationReason: "venue changed" });
  assert.equal(gig.state, "Cancelled");
  assert.equal(gig.cancellationReason, "venue changed");
});

test("a vendor cannot set off days before the event", () => {
  const gig = draft({ state: "EscrowLocked" });
  assert.throws(
    () => transition(gig, "InTransit", "vendor", "usr_vendor", { hoursUntilEvent: 120 }),
    /too early to travel/,
  );
  transition(gig, "InTransit", "vendor", "usr_vendor", { hoursUntilEvent: 6 });
  assert.equal(gig.state, "InTransit");
});

test("a reopened gig cannot skip past an accepted offer", () => {
  const gig = draft({ state: "ApplicationsReview", applicationCount: 3, acceptedOfferId: "app_7" });
  assert.throws(() => transition(gig, "Open", "host", "usr_host"), /already been accepted/);
});

test("the happy path runs end to end and records every hop", () => {
  const gig = draft();
  transition(gig, "Open", "host", "usr_host");
  gig.applicationCount = 3;
  transition(gig, "ApplicationsReview", "host", "usr_host");
  gig.acceptedOfferId = "app_1";
  transition(gig, "EscrowLocked", "host", "usr_host", { depositFunded: true });
  transition(gig, "InTransit", "vendor", "usr_vendor", { hoursUntilEvent: 4 });
  transition(gig, "Active", "vendor", "usr_vendor", { checkedInAtVenue: true });
  transition(gig, "DeliveryPending", "vendor", "usr_vendor");
  transition(gig, "Completed", "host", "usr_host");

  assert.equal(gig.state, "Completed");
  assert.equal(gig.history.length, 7);
  assert.deepEqual(
    gig.history.map((record) => record.to),
    ["Open", "ApplicationsReview", "EscrowLocked", "InTransit", "Active", "DeliveryPending", "Completed"],
  );
});

test("allowedTransitions is scoped to the asking actor", () => {
  assert.deepEqual(allowedTransitions("Active", "vendor"), ["DeliveryPending", "Disputed"]);
  assert.deepEqual(allowedTransitions("Active", "host"), ["Disputed"]);
  assert.equal(canTransition("Active", "Completed", "vendor"), false);
});

test("refund tiers favour the host the earlier they cancel, and always against a vendor drop-out", () => {
  assert.equal(refundFraction(45 * 24, "host"), 1);
  assert.equal(refundFraction(20 * 24, "host"), 0.75);
  assert.equal(refundFraction(10 * 24, "host"), 0.5);
  assert.equal(refundFraction(72, "host"), 0.25);
  assert.equal(refundFraction(6, "host"), 0);
  // A vendor who ghosts refunds the family in full, however late.
  assert.equal(refundFraction(2, "vendor"), 1);
});
