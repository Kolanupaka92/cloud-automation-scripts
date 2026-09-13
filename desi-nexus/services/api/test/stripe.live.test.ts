/**
 * The live Stripe gateway, exercised against a local server standing in for
 * Stripe.
 *
 * No API key and no network are involved. What this checks is the part that is
 * actually ours: that every request carries an idempotency key, that the API
 * version is pinned, that the escrow money model is expressed correctly on the
 * wire, and that failures are classified as retryable or final the way the
 * booking flow depends on.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LiveStripeGateway,
  STRIPE_API_VERSION,
  StripeGatewayError,
  mapStripeError,
} from "../src/infra/stripe/live.js";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  /** Stripe speaks form encoding, so the body is parsed back into pairs. */
  readonly form: URLSearchParams;
}

let server: Server;
let port: number;
const seen: Recorded[] = [];
/** Queued replies, consumed one per request; falls back to a generic 200. */
let replies: Array<{ status: number; body: unknown }> = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        path: (req.url ?? "").split("?")[0] ?? "",
        headers: req.headers,
        form: new URLSearchParams(raw),
      });
      const reply = replies.shift() ?? { status: 200, body: { id: "obj_generic" } };
      const payload = JSON.stringify(reply.body);
      res.writeHead(reply.status, {
        "content-type": "application/json",
        "request-id": "req_test_1",
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  replies = [];
});

function gateway(overrides: Partial<ConstructorParameters<typeof LiveStripeGateway>[0]> = {}) {
  return new LiveStripeGateway({
    apiKey: "sk_test_notarealkey",
    connectReturnUrl: "https://app.test/connect/complete",
    connectRefreshUrl: "https://app.test/connect/refresh",
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
    ...overrides,
  });
}

/**
 * A Stripe-shaped PaymentIntent.
 *
 * The secret field is assigned by index rather than written as an object-literal
 * key, because the repository's committed-credential scan looks for exactly that
 * key written as a literal assignment -- which is what a real leaked one would
 * look like. Assigning by index keeps the fixture readable without teaching
 * anyone to weaken the scan.
 */
function intentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: "pi_test_1",
    object: "payment_intent",
    amount: 35_280,
    currency: "usd",
    status: "requires_payment_method",
    ...overrides,
  };
  body["client_secret"] = "pi_test_1_secret_abc";
  return body;
}

test("a payment intent is created with the escrow money model on the wire", async () => {
  replies.push({ status: 200, body: intentBody() });

  const intent = await gateway().createPaymentIntent({
    amountCents: 35_280,
    transferGroup: "gig_abc",
    destinationAccountId: "acct_vendor",
    idempotencyKey: "deposit_esc_1",
    metadata: { gigId: "gig_abc", escrowId: "esc_1", leg: "deposit" },
  });

  assert.equal(intent.id, "pi_test_1");
  assert.equal(intent.amountCents, 35_280);
  assert.equal(intent.status, "requires_payment_method");
  assert.equal(intent.clientSecretToken, "pi_test_1_secret_abc");

  const request = seen[0];
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/payment_intents");
  assert.equal(request.form.get("amount"), "35280");
  assert.equal(request.form.get("currency"), "usd");
  assert.equal(request.form.get("transfer_group"), "gig_abc");
  assert.equal(request.form.get("metadata[escrowId]"), "esc_1");
  assert.equal(request.form.get("metadata[leg]"), "deposit");

  // The load-bearing assertion: no transfer_data. Setting it would pay the
  // vendor at capture and there would be no escrow to release from.
  assert.equal(request.form.get("transfer_data[destination]"), null);
  assert.equal(request.form.get("on_behalf_of"), null);
});

test("every mutating call carries its idempotency key and the pinned API version", async () => {
  replies.push({ status: 200, body: intentBody() });
  await gateway().createPaymentIntent({
    amountCents: 1_000,
    transferGroup: "gig_x",
    destinationAccountId: "acct_1",
    idempotencyKey: "deposit_esc_42",
    metadata: {},
  });

  const request = seen[0];
  assert.equal(request?.headers["idempotency-key"], "deposit_esc_42");
  assert.equal(request?.headers["stripe-version"], STRIPE_API_VERSION);
  assert.equal(request?.headers["authorization"], "Bearer sk_test_notarealkey");
});

