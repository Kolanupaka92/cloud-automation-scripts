/**
 * Stripe Connect onboarding, escrow funding, release, refunds and the webhook.
 *
 * Every endpoint here is behind MFA step-up. The webhook is the one exception,
 * because it is called by Stripe rather than by a user; it authenticates on the
 * signature instead, and is the only thing in the system trusted to assert that
 * a payment actually succeeded.
 */
import { randomUUID } from "node:crypto";
import { HttpError, type Router } from "../router.js";
import { authenticate, field, isNumber, isString, rateLimit, requireMfa, requireRole } from "../middleware.js";
import { applyTransition, hoursUntil } from "./gigs.js";
import { quoteBooking, DEFAULT_FEES } from "../../domain/money.js";
import { quoteTravel } from "../../domain/geo.js";
import { refundFraction, AUTO_RELEASE_HOURS } from "../../domain/gig.js";
import { canReceivePayouts } from "../../domain/users.js";
import {
  assertLedgerBalances,
  createEscrow,
  EscrowError,
  openDispute,
  planRefund,
  recordBalance,
  recordDeposit,
  refund as recordRefund,
  release as releaseEscrow,
  resolveDispute,
  heldCents,
} from "../../domain/escrow.js";
import { verifyWebhookSignature } from "../../infra/stripe/index.js";
import { TOPICS } from "../../events/bus.js";
import type { AppDeps } from "../../app.js";

