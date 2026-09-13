/**
 * The Stripe boundary.
 *
 * Everything the platform does with Stripe goes through this interface, for two
 * reasons. First, it keeps the escrow logic testable without a network or a
 * test key. Second, it makes the PCI scope legible: this file is the complete
 * list of places money is touched, and none of them accept a card number.
 *
 * The live implementation is a thin fetch wrapper around the Stripe REST API;
 * the in-memory one below backs the tests and local development.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Cents } from "../../domain/money.js";

export interface CreateIntentInput {
  readonly amountCents: Cents;
  readonly transferGroup: string;
  /** The vendor's connected account, recorded now, transferred to on release. */
  readonly destinationAccountId: string;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, string>;
}

/**
 * Every status a Stripe PaymentIntent can hold. Narrowing this to the few the
 * fake produced would mean mapping a real `requires_action` onto something
 * else, and reporting a payment that has not happened.
 */
export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export interface PaymentIntentRef {
  readonly id: string;
  /** Returned to the client to confirm the payment against Stripe directly. */
  readonly clientSecretToken: string;
  readonly amountCents: Cents;
  /** Stripe's own PaymentIntent lifecycle, not a narrowed copy of it. */
  readonly status: PaymentIntentStatus;
}

export interface TransferRef {
  readonly id: string;
  readonly amountCents: Cents;
  readonly destinationAccountId: string;
}

export interface RefundRef {
  readonly id: string;
  readonly amountCents: Cents;
  readonly paymentIntentId: string;
}

export interface ConnectAccountRef {
  readonly id: string;
  readonly payoutsEnabled: boolean;
  readonly onboardingUrl?: string;
}

export interface StripeGateway {
  createConnectAccount(input: { userId: string; email: string }): Promise<ConnectAccountRef>;
  getConnectAccount(accountId: string): Promise<ConnectAccountRef>;
  createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentRef>;
  createTransfer(input: {
    amountCents: Cents;
    destinationAccountId: string;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<TransferRef>;
  createRefund(input: {
    paymentIntentId: string;
    amountCents: Cents;
    idempotencyKey: string;
  }): Promise<RefundRef>;
}

/**
 * Verify a Stripe webhook signature.
 *
 * Webhooks are the only channel trusted to say a payment succeeded, so this
 * check is the load-bearing one in the whole payment flow. The timestamp
 * tolerance defeats replay of a genuine old event.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
  now: Date = new Date(),
): boolean {
  const parts = new Map(
    signatureHeader.split(",").map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    }),
  );
  const timestamp = parts.get("t");
  const provided = parts.get("v1");
  if (!timestamp || !provided) return false;

  const age = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