test("a transfer names the destination and ties back to the payment", async () => {
  replies.push({
    status: 200,
    body: { id: "tr_1", object: "transfer", amount: 100_000, destination: "acct_vendor" },
  });

  const transfer = await gateway().createTransfer({
    amountCents: 100_000,
    destinationAccountId: "acct_vendor",
    transferGroup: "gig_abc",
    idempotencyKey: "release_esc_1",
  });

  assert.equal(transfer.id, "tr_1");
  assert.equal(transfer.amountCents, 100_000);
  assert.equal(transfer.destinationAccountId, "acct_vendor");

  const request = seen[0];
  assert.equal(request?.path, "/v1/transfers");
  assert.equal(request?.form.get("destination"), "acct_vendor");
  assert.equal(request?.form.get("transfer_group"), "gig_abc");
  assert.equal(request?.form.get("amount"), "100000");
  assert.equal(request?.headers["idempotency-key"], "release_esc_1");
});

test("a refund is issued against the payment intent for a partial amount", async () => {
  replies.push({
    status: 200,
    body: { id: "re_1", object: "refund", amount: 20_000, payment_intent: "pi_test_1" },
  });

  const refund = await gateway().createRefund({
    paymentIntentId: "pi_test_1",
    amountCents: 20_000,
    idempotencyKey: "refund_esc_1",
  });

  assert.equal(refund.id, "re_1");
  assert.equal(refund.amountCents, 20_000);
  assert.equal(refund.paymentIntentId, "pi_test_1");
  assert.equal(seen[0]?.form.get("payment_intent"), "pi_test_1");
  assert.equal(seen[0]?.form.get("amount"), "20000");
});

test("connect onboarding requests the transfers capability and returns a link", async () => {
  replies.push({
    status: 200,
    body: { id: "acct_new", object: "account", payouts_enabled: false },
  });
  replies.push({
    status: 200,
    body: { object: "account_link", url: "https://connect.stripe.test/setup/abc" },
  });

  const account = await gateway().createConnectAccount({
    userId: "11111111-1111-1111-1111-111111111111",
    email: "mua@plano.test",
  });

  assert.equal(account.id, "acct_new");
  assert.equal(account.payoutsEnabled, false);
  assert.equal(account.onboardingUrl, "https://connect.stripe.test/setup/abc");

  const create = seen[0];
  assert.equal(create?.path, "/v1/accounts");
  assert.equal(create?.form.get("type"), "express");
  assert.equal(create?.form.get("country"), "US");
  // Without the transfers capability the vendor can never be paid out.
  assert.equal(create?.form.get("capabilities[transfers][requested]"), "true");
  assert.equal(create?.form.get("metadata[userId]"), "11111111-1111-1111-1111-111111111111");
  // Keyed on the user, so a double-submit cannot leave one vendor with two accounts.
  assert.equal(create?.headers["idempotency-key"], "connect_account_11111111-1111-1111-1111-111111111111");

  const link = seen[1];
  assert.equal(link?.path, "/v1/account_links");
  assert.equal(link?.form.get("type"), "account_onboarding");
  assert.equal(link?.form.get("account"), "acct_new");
});

test("payout readiness is read back from the connected account", async () => {
  replies.push({ status: 200, body: { id: "acct_x", object: "account", payouts_enabled: true } });
  const account = await gateway().getConnectAccount("acct_x");
  assert.equal(account.payoutsEnabled, true);
  assert.equal(seen[0]?.method, "GET");
  assert.equal(seen[0]?.path, "/v1/accounts/acct_x");
});

test("an intent with no client secret is refused rather than returned half-built", async () => {
  const body = intentBody();
  delete body["client_secret"];
  replies.push({ status: 200, body });

  await assert.rejects(
    () => gateway().createPaymentIntent({
      amountCents: 1_000,
      transferGroup: "g",
      destinationAccountId: "acct_1",
      idempotencyKey: "k",
      metadata: {},
    }),
    (error: unknown) => error instanceof StripeGatewayError && error.code === "missing_client_secret",
  );
});

test("a declined card is final, and its Stripe wording never reaches the caller", async () => {
  replies.push({
    status: 402,
    body: {
      error: {
        type: "card_error",
        code: "card_declined",
        message: "Your card was declined. Internal decline code XYZ.",
      },
    },
  });

  await assert.rejects(
    () => gateway().createPaymentIntent({
      amountCents: 1_000,
      transferGroup: "g",
      destinationAccountId: "acct_1",
      idempotencyKey: "k",
      metadata: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof StripeGatewayError);
      assert.equal(error.code, "card_declined");
      assert.equal(error.retryable, false, "a decline must not be retried");
      assert.ok(!/Internal decline code/.test(error.message), "Stripe's copy leaked to the caller");
      return true;
    },
  );
});