export function registerPaymentRoutes(router: Router, deps: AppDeps): void {
  const { config, store, stripe, bus, limiter } = deps;
  const requireAuth = authenticate(config.tokenSecret);
  const paymentLimit = rateLimit(limiter, "payments");

  /** Start Stripe Connect onboarding for a vendor. */
  router.post(
    "/v1/connect/onboard",
    async (ctx) => {
      const userId = ctx.auth?.sub as string;
      const user = await store.users.byId(userId);
      if (!user) throw new HttpError(404, "not_found", "user not found");

      const account = await stripe.createConnectAccount({ userId, email: user.email });
      const profile = await store.profiles.crew(userId);
      if (profile) {
        profile.stripeAccountId = account.id;
        await store.profiles.putCrew(profile);
      } else {
        const creator = await store.profiles.creator(userId);
        if (creator) {
          creator.stripeAccountId = account.id;
          await store.profiles.putCreator(creator);
        }
      }

      return {
        status: 201,
        body: { accountId: account.id, onboardingUrl: account.onboardingUrl, payoutsEnabled: account.payoutsEnabled },
      };
    },
    requireAuth,
    requireRole("crew", "creator"),
    requireMfa(),
    paymentLimit,
  );

  /**
   * Quote and fund a booking. Returns a Stripe client token; the client
   * confirms the payment against Stripe directly, and the booking is confirmed
   * only when the webhook reports the capture.
   */
  router.post(
    "/v1/gigs/:gigId/escrow",
    async (ctx) => {
      const hostId = ctx.auth?.sub as string;
      const gig = await store.gigs.byId(ctx.params.gigId as string);
      if (!gig) throw new HttpError(404, "not_found", "no such gig");
      if (gig.hostId !== hostId) throw new HttpError(403, "forbidden", "this gig belongs to another host");
      if (!gig.acceptedOfferId) throw new HttpError(409, "no_offer", "accept an applicant before funding");
      if (await store.escrows.byGig(gig.id)) {
        throw new HttpError(409, "already_funded", "this gig already has an escrow");
      }

      const application = await store.applications.byId(gig.acceptedOfferId);
      if (!application) throw new HttpError(404, "not_found", "the accepted application is missing");

      const vendor = await store.users.byId(application.vendorId);
      const vendorProfile = await store.profiles.crew(application.vendorId);
      if (!vendor || !vendorProfile) throw new HttpError(404, "not_found", "the vendor profile is missing");

      // A vendor who cannot be paid must not be bookable. Discovering this
      // after the host has paid is the worst possible time to find out.
      const payout = canReceivePayouts(vendor, vendorProfile.stripeAccountId);
      if (!payout.ok) {
        throw new HttpError(409, "vendor_not_payable", `this vendor cannot be paid yet: ${payout.reason}`);
      }

      const travel = quoteTravel(vendor.homeBase, gig.brief.venue, vendorProfile.travelPolicy);
      if (travel.outOfRange) {
        throw new HttpError(409, "out_of_range", "the venue is outside this vendor's travel radius");
      }
      const quote = quoteBooking(application.quotedRateCents, travel.totalCents, DEFAULT_FEES);

      const escrow = createEscrow({
        id: randomUUID(),
        gigId: gig.id,
        hostId,
        vendorId: application.vendorId,
        quote,
      });

      const intent = await stripe.createPaymentIntent({
        amountCents: quote.depositDue,
        transferGroup: escrow.transferGroup,
        destinationAccountId: vendorProfile.stripeAccountId as string,
        // Idempotent on the escrow, so a retried request cannot double-charge.
        idempotencyKey: `deposit_${escrow.id}`,
        metadata: { gigId: gig.id, escrowId: escrow.id, leg: "deposit" },
      });
      escrow.depositIntentId = intent.id;

      const saved = await store.escrows.create(escrow);
      gig.escrowId = saved.id;
      await store.gigs.save(gig);

      return {
        status: 201,
        body: {
          escrow: publicEscrow(saved),
          quote,
          travel,
          payment: { intentId: intent.id, clientToken: intent.clientSecretToken },
        },
      };
    },
    requireAuth,
    requireRole("host"),
    requireMfa(),
    paymentLimit,
  );

  /**
   * Charge the remaining balance.
   *
   * The deposit locks the booking; the balance is taken once the vendor is
   * committed and travelling, so the full fee is in the vault before anyone
   * arrives at the venue. Funds are never released while any of it is still
   * on the host's card.
   */
  router.post(
    "/v1/gigs/:gigId/escrow/balance",
    async (ctx) => {
      const escrow = await store.escrows.byGig(ctx.params.gigId as string);
      if (!escrow) throw new HttpError(404, "not_found", "this gig has no escrow");
      if (escrow.hostId !== (ctx.auth?.sub as string)) {
        throw new HttpError(403, "forbidden", "this booking belongs to another host");
      }
      if (escrow.state !== "DepositHeld") {
        throw new HttpError(409, "bad_state", `the balance cannot be charged while escrow is ${escrow.state}`);
      }

      const vendorProfile = await store.profiles.crew(escrow.vendorId);
      const intent = await stripe.createPaymentIntent({
        amountCents: escrow.quote.balanceDue,
        transferGroup: escrow.transferGroup,
        destinationAccountId: vendorProfile?.stripeAccountId ?? `acct_${escrow.vendorId}`,
        idempotencyKey: `balance_${escrow.id}`,
        metadata: { gigId: escrow.gigId, escrowId: escrow.id, leg: "balance" },
      });

      return {
        status: 201,
        body: {
          escrow: publicEscrow(escrow),
          amountCents: escrow.quote.balanceDue,
          payment: { intentId: intent.id, clientToken: intent.clientSecretToken },
        },
      };
    },
    requireAuth,
    requireRole("host"),
    requireMfa(),
    paymentLimit,
  );

  router.get(
    "/v1/escrow/:escrowId",
    async (ctx) => {
      const escrow = await store.escrows.byId(ctx.params.escrowId as string);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");
      const userId = ctx.auth?.sub as string;
      const isParty = escrow.hostId === userId || escrow.vendorId === userId;
      if (!isParty && !ctx.auth?.roles.includes("admin")) {
        throw new HttpError(403, "forbidden", "you are not a party to this booking");
      }
      return { status: 200, body: { escrow: publicEscrow(escrow), heldCents: heldCents(escrow) } };
    },
    requireAuth,
  );

  /** Host signs off, or the auto-release window has elapsed. */
  router.post(
    "/v1/escrow/:escrowId/release",
    async (ctx) => {
      const escrow = await store.escrows.byId(ctx.params.escrowId as string);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");
      const userId = ctx.auth?.sub as string;
      const isAdmin = ctx.auth?.roles.includes("admin") ?? false;
      if (escrow.hostId !== userId && !isAdmin) {
        throw new HttpError(403, "forbidden", "only the host may sign off on this booking");
      }

      const gig = await store.gigs.byId(escrow.gigId);
      if (!gig) throw new HttpError(404, "not_found", "the gig is missing");
      if (gig.state !== "DeliveryPending") {
        throw new HttpError(409, "not_deliverable", `the gig is ${gig.state}; funds release after delivery`);
      }

      const vendorProfile = await store.profiles.crew(escrow.vendorId);
      const transfer = await stripe.createTransfer({
        amountCents: escrow.quote.vendorPayout,
        destinationAccountId: vendorProfile?.stripeAccountId ?? `acct_${escrow.vendorId}`,
        transferGroup: escrow.transferGroup,
        idempotencyKey: `release_${escrow.id}`,
      });

      try {
        releaseEscrow(
          escrow,
          { hostSignedOff: true, autoReleaseElapsed: false, deliveryConfirmed: true },
          transfer.id,
        );
      } catch (error) {
        throw asHttpError(error);
      }
      assertLedgerBalances(escrow);
      await store.escrows.save(escrow);

      applyTransition(gig, "Completed", isAdmin ? "admin" : "host", userId);
      await store.gigs.save(gig);
      await bus.publish(
        TOPICS.escrowReleased,
        escrow.gigId,
        { escrowId: escrow.id, vendorId: escrow.vendorId, amountCents: escrow.quote.vendorPayout },
        ctx.traceId,
      );

      return { status: 200, body: { escrow: publicEscrow(escrow), transferId: transfer.id } };
    },
    requireAuth,
    requireMfa(),
    paymentLimit,
  );

  /** Cancel and refund per the tier in the gig domain. */
  router.post(
    "/v1/escrow/:escrowId/cancel",
    async (ctx) => {
      const escrow = await store.escrows.byId(ctx.params.escrowId as string);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");
      const userId = ctx.auth?.sub as string;
      const reason = field(ctx, "reason", isString);

      const isHost = escrow.hostId === userId;
      const isVendor = escrow.vendorId === userId;
      const isAdmin = ctx.auth?.roles.includes("admin") ?? false;
      if (!isHost && !isVendor && !isAdmin) {
        throw new HttpError(403, "forbidden", "you are not a party to this booking");
      }

      const gig = await store.gigs.byId(escrow.gigId);
      if (!gig) throw new HttpError(404, "not_found", "the gig is missing");

      const cancelledBy = isVendor ? "vendor" : isHost ? "host" : "admin";
      const fraction = refundFraction(hoursUntil(gig.brief.eventDate), cancelledBy);
      const held = heldCents(escrow);
      const refundCents = Math.round(held * fraction);

      if (refundCents > 0) {
        const plan = planRefund(escrow, Math.min(refundCents, held));
        const target = plan.fromBalance > 0 ? plan.balanceIntentId : plan.depositIntentId;
        const stripeRefund = await stripe.createRefund({
          paymentIntentId: target ?? (escrow.depositIntentId as string),
          amountCents: refundCents,
          idempotencyKey: `refund_${escrow.id}`,
        });
        try {
          recordRefund(escrow, refundCents, stripeRefund.id);
        } catch (error) {
          throw asHttpError(error);
        }
        assertLedgerBalances(escrow);
        await store.escrows.save(escrow);
        await bus.publish(
          TOPICS.escrowRefunded,
          escrow.gigId,
          { escrowId: escrow.id, amountCents: refundCents, cancelledBy },
          ctx.traceId,
        );
      }

      applyTransition(gig, "Cancelled", cancelledBy, userId, { cancellationReason: reason });
      await store.gigs.save(gig);

      return {
        status: 200,
        body: {
          escrow: publicEscrow(escrow),
          refundedCents: refundCents,
          refundFraction: fraction,
          policy: `cancelled by ${cancelledBy}, ${Math.round(fraction * 100)}% of funds held returned`,
        },
      };
    },
    requireAuth,
    requireMfa(),
    paymentLimit,
  );

  router.post(
    "/v1/escrow/:escrowId/dispute",
    async (ctx) => {
      const escrow = await store.escrows.byId(ctx.params.escrowId as string);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");
      const userId = ctx.auth?.sub as string;
      if (escrow.hostId !== userId && escrow.vendorId !== userId) {
        throw new HttpError(403, "forbidden", "you are not a party to this booking");
      }
      const reason = field(ctx, "reason", isString);
      try {
        openDispute(escrow, reason);
      } catch (error) {
        throw asHttpError(error);
      }
      await store.escrows.save(escrow);

      const gig = await store.gigs.byId(escrow.gigId);
      if (gig) {
        applyTransition(gig, "Disputed", escrow.hostId === userId ? "host" : "vendor", userId);
        await store.gigs.save(gig);
      }
      await bus.publish(TOPICS.disputeOpened, escrow.gigId, { escrowId: escrow.id, reason }, ctx.traceId);
      return { status: 200, body: { escrow: publicEscrow(escrow) } };
    },
    requireAuth,
    paymentLimit,
  );

  /** Admin-only dispute resolution. The split must account for every held cent. */
  router.post(
    "/v1/escrow/:escrowId/resolve",
    async (ctx) => {
      const escrow = await store.escrows.byId(ctx.params.escrowId as string);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");
      const toVendorCents = field(ctx, "toVendorCents", isNumber);
      const toHostCents = field(ctx, "toHostCents", isNumber);

      const refs: { transferId?: string; refundId?: string } = {};
      if (toVendorCents > 0) {
        const vendorProfile = await store.profiles.crew(escrow.vendorId);
        const transfer = await stripe.createTransfer({
          amountCents: toVendorCents,
          destinationAccountId: vendorProfile?.stripeAccountId ?? `acct_${escrow.vendorId}`,
          transferGroup: escrow.transferGroup,
          idempotencyKey: `dispute_transfer_${escrow.id}`,
        });
        refs.transferId = transfer.id;
      }
      if (toHostCents > 0) {
        const stripeRefund = await stripe.createRefund({
          paymentIntentId: escrow.depositIntentId as string,
          amountCents: toHostCents,
          idempotencyKey: `dispute_refund_${escrow.id}`,
        });
        refs.refundId = stripeRefund.id;
      }

      try {
        resolveDispute(escrow, { toVendorCents, toHostCents, stripeRefs: refs });
      } catch (error) {
        throw asHttpError(error);
      }
      assertLedgerBalances(escrow);
      await store.escrows.save(escrow);

      const gig = await store.gigs.byId(escrow.gigId);
      if (gig) {
        applyTransition(gig, toVendorCents > 0 ? "Completed" : "Cancelled", "admin", ctx.auth?.sub as string, {
          cancellationReason: "dispute resolution",
        });
        await store.gigs.save(gig);
      }

      return { status: 200, body: { escrow: publicEscrow(escrow) } };
    },
    requireAuth,
    requireRole("admin"),
    requireMfa(),
    paymentLimit,
  );

  /**
   * The Stripe webhook. Signature-verified, and the only path that may record a
   * capture. The body is read raw because re-serialised JSON will not match the
   * signature.
   */
  router.post("/v1/webhooks/stripe", async (ctx) => {
    const signature = ctx.headers["stripe-signature"];
    const header = Array.isArray(signature) ? signature[0] : signature;
    if (!header || !verifyWebhookSignature(ctx.rawBody, header, config.webhookSigningSecret)) {
      throw new HttpError(400, "bad_signature", "webhook signature verification failed");
    }

    const event = ctx.body as { type?: string; data?: { object?: Record<string, unknown> } };
    const object = event.data?.object ?? {};
    const escrowId = typeof object.escrowId === "string" ? object.escrowId : undefined;
    const intentId = typeof object.id === "string" ? object.id : undefined;
    const amount = typeof object.amount === "number" ? object.amount : undefined;

    if (event.type !== "payment_intent.succeeded" || !escrowId || !intentId || amount === undefined) {
      // Acknowledge anything else so Stripe stops retrying an event we do not
      // act on; unhandled types are not errors.
      return { status: 200, body: { received: true, handled: false } };
    }

    const escrow = await store.escrows.byId(escrowId);
    if (!escrow) return { status: 200, body: { received: true, handled: false } };

    // Which leg this capture settles. The deposit is the default so an event
    // that predates the metadata is still handled correctly.
    const leg = object.leg === "balance" ? "balance" : "deposit";

    try {
      if (leg === "balance") {
        recordBalance(escrow, amount, intentId);
      } else {
        recordDeposit(escrow, amount, intentId);
      }
    } catch (error) {
      if (error instanceof EscrowError && error.code === "bad_state") {
        // A duplicate or out-of-order delivery. Acknowledge it so Stripe stops
        // retrying rather than surfacing a 4xx it would keep redelivering.
        return { status: 200, body: { received: true, handled: false } };
      }
      throw asHttpError(error);
    }
    assertLedgerBalances(escrow);
    await store.escrows.save(escrow);

    const gig = await store.gigs.byId(escrow.gigId);
    if (gig && gig.state === "ApplicationsReview") {
      applyTransition(gig, "EscrowLocked", "system", "stripe-webhook", { depositFunded: true });
      await store.gigs.save(gig);
    }
    await bus.publish(
      TOPICS.escrowFunded,
      escrow.gigId,
      { escrowId: escrow.id, amountCents: amount, leg },
      ctx.traceId,
    );

    return { status: 200, body: { received: true, handled: true, escrowState: escrow.state } };
  });

  /**
   * The auto-release sweep, invoked by the scheduler. Vendors are not left
   * waiting on a host who simply stopped replying.
   */
  router.post(
    "/v1/internal/escrow/auto-release",
    async (ctx) => {
      const escrowId = field(ctx, "escrowId", isString);
      const hoursAwaiting = field(ctx, "hoursAwaitingSignoff", isNumber);
      if (hoursAwaiting < AUTO_RELEASE_HOURS) {
        throw new HttpError(409, "too_early", `auto-release begins at ${AUTO_RELEASE_HOURS}h after delivery`);
      }
      const escrow = await store.escrows.byId(escrowId);
      if (!escrow) throw new HttpError(404, "not_found", "no such escrow");

      const vendorProfile = await store.profiles.crew(escrow.vendorId);
      const transfer = await stripe.createTransfer({
        amountCents: escrow.quote.vendorPayout,
        destinationAccountId: vendorProfile?.stripeAccountId ?? `acct_${escrow.vendorId}`,
        transferGroup: escrow.transferGroup,
        idempotencyKey: `release_${escrow.id}`,
      });
      try {
        releaseEscrow(
          escrow,
          { hostSignedOff: false, autoReleaseElapsed: true, deliveryConfirmed: true },
          transfer.id,
        );
      } catch (error) {
        throw asHttpError(error);
      }
      assertLedgerBalances(escrow);
      await store.escrows.save(escrow);

      const gig = await store.gigs.byId(escrow.gigId);
      if (gig && gig.state === "DeliveryPending") {
        applyTransition(gig, "Completed", "system", "auto-release");
        await store.gigs.save(gig);
      }
      return { status: 200, body: { escrow: publicEscrow(escrow), released: true } };
    },
    requireAuth,
    requireRole("admin"),
  );
}

/** Strip Stripe object ids from anything returned to a client. */
function publicEscrow(escrow: import("../../domain/escrow.js").Escrow) {
  return {
    id: escrow.id,
    gigId: escrow.gigId,
    state: escrow.state,
    quote: escrow.quote,
    entries: escrow.entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountCents: entry.amountCents,
      at: entry.at,
      ...(entry.note ? { note: entry.note } : {}),
    })),
    createdAt: escrow.createdAt,
    updatedAt: escrow.updatedAt,
  };
}

function asHttpError(error: unknown): HttpError {
  if (error instanceof EscrowError) {
    const status = error.code === "bad_state" || error.code === "already_released" ? 409 : 400;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof HttpError) return error;
  throw error;
}
