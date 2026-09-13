/**
 * The live Stripe gateway.
 *
 * Built on the official SDK rather than a hand-rolled REST client. A payments
 * integration is the last place to own every edge case yourself: the SDK tracks
 * API-version drift, retries safely against idempotency keys, and its types
 * follow the API. The narrow `StripeGateway` interface keeps that dependency
 * behind one file, so the domain and the routes never import it.
 *
 * The money model this implements is **separate charges and transfers**: the
 * host's payment lands in the platform's own balance -- the escrow vault -- and
 * a Transfer moves it to the vendor only when the release conditions are met.
 * That is why no PaymentIntent here carries `transfer_data`; setting it would
 * pay the vendor at capture time and there would be no escrow at all.
 */
import Stripe from "stripe";
import { assertCents } from "../../domain/money.js";
import type {
  ConnectAccountRef,
  CreateIntentInput,
  PaymentIntentRef,
  PaymentIntentStatus,
  RefundRef,
  StripeGateway,
  TransferRef,
} from "./index.js";

/**
 * Pinned deliberately. An unpinned integration silently adopts whatever
 * version Stripe makes current, which changes response shapes under a running
 * service. Bump it on purpose, with the changelog open.
 */
export const STRIPE_API_VERSION = "2024-06-20";

/** The platform is US-only for the Texas pilot; both sides settle in USD. */
export const CURRENCY = "usd";
const COUNTRY = "US";

export interface LiveStripeOptions {
  readonly apiKey: string;
  /** Where Stripe returns the vendor after Express onboarding. */
  readonly connectReturnUrl: string;
  /** Where Stripe sends them if the onboarding link has expired. */
  readonly connectRefreshUrl: string;
  readonly maxNetworkRetries?: number;
  readonly timeoutMs?: number;
  /** Test seam: point the SDK at a local server instead of Stripe. */
  readonly host?: string;
  readonly port?: number;
  readonly protocol?: "http" | "https";
}

export class StripeGatewayError extends Error {
  readonly code: string;
  /** True when the same call may succeed later; false when it never will. */
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(message: string, code: string, retryable: boolean, requestId?: string) {
    super(message);
    this.name = "StripeGatewayError";
    this.code = code;
    this.retryable = retryable;
    if (requestId) this.requestId = requestId;
  }
}

export class LiveStripeGateway implements StripeGateway {
  private readonly stripe: Stripe;