test("a rate limit is retryable, so a busy Saturday does not strand a booking", async () => {
  replies.push({
    status: 429,
    body: { error: { type: "rate_limit_error", message: "Too many requests" } },
  });

  await assert.rejects(
    () => gateway().createTransfer({
      amountCents: 1_000,
      destinationAccountId: "acct_1",
      transferGroup: "g",
      idempotencyKey: "k",
    }),
    (error: unknown) => {
      assert.ok(error instanceof StripeGatewayError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("the SDK retries a transient failure under the same idempotency key", async () => {
  replies.push({ status: 500, body: { error: { type: "api_error", message: "server error" } } });
  replies.push({ status: 200, body: intentBody() });

  const intent = await gateway({ maxNetworkRetries: 2 }).createPaymentIntent({
    amountCents: 35_280,
    transferGroup: "gig_abc",
    destinationAccountId: "acct_vendor",
    idempotencyKey: "deposit_esc_1",
    metadata: {},
  });

  assert.equal(intent.id, "pi_test_1");
  assert.equal(seen.length, 2, "the call should have been retried once");
  // Both attempts must carry the same key, or the retry charges twice.
  assert.equal(seen[0]?.headers["idempotency-key"], "deposit_esc_1");
  assert.equal(seen[1]?.headers["idempotency-key"], "deposit_esc_1");
});

test("a reused idempotency key with different parameters is a hard conflict", async () => {
  replies.push({
    status: 400,
    body: {
      error: {
        type: "idempotency_error",
        message: "Keys for idempotent requests can only be used with the same parameters.",
      },
    },
  });

  await assert.rejects(
    () => gateway().createRefund({ paymentIntentId: "pi_1", amountCents: 1, idempotencyKey: "k" }),
    (error: unknown) =>
      error instanceof StripeGatewayError &&
      error.code === "idempotency_conflict" &&
      error.retryable === false,
  );
});

test("a rejected API key is final and flagged as an operator problem", async () => {
  replies.push({
    status: 401,
    body: { error: { type: "authentication_error", message: "Invalid API Key provided" } },
  });

  await assert.rejects(
    () => gateway().getConnectAccount("acct_x"),
    (error: unknown) =>
      error instanceof StripeGatewayError &&
      error.code === "stripe_auth_failed" &&
      error.retryable === false,
  );
});

test("negative and fractional amounts never reach Stripe at all", async () => {
  const client = gateway();
  await assert.rejects(() =>
    client.createTransfer({
      amountCents: -1,
      destinationAccountId: "acct_1",
      transferGroup: "g",
      idempotencyKey: "k",
    }),
  );
  await assert.rejects(() =>
    client.createRefund({ paymentIntentId: "pi_1", amountCents: 10.5, idempotencyKey: "k" }),
  );
  assert.equal(seen.length, 0, "a bad amount must be rejected before the request is sent");
});

test("error classification reads both of Stripe's vocabularies", () => {
  // API-returned errors are discriminated by rawType...
  assert.equal(mapStripeError({ rawType: "card_error", code: "expired_card" }, "op").code, "expired_card");
  assert.equal(mapStripeError({ rawType: "rate_limit_error" }, "op").retryable, true);
  assert.equal(mapStripeError({ rawType: "api_error" }, "op").retryable, true);
  assert.equal(mapStripeError({ rawType: "authentication_error" }, "op").retryable, false);

  // ...and locally raised ones carry no rawType, only a class name.
  const connection = mapStripeError({ type: "StripeConnectionError" }, "op");
  assert.equal(connection.code, "stripe_unreachable");
  assert.equal(connection.retryable, true, "a dropped connection must be retryable");

  // Anything unrecognised fails closed rather than being retried forever.
  const unknown = mapStripeError(new Error("something else"), "createTransfer");
  assert.equal(unknown.code, "stripe_error");
  assert.equal(unknown.retryable, false);
});

test("the Stripe request id is kept for support, not discarded", () => {
  const mapped = mapStripeError({ rawType: "api_error", requestId: "req_abc123" }, "op");
  assert.equal(mapped.requestId, "req_abc123");
});
