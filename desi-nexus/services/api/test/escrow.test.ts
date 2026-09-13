import test from "node:test";
import assert from "node:assert/strict";
import { quoteBooking } from "../src/domain/money.js";
import {
  assertLedgerBalances,
  capturedCents,
  createEscrow,
  EscrowError,
  heldCents,
  openDispute,
  planRefund,
  recordBalance,
  recordDeposit,
  refund,
  release,
  resolveDispute,
} from "../src/domain/escrow.js";

const quote = quoteBooking(100_000, 12_000);

function funded() {
  const escrow = createEscrow({
    id: "esc_1",
    gigId: "gig_1",
    hostId: "usr_host",
    vendorId: "usr_vendor",
    quote,
  });
  recordDeposit(escrow, quote.depositDue, "pi_deposit");
  recordBalance(escrow, quote.balanceDue, "pi_balance");
  return escrow;
}

test("a new escrow starts empty and awaiting the deposit", () => {
  const escrow = createEscrow({ id: "esc_0", gigId: "gig_0", hostId: "h", vendorId: "v", quote });
  assert.equal(escrow.state, "AwaitingDeposit");
  assert.equal(heldCents(escrow), 0);
  assert.equal(escrow.transferGroup, "gig_gig_0");
});

test("a short deposit is refused", () => {
  const escrow = createEscrow({ id: "esc_2", gigId: "gig_2", hostId: "h", vendorId: "v", quote });
  assert.throws(() => recordDeposit(escrow, quote.depositDue - 1, "pi_x"), EscrowError);
  assert.equal(escrow.state, "AwaitingDeposit");
});

test("a replayed webhook does not book the same payment twice", () => {
  const escrow = createEscrow({ id: "esc_3", gigId: "gig_3", hostId: "h", vendorId: "v", quote });
  recordDeposit(escrow, quote.depositDue, "pi_same");
  recordDeposit(escrow, quote.depositDue, "pi_same");
  recordDeposit(escrow, quote.depositDue, "pi_same");
  assert.equal(escrow.entries.length, 1);
  assert.equal(heldCents(escrow), quote.depositDue);
});

test("the full charge arrives in two legs and reaches fully funded", () => {
  const escrow = funded();
  assert.equal(escrow.state, "FullyFunded");
  assert.equal(capturedCents(escrow), quote.hostTotal);
  assert.equal(heldCents(escrow), quote.hostTotal);
  assertLedgerBalances(escrow);
});

test("funds cannot be released before the vendor marks delivery", () => {
  const escrow = funded();
  assert.throws(
    () => release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: false }, "tr_1"),
    /not marked the service delivered/,
  );
  assert.equal(escrow.state, "FullyFunded");
});

