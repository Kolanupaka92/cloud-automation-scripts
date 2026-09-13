/**
 * The in-memory Stripe gateway used by tests and local development.
 *
 * It models the parts of Stripe the escrow depends on -- idempotency, the
 * account onboarding transition, and intents that only succeed when something
 * explicitly says so -- and nothing else.
 */
import { randomUUID } from "node:crypto";
import type {
  ConnectAccountRef,
  CreateIntentInput,
  PaymentIntentRef,
  RefundRef,
  StripeGateway,
  TransferRef,
} from "./index.js";
import type { Cents } from "../../domain/money.js";

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
