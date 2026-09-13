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
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Cents } from "../domain/money.js";

export interface CreateIntentInput {
  readonly amountCents: Cents;
  readonly transferGroup: string;
  /** The vendor's connected account, recorded now, transferred to on release. */
  readonly destinationAccountId: string;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, string>;
}

export interface PaymentIntentRef {
  readonly id: string;
  /** Returned to the client to confirm the payment against Stripe directly. */
  readonly clientSecretToken: string;
  readonly amountCents: Cents;
  readonly status: "requires_payment_method" | "requires_capture" | "succeeded" | "canceled";
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

/** In-memory gateway for tests and local development. */
export class FakeStripeGateway implements StripeGateway {
  readonly intents = new Map<string, PaymentIntentRef>();
  readonly transfers: TransferRef[] = [];
  readonly refunds: RefundRef[] = [];
  readonly accounts = new Map<string, ConnectAccountRef>();
  private readonly seen = new Map<string, unknown>();

  async createConnectAccount(input: { userId: string; email: string }): Promise<ConnectAccountRef> {
    const account: ConnectAccountRef = {
      id: `acct_${input.userId}`,
      payoutsEnabled: false,
      onboardingUrl: `https://connect.stripe.test/onboard/${input.userId}`,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async getConnectAccount(accountId: string): Promise<ConnectAccountRef> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`no such connected account: ${accountId}`);
    return account;
  }

  /** Marks an account payouts-enabled, standing in for Stripe's verification. */
  completeOnboarding(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (account) this.accounts.set(accountId, { ...account, payoutsEnabled: true });
  }

  async createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentRef> {
    const cached = this.seen.get(input.idempotencyKey);
    if (cached) return cached as PaymentIntentRef;
    const intent: PaymentIntentRef = {
      id: `pi_${randomUUID().slice(0, 8)}`,
      clientSecretToken: `pi_secret_${randomUUID().slice(0, 8)}`,
      amountCents: input.amountCents,
      status: "requires_payment_method",
    };
    this.intents.set(intent.id, intent);
    this.seen.set(input.idempotencyKey, intent);
    return intent;
  }

  /** Stands in for the customer completing payment on the client. */
  succeed(intentId: string): PaymentIntentRef {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`no such intent: ${intentId}`);
    const updated: PaymentIntentRef = { ...intent, status: "succeeded" };
    this.intents.set(intentId, updated);
    return updated;
  }

  async createTransfer(input: {
    amountCents: Cents;
    destinationAccountId: string;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<TransferRef> {
    const cached = this.seen.get(input.idempotencyKey);
    if (cached) return cached as TransferRef;
    const transfer: TransferRef = {
      id: `tr_${randomUUID().slice(0, 8)}`,
      amountCents: input.amountCents,
      destinationAccountId: input.destinationAccountId,
    };
    this.transfers.push(transfer);
    this.seen.set(input.idempotencyKey, transfer);
    return transfer;
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountCents: Cents;
    idempotencyKey: string;
  }): Promise<RefundRef> {
    const cached = this.seen.get(input.idempotencyKey);
    if (cached) return cached as RefundRef;
    const refundRef: RefundRef = {
      id: `re_${randomUUID().slice(0, 8)}`,
      amountCents: input.amountCents,
      paymentIntentId: input.paymentIntentId,
    };
    this.refunds.push(refundRef);
    this.seen.set(input.idempotencyKey, refundRef);
    return refundRef;
  }
}
