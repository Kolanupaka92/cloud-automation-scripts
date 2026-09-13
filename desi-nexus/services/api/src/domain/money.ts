/**
 * Money is integer cents everywhere. Floats are never used for an amount that
 * will be moved through Stripe, because a half-cent of drift in a fee split
 * becomes a ledger that does not balance.
 */

export type Cents = number;

export class MoneyError extends Error {}

export function assertCents(value: unknown, label = "amount"): Cents {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of cents`);
  }
  if (value < 0) throw new MoneyError(`${label} must not be negative`);
  if (value > 100_000_000) throw new MoneyError(`${label} exceeds the per-transaction ceiling`);
  return value;
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Round half-up, which is what a customer expects when they check the maths. */
export function applyRate(base: Cents, rate: number): Cents {
  if (!(rate >= 0 && rate <= 1)) throw new MoneyError("rate must be between 0 and 1");
  return Math.round(base * rate);
}

export interface FeeSchedule {
  /** Platform commission withheld from the vendor's payout. */
  readonly platformRateVendor: number;
  /** Booking fee added on top of the host's charge. */
  readonly platformRateHost: number;
  /** Share of the total taken up front to lock the booking. */
  readonly depositRate: number;
  /** Floor for the platform's cut, so small gigs still cover processing. */
  readonly minPlatformFee: Cents;
}

export const DEFAULT_FEES: FeeSchedule = {
  platformRateVendor: 0.12,
  platformRateHost: 0.05,
  depositRate: 0.3,
  minPlatformFee: 500,
};

export interface Quote {
  /** Agreed service price before travel and fees. */
  readonly serviceSubtotal: Cents;
  /** Distance-derived travel charge; passed through to the vendor in full. */
  readonly travelFee: Cents;
  /** Booking fee added to the host's charge. */
  readonly hostServiceFee: Cents;
  /** What the host is charged in total. */
  readonly hostTotal: Cents;
  /** Taken now to move the gig into escrow. */
  readonly depositDue: Cents;
  /** Charged on completion. */
  readonly balanceDue: Cents;
  /** Commission withheld from the vendor. */
  readonly vendorCommission: Cents;
  /** What the vendor receives on release. */
  readonly vendorPayout: Cents;
  /** Total platform revenue on the booking. */
  readonly platformRevenue: Cents;
}

/**
 * Build the full money breakdown for a booking.
 *
 * The identity that must always hold, and that the tests assert:
 *   hostTotal === vendorPayout + platformRevenue
 *   hostTotal === depositDue + balanceDue
 */
export function quoteBooking(
  serviceSubtotal: Cents,
  travelFee: Cents = 0,
  fees: FeeSchedule = DEFAULT_FEES,
): Quote {
  assertCents(serviceSubtotal, "serviceSubtotal");
  assertCents(travelFee, "travelFee");

  const billable = serviceSubtotal + travelFee;
  const hostServiceFee = applyRate(billable, fees.platformRateHost);
  const hostTotal = billable + hostServiceFee;

  // Commission is charged on the service only. Billing commission on mileage
  // pushes vendors to quote travel off-platform, which is exactly the leakage
  // the escrow is there to prevent.
  const rawCommission = applyRate(serviceSubtotal, fees.platformRateVendor);
  const vendorCommission = Math.min(
    serviceSubtotal,
    Math.max(rawCommission, fees.minPlatformFee),
  );
  const vendorPayout = billable - vendorCommission;
  const platformRevenue = hostTotal - vendorPayout;

  const depositDue = Math.min(hostTotal, applyRate(hostTotal, fees.depositRate));
  const balanceDue = hostTotal - depositDue;

  return {
    serviceSubtotal,
    travelFee,
    hostServiceFee,
    hostTotal,
    depositDue,
    balanceDue,
    vendorCommission,
    vendorPayout,
    platformRevenue,
  };
}

/**
 * Split a refund across the deposit and balance legs in the order the money was
 * captured, so each Stripe PaymentIntent is refunded for an amount it actually
 * holds.
 */
export function splitRefund(quote: Quote, refund: Cents): { fromDeposit: Cents; fromBalance: Cents } {
  assertCents(refund, "refund");
  if (refund > quote.hostTotal) throw new MoneyError("refund exceeds the amount charged");
  const fromBalance = Math.min(refund, quote.balanceDue);
  return { fromDeposit: refund - fromBalance, fromBalance };
}