  constructor(private readonly options: LiveStripeOptions) {
    if (!options.apiKey) throw new Error("a Stripe API key is required");
    this.stripe = new Stripe(options.apiKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      // The SDK retries idempotently, which is safe precisely because every
      // mutating call below passes an idempotency key.
      maxNetworkRetries: options.maxNetworkRetries ?? 3,
      timeout: options.timeoutMs ?? 20_000,
      telemetry: false,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: options.port } : {}),
      ...(options.protocol ? { protocol: options.protocol } : {}),
    });
  }

  /**
   * Create an Express connected account and the onboarding link the vendor
   * completes. `transfers` is the capability that matters: without it a payout
   * cannot be made, which is why the booking path refuses a vendor whose
   * account is not yet enabled.
   */
  async createConnectAccount(input: { userId: string; email: string }): Promise<ConnectAccountRef> {
    return this.call("createConnectAccount", async () => {
      const account = await this.stripe.accounts.create(
        {
          type: "express",
          country: COUNTRY,
          email: input.email,
          capabilities: {
            transfers: { requested: true },
            card_payments: { requested: true },
          },
          business_profile: { product_description: "Event services on DESI-NEXUS" },
          // The platform's user id, so a Stripe-side event can be traced back.
          metadata: { userId: input.userId },
        },
        // Keyed on the user, so a double-submitted onboarding does not leave
        // one vendor holding two connected accounts.
        { idempotencyKey: `connect_account_${input.userId}` },
      );

      const link = await this.stripe.accountLinks.create({
        account: account.id,
        refresh_url: this.options.connectRefreshUrl,
        return_url: this.options.connectReturnUrl,
        type: "account_onboarding",
      });

      return {
        id: account.id,
        payoutsEnabled: account.payouts_enabled ?? false,
        onboardingUrl: link.url,
      };
    });
  }

  async getConnectAccount(accountId: string): Promise<ConnectAccountRef> {
    return this.call("getConnectAccount", async () => {
      const account = await this.stripe.accounts.retrieve(accountId);
      return {
        id: account.id,
        payoutsEnabled: account.payouts_enabled ?? false,
      };
    });
  }

  /**
   * Charge the host. Funds settle into the platform balance and stay there;
   * `transfer_group` is what later ties the release Transfer back to this
   * payment for reconciliation.
   */
  async createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentRef> {
    assertCents(input.amountCents, "amountCents");
    return this.call("createPaymentIntent", async () => {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: CURRENCY,
          transfer_group: input.transferGroup,
          automatic_payment_methods: { enabled: true },
          metadata: {
            ...input.metadata,
            // Recorded, not acted on: the transfer happens at release time.
            destinationAccountId: input.destinationAccountId,
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      const secret = intent.client_secret;
      if (!secret) {
        throw new StripeGatewayError(
          "Stripe returned a payment intent with no client secret",
          "missing_client_secret",
          false,
        );
      }
      return {
        id: intent.id,
        clientSecretToken: secret,
        amountCents: intent.amount,
        status: intent.status as PaymentIntentStatus,
      };
    });
  }

  /** Release: move held funds from the platform balance to the vendor. */
  async createTransfer(input: {
    amountCents: number;
    destinationAccountId: string;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<TransferRef> {
    assertCents(input.amountCents, "amountCents");
    return this.call("createTransfer", async () => {
      const transfer = await this.stripe.transfers.create(
        {
          amount: input.amountCents,
          currency: CURRENCY,
          destination: input.destinationAccountId,
          transfer_group: input.transferGroup,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        id: transfer.id,
        amountCents: transfer.amount,
        destinationAccountId: String(transfer.destination),
      };
    });
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<RefundRef> {
    assertCents(input.amountCents, "amountCents");
    return this.call("createRefund", async () => {
      const refund = await this.stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amountCents },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        id: refund.id,
        amountCents: refund.amount,
        paymentIntentId: String(refund.payment_intent ?? input.paymentIntentId),
      };
    });
  }

  /**
   * One place to turn a Stripe error into ours.
   *
   * The raw message is never allowed to reach a client: Stripe's copy is
   * written for the integrator, not the cardholder, and can name internal
   * details. The caller gets a code and a retryable flag; the detail goes to
   * the log with Stripe's request id, which is what support needs to trace it.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StripeGatewayError) throw error;
      const mapped = mapStripeError(error, operation);
      console.error(
        `[stripe] ${operation} failed: ${mapped.code}` +
          (mapped.requestId ? ` (request ${mapped.requestId})` : ""),
        error,
      );
      throw mapped;
    }
  }
}

/**
 * Which Stripe failures are worth trying again and which are final.
 *
 * Getting this wrong in either direction costs money: retrying a decline
 * annoys the cardholder and can trip fraud rules, while giving up on a
 * transient connection error strands funds mid-booking.
 *
 * The discriminator is `rawType` -- the wire vocabulary (`card_error`,
 * `rate_limit_error`) -- and not the error's class or its `type` field. In the
 * current SDK every error built from an API response comes back as a
 * `StripeAPIError` whatever the failure was, so `instanceof StripeCardError`
 * is false for a real decline and dispatching on the class silently sends
 * everything to the default branch. Errors raised locally rather than by the
 * API (a dropped socket, a client-side timeout) carry no `rawType` at all, and
 * those are the ones `type` identifies, so both are read here.
 */
export function mapStripeError(error: unknown, operation: string): StripeGatewayError {
  const candidate = error as { rawType?: string; type?: string; code?: string; requestId?: string };
  const requestId = typeof candidate?.requestId === "string" ? candidate.requestId : undefined;
  const wire = candidate?.rawType;
  const klass = candidate?.type;

  const build = (message: string, code: string, retryable: boolean) =>
    new StripeGatewayError(message, code, retryable, requestId);

  switch (wire) {
    case "card_error":
      return build("the payment method was declined", candidate.code ?? "card_declined", false);
    case "rate_limit_error":
      return build("Stripe is rate limiting this account", "rate_limited", true);
    case "api_error":
      return build("Stripe is temporarily unavailable", "stripe_unavailable", true);
    case "authentication_error":
      // Never retryable, and always an operator problem rather than a user one.
      return build("the Stripe API key was rejected", "stripe_auth_failed", false);
    case "idempotency_error":
      return build(
        "an idempotency key was reused with different parameters",
        "idempotency_conflict",
        false,
      );
    case "invalid_request_error":
      return build(`Stripe rejected the ${operation} request`, candidate.code ?? "invalid_request", false);
    default:
      break;
  }

  // No rawType: raised by the client rather than returned by the API.
  switch (klass) {
    case "StripeConnectionError":
      return build("could not reach Stripe", "stripe_unreachable", true);
    case "StripeAPIError":
      return build("Stripe is temporarily unavailable", "stripe_unavailable", true);
    case "StripeRateLimitError":
      return build("Stripe is rate limiting this account", "rate_limited", true);
    case "StripeCardError":
      return build("the payment method was declined", candidate.code ?? "card_declined", false);
    case "StripeAuthenticationError":
      return build("the Stripe API key was rejected", "stripe_auth_failed", false);
    case "StripeIdempotencyError":
      return build(
        "an idempotency key was reused with different parameters",
        "idempotency_conflict",
        false,
      );
    case "StripeInvalidRequestError":
      return build(`Stripe rejected the ${operation} request`, candidate.code ?? "invalid_request", false);
    default:
      return build(`${operation} failed`, "stripe_error", false);
  }
}

/**
 * Build the gateway from the environment. Called only when the service is
 * configured to use live payments; otherwise the fake is wired in.
 */
export function liveStripeFromEnv(env: NodeJS.ProcessEnv = process.env): LiveStripeGateway {
  const apiKey = env.STRIPE_API_KEY;
  if (!apiKey) throw new Error("STRIPE_API_KEY is not set");
  const base = env.DESI_NEXUS_PUBLIC_URL ?? "https://app.desi-nexus.example";
  return new LiveStripeGateway({
    apiKey,
    connectReturnUrl: env.STRIPE_CONNECT_RETURN_URL ?? `${base}/connect/complete`,
    connectRefreshUrl: env.STRIPE_CONNECT_REFRESH_URL ?? `${base}/connect/refresh`,
  });
}
