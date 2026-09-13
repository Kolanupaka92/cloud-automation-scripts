import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEES, formatUsd, quoteBooking, splitRefund, MoneyError, assertCents } from "../src/domain/money.js";

test("a quote balances: the host's total is exactly the payout plus platform revenue", () => {
  for (const subtotal of [5_000, 45_000, 120_000, 999_99, 1_234_567]) {
    for (const travel of [0, 4_500, 27_300]) {
      const quote = quoteBooking(subtotal, travel);
      assert.equal(
        quote.hostTotal,
        quote.vendorPayout + quote.platformRevenue,
        `payout split does not balance for ${subtotal}/${travel}`,
      );
      assert.equal(
        quote.hostTotal,
        quote.depositDue + quote.balanceDue,
        `deposit split does not balance for ${subtotal}/${travel}`,
      );
    }
  }
});

test("travel is passed through to the vendor rather than commissioned", () => {
  const withoutTravel = quoteBooking(100_000, 0);
  const withTravel = quoteBooking(100_000, 10_000);
  assert.equal(withTravel.vendorCommission, withoutTravel.vendorCommission);
  assert.equal(withTravel.vendorPayout - withoutTravel.vendorPayout, 10_000);
});

test("the minimum platform fee floors the commission on small gigs", () => {
  const quote = quoteBooking(2_000);
  assert.equal(quote.vendorCommission, DEFAULT_FEES.minPlatformFee);
  assert.ok(quote.vendorPayout > 0);
});

test("the commission never exceeds the service price", () => {
  const quote = quoteBooking(300);
  assert.ok(quote.vendorCommission <= 300);
  assert.ok(quote.vendorPayout >= 0);
});

test("a refund is drawn from the balance leg before the deposit leg", () => {
  const quote = quoteBooking(100_000, 5_000);
  const small = splitRefund(quote, 1_000);
  assert.equal(small.fromDeposit, 0);
  assert.equal(small.fromBalance, 1_000);

  const full = splitRefund(quote, quote.hostTotal);
  assert.equal(full.fromDeposit + full.fromBalance, quote.hostTotal);
  assert.equal(full.fromBalance, quote.balanceDue);
});

test("a refund larger than the charge is refused", () => {
  const quote = quoteBooking(50_000);
  assert.throws(() => splitRefund(quote, quote.hostTotal + 1), MoneyError);
});

test("non-integer and negative amounts are refused outright", () => {
  assert.throws(() => assertCents(10.5), MoneyError);
  assert.throws(() => assertCents(-1), MoneyError);
  assert.throws(() => assertCents("100" as never), MoneyError);
});

test("amounts format as dollars", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(5), "$0.05");
  assert.equal(formatUsd(123_456_7), "$12,345.67");
});
