/**
 * The escrow ledger.
 *
 * Design rule, without exception: no card data ever reaches this service. The
 * client collects payment details directly against Stripe with a client-side
 * confirmation token, and this module only ever handles Stripe object IDs and
 * integer cents. That is what keeps the platform out of PCI-DSS scope beyond
 * SAQ-A, and it is why `PaymentIntent` appears here only as an opaque id.
 *
 * The ledger is append-only. Balances are derived by folding entries, never
 * stored as a mutable column, so a partial failure mid-release can be replayed
 * rather than reconciled by hand.
 */
import { assertCents, splitRefund, type Cents, type Quote } from "./money.js";

export const ESCROW_STATES = [
  "Initiated",
  "AwaitingDeposit",
  "DepositHeld",
  "FullyFunded",
  "ReleasePending",
  "Released",
  "PartiallyRefunded",
  "Refunded",
  "Disputed",
] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export type LedgerEntryType =
  | "deposit_captured"
  | "balance_captured"
  | "refund_issued"
  | "payout_released"
  | "commission_taken"
  | "dispute_hold"
  | "dispute_released";

export interface LedgerEntry {
  readonly id: string;
  readonly type: LedgerEntryType;
  /** Positive: into the vault. Negative: out of it. */
  readonly amountCents: number;
  /** Stripe object this entry corresponds to, for reconciliation. */
  readonly stripeRef?: string;
  readonly at: string;
  readonly note?: string;
}

export interface Escrow {
  readonly id: string;
  readonly gigId: string;
  readonly hostId: string;
  readonly vendorId: string;
  readonly quote: Quote;
  state: EscrowState;
  /** Ties every PaymentIntent and Transfer for this booking together in Stripe. */
  readonly transferGroup: string;
  depositIntentId?: string;
  balanceIntentId?: string;
  transferId?: string;
  readonly entries: LedgerEntry[];
  readonly createdAt: string;
  updatedAt: string;
}

export class EscrowError extends Error {
  readonly code: string;
  constructor(message: string, code = "escrow_error") {
    super(message);
    this.name = "EscrowError";
    this.code = code;
  }
}

/** Funds captured and still held, i.e. not yet refunded or released. */
export function heldCents(escrow: Escrow): Cents {
  return escrow.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}

export function capturedCents(escrow: Escrow): Cents {
  return escrow.entries
    .filter((entry) => entry.type === "deposit_captured" || entry.type === "balance_captured")
    .reduce((sum, entry) => sum + entry.amountCents, 0);
}

export function refundedCents(escrow: Escrow): Cents {
  return -escrow.entries
    .filter((entry) => entry.type === "refund_issued")
    .reduce((sum, entry) => sum + entry.amountCents, 0);
}