test("delivery alone does not release funds: a host sign-off or the timer is also needed", () => {
  const escrow = funded();
  assert.throws(
    () => release(escrow, { hostSignedOff: false, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_1"),
    /awaiting host sign-off/,
  );
  assert.equal(escrow.state, "FullyFunded");
});

test("the auto-release timer releases a host who simply went quiet", () => {
  const escrow = funded();
  release(escrow, { hostSignedOff: false, autoReleaseElapsed: true, deliveryConfirmed: true }, "tr_auto");
  assert.equal(escrow.state, "Released");
  assert.equal(escrow.transferId, "tr_auto");
});

test("a release pays the vendor and takes the fee, leaving the vault empty and balanced", () => {
  const escrow = funded();
  release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_2");

  assert.equal(escrow.state, "Released");
  assert.equal(heldCents(escrow), 0, "a released escrow holds nothing");
  assertLedgerBalances(escrow);

  const payout = escrow.entries.find((entry) => entry.type === "payout_released");
  const commission = escrow.entries.find((entry) => entry.type === "commission_taken");
  assert.equal(payout?.amountCents, -quote.vendorPayout);
  assert.equal(commission?.amountCents, -quote.platformRevenue);
});

test("a repeated release does not pay the vendor twice", () => {
  const escrow = funded();
  release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_3");
  const entries = escrow.entries.length;
  release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_4");
  assert.equal(escrow.entries.length, entries, "a second release must be a no-op");
  assert.equal(escrow.transferId, "tr_3");
});

test("money already paid out cannot then be refunded", () => {
  const escrow = funded();
  release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_5");
  assert.throws(() => refund(escrow, 1_000, "re_1"), /already been released/);
});

test("a refund cannot exceed what is actually held", () => {
  const escrow = createEscrow({ id: "esc_4", gigId: "gig_4", hostId: "h", vendorId: "v", quote });
  recordDeposit(escrow, quote.depositDue, "pi_d");
  assert.throws(() => refund(escrow, quote.hostTotal, "re_2"), /exceeds/);
  assert.equal(heldCents(escrow), quote.depositDue);
});

test("a partial refund leaves the remainder held and the ledger balanced", () => {
  const escrow = funded();
  refund(escrow, 20_000, "re_3");
  assert.equal(escrow.state, "PartiallyRefunded");
  assert.equal(heldCents(escrow), quote.hostTotal - 20_000);
  assertLedgerBalances(escrow);
});

test("a full refund empties the vault", () => {
  const escrow = funded();
  refund(escrow, quote.hostTotal, "re_4");
  assert.equal(escrow.state, "Refunded");
  assert.equal(heldCents(escrow), 0);
  assertLedgerBalances(escrow);
});

test("a refund plan names the Stripe intents it has to be drawn from", () => {
  const escrow = funded();
  const plan = planRefund(escrow, quote.hostTotal);
  assert.equal(plan.depositIntentId, "pi_deposit");
  assert.equal(plan.balanceIntentId, "pi_balance");
  assert.equal(plan.fromDeposit + plan.fromBalance, quote.hostTotal);
});

test("a dispute resolution must account for every held cent", () => {
  const escrow = funded();
  openDispute(escrow, "the photographer left after two hours");
  assert.equal(escrow.state, "Disputed");

  assert.throws(
    () => resolveDispute(escrow, { toVendorCents: 1_000, toHostCents: 1_000, stripeRefs: {} }),
    /but .* is held/,
  );

  const held = heldCents(escrow);
  const toVendor = Math.floor(held / 2);
  resolveDispute(escrow, {
    toVendorCents: toVendor,
    toHostCents: held - toVendor,
    stripeRefs: { transferId: "tr_d", refundId: "re_d" },
  });
  assert.equal(heldCents(escrow), 0);
  assertLedgerBalances(escrow);
});

test("a released escrow cannot be disputed after the fact", () => {
  const escrow = funded();
  release(escrow, { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true }, "tr_6");
  assert.throws(() => openDispute(escrow, "too late"), /cannot dispute/);
});

test("the nightly reconciliation catches a payout the state does not account for", () => {
  const escrow = funded();
  assertLedgerBalances(escrow);
  // Money leaving an escrow still marked FullyFunded is the shape a bug or a
  // tampered row would take.
  escrow.entries.push({
    id: "le_rogue",
    type: "payout_released",
    amountCents: -50_000,
    at: new Date().toISOString(),
  });
  assert.throws(() => assertLedgerBalances(escrow), /still FullyFunded/);
});

test("the reconciliation catches a vault that has paid out more than it took", () => {
  const escrow = funded();
  escrow.state = "Released";
  escrow.entries.push({
    id: "le_overdraft",
    type: "payout_released",
    amountCents: -(quote.hostTotal * 2),
    at: new Date().toISOString(),
  });
  // Caught by the negative-held check, which fires first on an overdraft.
  assert.throws(() => assertLedgerBalances(escrow), /held is negative/);
});

test("the reconciliation catches over-collection against the agreed quote", () => {
  const escrow = funded();
  escrow.entries.push({
    id: "le_extra",
    type: "balance_captured",
    amountCents: 25_000,
    at: new Date().toISOString(),
  });
  assert.throws(() => assertLedgerBalances(escrow), /exceeds the quoted total/);
});

test("the reconciliation catches a released escrow that still holds funds", () => {
  const escrow = funded();
  escrow.state = "Released";
  assert.throws(() => assertLedgerBalances(escrow), /still holds/);
});