export function createEscrow(input: {
  id: string;
  gigId: string;
  hostId: string;
  vendorId: string;
  quote: Quote;
  now?: Date;
}): Escrow {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: input.id,
    gigId: input.gigId,
    hostId: input.hostId,
    vendorId: input.vendorId,
    quote: input.quote,
    state: "AwaitingDeposit",
    transferGroup: `gig_${input.gigId}`,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

function append(escrow: Escrow, entry: Omit<LedgerEntry, "id" | "at">, now: Date): LedgerEntry {
  const record: LedgerEntry = {
    id: `le_${escrow.entries.length + 1}_${escrow.id}`,
    at: now.toISOString(),
    ...entry,
  };
  escrow.entries.push(record);
  escrow.updatedAt = record.at;
  return record;
}

/**
 * Record a captured deposit.
 *
 * Called from the Stripe webhook handler on `payment_intent.succeeded`, never
 * from the client. A client that reports its own payment succeeded is a client
 * that can report a payment that did not happen.
 */
export function recordDeposit(
  escrow: Escrow,
  amountCents: Cents,
  paymentIntentId: string,
  now: Date = new Date(),
): Escrow {
  assertCents(amountCents, "deposit");
  // Stripe retries webhooks, and a retry must be a silent no-op rather than an
  // error: this check comes first so a duplicate delivery for an escrow that
  // has already moved on is not mistaken for an out-of-order capture.
  if (escrow.entries.some((entry) => entry.stripeRef === paymentIntentId)) {
    return escrow;
  }
  if (escrow.state !== "AwaitingDeposit") {
    throw new EscrowError(`deposit cannot be recorded while escrow is ${escrow.state}`, "bad_state");
  }
  if (amountCents < escrow.quote.depositDue) {
    throw new EscrowError(
      `deposit of ${amountCents} is short of the ${escrow.quote.depositDue} required`,
      "underfunded",
    );
  }
  escrow.depositIntentId = paymentIntentId;
  append(escrow, { type: "deposit_captured", amountCents, stripeRef: paymentIntentId }, now);
  escrow.state = capturedCents(escrow) >= escrow.quote.hostTotal ? "FullyFunded" : "DepositHeld";
  return escrow;
}

export function recordBalance(
  escrow: Escrow,
  amountCents: Cents,
  paymentIntentId: string,
  now: Date = new Date(),
): Escrow {
  assertCents(amountCents, "balance");
  if (escrow.entries.some((entry) => entry.stripeRef === paymentIntentId)) {
    return escrow;
  }
  if (escrow.state !== "DepositHeld") {
    throw new EscrowError(`balance cannot be recorded while escrow is ${escrow.state}`, "bad_state");
  }
  escrow.balanceIntentId = paymentIntentId;
  append(escrow, { type: "balance_captured", amountCents, stripeRef: paymentIntentId }, now);
  if (capturedCents(escrow) < escrow.quote.hostTotal) {
    throw new EscrowError("balance capture does not bring the escrow to fully funded", "underfunded");
  }
  escrow.state = "FullyFunded";
  return escrow;
}

/**
 * Release funds to the vendor.
 *
 * Two independent conditions must both hold, which is the "multi-sig" property
 * in the blueprint: the gig must be in DeliveryPending or later, and either the
 * host has signed off or the auto-release window has elapsed. Neither the host
 * alone nor a timer alone can move money.
 */
export function release(
  escrow: Escrow,
  approval: { hostSignedOff: boolean; autoReleaseElapsed: boolean; deliveryConfirmed: boolean },
  transferId: string,
  now: Date = new Date(),
): Escrow {
  // A retried release must not pay twice, and must not raise either: the
  // scheduler and a host's sign-off can race on the same escrow.
  if (escrow.transferId) return escrow;
  if (escrow.state !== "FullyFunded" && escrow.state !== "ReleasePending") {
    throw new EscrowError(`cannot release from ${escrow.state}`, "bad_state");
  }
  if (!approval.deliveryConfirmed) {
    throw new EscrowError("the vendor has not marked the service delivered", "not_delivered");
  }
  if (!approval.hostSignedOff && !approval.autoReleaseElapsed) {
    throw new EscrowError("awaiting host sign-off or the auto-release window", "not_approved");
  }
  const payout = escrow.quote.vendorPayout;
  const commission = escrow.quote.platformRevenue;
  escrow.transferId = transferId;
  append(escrow, { type: "payout_released", amountCents: -payout, stripeRef: transferId }, now);
  append(escrow, { type: "commission_taken", amountCents: -commission, note: "platform fee" }, now);
  escrow.state = "Released";
  return escrow;
}

/** Refund the host, in whole or in part, per the cancellation tier. */
export function refund(
  escrow: Escrow,
  amountCents: Cents,
  stripeRefundId: string,
  now: Date = new Date(),
): Escrow {
  assertCents(amountCents, "refund");
  if (escrow.state === "Released") {
    throw new EscrowError("funds have already been released to the vendor", "already_released");
  }
  if (escrow.entries.some((entry) => entry.stripeRef === stripeRefundId)) {
    return escrow;
  }
  const available = heldCents(escrow);
  if (amountCents > available) {
    throw new EscrowError(`refund of ${amountCents} exceeds the ${available} held`, "insufficient_funds");
  }
  append(escrow, { type: "refund_issued", amountCents: -amountCents, stripeRef: stripeRefundId }, now);
  escrow.state = heldCents(escrow) === 0 ? "Refunded" : "PartiallyRefunded";
  return escrow;
}

/** Which Stripe intents a refund has to be split across. */
export function planRefund(escrow: Escrow, amountCents: Cents): {
  fromDeposit: Cents;
  fromBalance: Cents;
  depositIntentId?: string;
  balanceIntentId?: string;
} {
  const split = splitRefund(escrow.quote, amountCents);
  return {
    ...split,
    ...(escrow.depositIntentId ? { depositIntentId: escrow.depositIntentId } : {}),
    ...(escrow.balanceIntentId ? { balanceIntentId: escrow.balanceIntentId } : {}),
  };
}

export function openDispute(escrow: Escrow, reason: string, now: Date = new Date()): Escrow {
  if (escrow.state === "Released" || escrow.state === "Refunded") {
    throw new EscrowError(`cannot dispute a ${escrow.state} escrow`, "bad_state");
  }
  append(escrow, { type: "dispute_hold", amountCents: 0, note: reason }, now);
  escrow.state = "Disputed";
  return escrow;
}

/**
 * Resolve a dispute by splitting the held funds. The two amounts must account
 * for every held cent, so a resolution can never quietly lose money.
 */
export function resolveDispute(
  escrow: Escrow,
  outcome: { toVendorCents: Cents; toHostCents: Cents; stripeRefs: { transferId?: string; refundId?: string } },
  now: Date = new Date(),
): Escrow {
  if (escrow.state !== "Disputed") {
    throw new EscrowError("escrow is not under dispute", "bad_state");
  }
  assertCents(outcome.toVendorCents, "toVendorCents");
  assertCents(outcome.toHostCents, "toHostCents");
  const held = heldCents(escrow);
  if (outcome.toVendorCents + outcome.toHostCents !== held) {
    throw new EscrowError(
      `resolution splits ${outcome.toVendorCents + outcome.toHostCents} but ${held} is held`,
      "unbalanced",
    );
  }
  if (outcome.toHostCents > 0) {
    append(
      escrow,
      {
        type: "refund_issued",
        amountCents: -outcome.toHostCents,
        ...(outcome.stripeRefs.refundId ? { stripeRef: outcome.stripeRefs.refundId } : {}),
        note: "dispute resolution",
      },
      now,
    );
  }
  if (outcome.toVendorCents > 0) {
    append(
      escrow,
      {
        type: "dispute_released",
        amountCents: -outcome.toVendorCents,
        ...(outcome.stripeRefs.transferId ? { stripeRef: outcome.stripeRefs.transferId } : {}),
        note: "dispute resolution",
      },
      now,
    );
  }
  escrow.state = outcome.toVendorCents > 0 ? "Released" : "Refunded";
  return escrow;
}

/** States in which money is legitimately allowed to have left the vault. */
const OUTFLOW_STATES: readonly EscrowState[] = ["Released", "PartiallyRefunded", "Refunded", "Disputed"];

/**
 * The invariants the nightly reconciliation job asserts. If any of these fail
 * the job pages, because the alternative is discovering it at month end.
 *
 * Note that "captured minus outflow equals held" is NOT one of them: held is
 * defined as the fold of the entries, so that identity is true by construction
 * and would check nothing. What is worth checking is that the ledger and the
 * state agree, and that neither has drifted from the quote the parties signed.
 */
export function assertLedgerBalances(escrow: Escrow): void {
  const captured = capturedCents(escrow);
  const held = heldCents(escrow);
  const outflow = -escrow.entries
    .filter((entry) => entry.amountCents < 0)
    .reduce((sum, entry) => sum + entry.amountCents, 0);

  const fail = (message: string): never => {
    throw new EscrowError(`ledger does not balance for ${escrow.id}: ${message}`, "unbalanced");
  };

  // The vault can never owe money.
  if (held < 0) fail(`held is negative (${held})`);

  // Nothing may leave that never arrived.
  if (outflow > captured) fail(`outflow ${outflow} exceeds the ${captured} captured`);

  // No more may be collected than the host agreed to.
  if (captured > escrow.quote.hostTotal) {
    fail(`captured ${captured} exceeds the quoted total ${escrow.quote.hostTotal}`);
  }

  // The state and the ledger must tell the same story. A payout entry against
  // an escrow still marked FullyFunded is exactly the shape a bug -- or a
  // tampered row -- would take, and it is invisible to a fold-based check.
  if (outflow > 0 && !OUTFLOW_STATES.includes(escrow.state)) {
    fail(`${outflow} has left the vault while the escrow is still ${escrow.state}`);
  }
  if (escrow.state === "Released" && held !== 0) {
    fail(`a released escrow still holds ${held}`);
  }
  if (escrow.state === "Refunded" && held !== 0) {
    fail(`a refunded escrow still holds ${held}`);
  }
  if (escrow.state === "FullyFunded" && captured !== escrow.quote.hostTotal) {
    fail(`a fully funded escrow has captured ${captured} of ${escrow.quote.hostTotal}`);
  }
}
