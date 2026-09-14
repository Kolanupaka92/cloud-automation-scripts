/**
 * End-to-end over the real router: register, verify, post a gig, match, apply,
 * offer, fund, deliver and release. The only fakes are the persistence layer
 * and the Stripe gateway; every route, guard and state transition is the real
 * one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { harness, onboard, payoutReadyVendor, postWebhook, BRIEF, FRISCO, PLANO } from "./helpers.js";

test("health check responds", async () => {
  const h = harness();
  const result = await h.call("GET", "/healthz");
  assert.equal(result.status, 200);
});

test("an unknown route is a clean 404", async () => {
  const h = harness();
  const result = await h.call("GET", "/v1/nope");
  assert.equal(result.status, 404);
});

test("the taxonomy is public, so the clients can render their pickers", async () => {
  const h = harness();
  const result = await h.call("GET", "/v1/taxonomy");
  assert.equal(result.status, 200);
  const body = result.body as { crewSpecialties: string[]; eventGroups: Record<string, string[]> };
  assert.ok(body.crewSpecialties.includes("henna_artist"));
  assert.ok(body.eventGroups.milestone?.includes("half_saree_function"));
});

test("a full booking runs from registration to a released payout", async () => {
  const h = harness();
  const host = await onboard(h, { email: "boutique@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "mua@plano.test");

  // The host posts a brief and publishes it.
  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const gigId = (created.body as { gig: { id: string } }).gig.id;

  const published = await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const publishBody = published.body as {
    gig: { state: string };
    shortlist: { userId: string }[];
    notificationWaves: unknown[];
  };
  assert.equal(publishBody.gig.state, "Open");
  assert.ok(
    publishBody.shortlist.some((entry) => entry.userId === vendor.userId),
    "the matching vendor should be shortlisted",
  );
  assert.ok(publishBody.notificationWaves.length > 0, "notifications should be scheduled");

  // The vendor applies; the gig moves itself into review.
  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000, message: "I specialise in Telugu half-saree looks." },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const applicationId = (applied.body as { application: { id: string } }).application.id;

  const afterApply = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((afterApply.body as { gig: { state: string } }).gig.state, "ApplicationsReview");

  // The host reviews a ranked applicant list and makes an offer.
  const applicants = await h.call("GET", `/v1/gigs/${gigId}/applications`, { token: host.token });
  assert.equal(applicants.status, 200);
  const ranked = (applicants.body as { applications: { score: number }[] }).applications;
  assert.equal(ranked.length, 1);
  assert.ok((ranked[0]?.score ?? 0) > 0, "an applicant should carry a match score");

  const offered = await h.call("POST", `/v1/gigs/${gigId}/offer`, {
    token: host.token,
    body: { applicationId },
  });
  assert.equal(offered.status, 200, JSON.stringify(offered.body));

  // The host funds the escrow. Travel is priced into the quote.
  const escrowed = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: host.token });
  assert.equal(escrowed.status, 201, JSON.stringify(escrowed.body));
  const escrowBody = escrowed.body as {
    escrow: { id: string; state: string };
    quote: { hostTotal: number; depositDue: number; vendorPayout: number; platformRevenue: number };
    payment: { intentId: string };
  };
  const escrowId = escrowBody.escrow.id;
  assert.equal(escrowBody.escrow.state, "AwaitingDeposit");
  assert.equal(
    escrowBody.quote.hostTotal,
    escrowBody.quote.vendorPayout + escrowBody.quote.platformRevenue,
  );

  // The gig is still not confirmed: the money has not cleared.
  const beforeWebhook = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((beforeWebhook.body as { gig: { state: string } }).gig.state, "ApplicationsReview");

  // Stripe reports the capture. This is what confirms the booking.
  const webhook = await postWebhook(h, {
    type: "payment_intent.succeeded",
    data: { object: { id: escrowBody.payment.intentId, amount: escrowBody.quote.depositDue, escrowId } },
  });
  assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
  assert.equal((webhook.body as { handled: boolean }).handled, true);

  const confirmed = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((confirmed.body as { gig: { state: string } }).gig.state, "EscrowLocked");

  // The vendor travels, works and delivers.
  for (const [to, token] of [
    ["InTransit", vendor.token],
    ["Active", vendor.token],
    ["DeliveryPending", vendor.token],
  ] as const) {
    const gig = await h.deps.store.gigs.byId(gigId);
    assert.ok(gig);
    // Pull the event close enough that the call-time guard allows travel.
    gig.brief = { ...gig.brief, eventDate: new Date().toISOString().slice(0, 10) };
    await h.deps.store.gigs.save(gig);

    const moved = await h.call("POST", `/v1/gigs/${gigId}/transition`, {
      token,
      body: { to, checkedInAtVenue: true },
    });
    assert.equal(moved.status, 200, `${to}: ${JSON.stringify(moved.body)}`);
  }

  // Funds cannot be released while part of the fee is still on the host's card.
  const early = await h.call("POST", `/v1/escrow/${escrowId}/release`, { token: host.token });
  assert.equal(early.status, 409, "a partially funded escrow must not release");

  // The host is charged the balance, and Stripe confirms that capture too.
  const balance = await h.call("POST", `/v1/gigs/${gigId}/escrow/balance`, { token: host.token });
  assert.equal(balance.status, 201, JSON.stringify(balance.body));
  const balanceBody = balance.body as { amountCents: number; payment: { intentId: string } };

  const balanceWebhook = await postWebhook(h, {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: balanceBody.payment.intentId,
        amount: balanceBody.amountCents,
        escrowId,
        leg: "balance",
      },
    },
  });
  assert.equal(balanceWebhook.status, 200, JSON.stringify(balanceWebhook.body));
  assert.equal((balanceWebhook.body as { escrowState: string }).escrowState, "FullyFunded");

  // The host signs off and the vendor is paid.
  const released = await h.call("POST", `/v1/escrow/${escrowId}/release`, { token: host.token });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((released.body as { escrow: { state: string } }).escrow.state, "Released");

  const transfer = h.stripe.transfers.at(-1);
  assert.equal(transfer?.amountCents, escrowBody.quote.vendorPayout);

  const finalGig = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((finalGig.body as { gig: { state: string } }).gig.state, "Completed");
});

test("a vendor who cannot be paid cannot be booked", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host2@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await onboard(h, { email: "unverified@plano.test", roles: ["crew"], homeBase: PLANO });
  await h.call("POST", "/v1/profiles/crew", {
    token: vendor.token,
    body: { specialties: ["mua"], culturalTags: ["telugu_traditional"], startingRateCents: 50_000 },
  });

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 50_000 },
  });
  await h.call("POST", `/v1/gigs/${gigId}/offer`, {
    token: host.token,
    body: { applicationId: (applied.body as { application: { id: string } }).application.id },
  });

  const escrowed = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: host.token });
  assert.equal(escrowed.status, 409);
  assert.equal((escrowed.body as { error: { code: string } }).error.code, "vendor_not_payable");
});

test("a cancelled booking refunds the host by the tier and never releases", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host3@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "mua3@plano.test");

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000 },
  });
  await h.call("POST", `/v1/gigs/${gigId}/offer`, {
    token: host.token,
    body: { applicationId: (applied.body as { application: { id: string } }).application.id },
  });
  const escrowed = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: host.token });
  const escrowBody = escrowed.body as { escrow: { id: string }; quote: { depositDue: number }; payment: { intentId: string } };
  await postWebhook(h, {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: escrowBody.payment.intentId,
        amount: escrowBody.quote.depositDue,
        escrowId: escrowBody.escrow.id,
      },
    },
  });

  // The event is well over a month out, so the host is made whole.
  const cancelled = await h.call("POST", `/v1/escrow/${escrowBody.escrow.id}/cancel`, {
    token: host.token,
    body: { reason: "the venue fell through" },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const body = cancelled.body as { refundedCents: number; refundFraction: number; escrow: { state: string } };
  assert.equal(body.refundFraction, 1);
  assert.equal(body.refundedCents, escrowBody.quote.depositDue);
  assert.equal(body.escrow.state, "Refunded");
  assert.equal(h.stripe.transfers.length, 0, "no money should have reached the vendor");

  const gig = await h.call("GET", `/v1/gigs/${gigId}`, { token: host.token });
  assert.equal((gig.body as { gig: { state: string } }).gig.state, "Cancelled");
});

test("an unsigned webhook cannot fund an escrow", async () => {
  const h = harness();
  const result = await h.call("POST", "/v1/webhooks/stripe", {
    body: { type: "payment_intent.succeeded", data: { object: { id: "pi_x", amount: 1, escrowId: "esc_x" } } },
  });
  assert.equal(result.status, 400);
  assert.equal((result.body as { error: { code: string } }).error.code, "bad_signature");
});

test("a replayed webhook does not double-fund", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host4@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "mua4@plano.test");

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000 },
  });
  await h.call("POST", `/v1/gigs/${gigId}/offer`, {
    token: host.token,
    body: { applicationId: (applied.body as { application: { id: string } }).application.id },
  });
  const escrowed = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: host.token });
  const escrowBody = escrowed.body as { escrow: { id: string }; quote: { depositDue: number }; payment: { intentId: string } };

  const event = {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: escrowBody.payment.intentId,
        amount: escrowBody.quote.depositDue,
        escrowId: escrowBody.escrow.id,
      },
    },
  };
  await postWebhook(h, event);
  await postWebhook(h, event);
  await postWebhook(h, event);

  const escrow = await h.deps.store.escrows.byId(escrowBody.escrow.id);
  assert.equal(escrow?.entries.length, 1, "only one capture should be recorded");
});

test("authentication and authorisation are enforced on every protected route", async () => {
  const h = harness();
  const anonymous = await h.call("POST", "/v1/gigs", { body: BRIEF });
  assert.equal(anonymous.status, 401);

  const vendor = await payoutReadyVendor(h, "mua5@plano.test");
  // Crew cannot post gigs.
  const wrongRole = await h.call("POST", "/v1/gigs", { token: vendor.token, body: BRIEF });
  assert.equal(wrongRole.status, 403);

  // A refresh token is not an access token.
  const loggedIn = await h.call("POST", "/v1/auth/login", {
    body: { email: "mua5@plano.test", password: "a-long-enough-passphrase" },
  });
  const refreshToken = (loggedIn.body as { refreshToken: string }).refreshToken;
  const misused = await h.call("GET", "/v1/me", { token: refreshToken });
  assert.equal(misused.status, 401);
});

test("money endpoints demand an MFA-verified session, not merely a logged-in one", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host6@frisco.test", roles: ["host"], homeBase: FRISCO });
  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;

  // A plain login session has not cleared MFA.
  const loggedIn = await h.call("POST", "/v1/auth/login", {
    body: { email: "host6@frisco.test", password: "a-long-enough-passphrase" },
  });
  const weakToken = (loggedIn.body as { accessToken: string }).accessToken;

  const blocked = await h.call("POST", `/v1/gigs/${gigId}/escrow`, { token: weakToken });
  assert.equal(blocked.status, 403);
  assert.equal((blocked.body as { error: { code: string } }).error.code, "mfa_required");
});

test("one host cannot touch another host's gig", async () => {
  const h = harness();
  const owner = await onboard(h, { email: "owner@frisco.test", roles: ["host"], homeBase: FRISCO });
  const stranger = await onboard(h, { email: "stranger@frisco.test", roles: ["host"], homeBase: FRISCO });

  const created = await h.call("POST", "/v1/gigs", { token: owner.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;

  const published = await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: stranger.token });
  assert.equal(published.status, 403);
  const applicants = await h.call("GET", `/v1/gigs/${gigId}/applications`, { token: stranger.token });
  assert.equal(applicants.status, 403);
});

test("a gig outside the Texas footprint is refused at the door", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host7@frisco.test", roles: ["host"], homeBase: FRISCO });
  const result = await h.call("POST", "/v1/gigs", {
    token: host.token,
    body: { ...BRIEF, venue: { lat: 39.7392, lng: -104.9903 } },
  });
  assert.equal(result.status, 400);
  assert.equal((result.body as { error: { code: string } }).error.code, "outside_footprint");
});

test("registration refuses a self-assigned admin role and a weak password", async () => {
  const h = harness();
  const escalation = await h.call("POST", "/v1/auth/register", {
    body: {
      email: "sneaky@frisco.test",
      password: "a-long-enough-passphrase",
      displayName: "Sneaky",
      roles: ["host", "admin"],
      homeBase: FRISCO,
    },
  });
  assert.equal(escalation.status, 403);

  const weak = await h.call("POST", "/v1/auth/register", {
    body: {
      email: "weak@frisco.test",
      password: "short",
      displayName: "Weak",
      roles: ["host"],
      homeBase: FRISCO,
    },
  });
  assert.equal(weak.status, 400);
  assert.equal((weak.body as { error: { code: string } }).error.code, "weak_password");
});

test("a vendor cannot apply to a gig outside their speciality", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host8@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await onboard(h, { email: "dj@plano.test", roles: ["crew"], homeBase: PLANO });
  await h.call("POST", "/v1/profiles/crew", {
    token: vendor.token,
    body: { specialties: ["dj"], startingRateCents: 40_000 },
  });

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });

  const applied = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 40_000 },
  });
  assert.equal(applied.status, 400);
  assert.equal((applied.body as { error: { code: string } }).error.code, "specialty_mismatch");
});

test("a vendor cannot apply to the same gig twice", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host9@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "mua9@plano.test");
  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });

  const first = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000 },
  });
  assert.equal(first.status, 201);
  const second = await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 55_000 },
  });
  assert.equal(second.status, 409);
});

test("talent search is closed to vendors, so the roster cannot be harvested", async () => {
  const h = harness();
  const vendor = await payoutReadyVendor(h, "mua10@plano.test");
  const result = await h.call("POST", "/v1/search/crew", {
    token: vendor.token,
    body: { specialty: "mua", venue: FRISCO },
  });
  assert.equal(result.status, 403);
});

test("search results never carry a connected-account id", async () => {
  const h = harness();
  const host = await onboard(h, { email: "host11@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "mua11@plano.test");

  const search = await h.call("POST", "/v1/search/crew", {
    token: host.token,
    body: { specialty: "mua", venue: FRISCO, culturalTags: ["telugu_traditional"], eventDate: "2027-06-20" },
  });
  assert.equal(search.status, 200);
  assert.ok(!JSON.stringify(search.body).includes("acct_"), "search leaked a Stripe account id");

  const profile = await h.call("GET", `/v1/profiles/crew/${vendor.userId}`, { token: host.token });
  assert.equal(profile.status, 200);
  assert.ok(!JSON.stringify(profile.body).includes("acct_"), "a profile leaked a Stripe account id");
});

test("login does not reveal whether an address is registered", async () => {
  const h = harness();
  await onboard(h, { email: "real@frisco.test", roles: ["host"], homeBase: FRISCO });

  const wrongPassword = await h.call("POST", "/v1/auth/login", {
    body: { email: "real@frisco.test", password: "definitely-the-wrong-one" },
  });
  const noSuchUser = await h.call("POST", "/v1/auth/login", {
    body: { email: "ghost@frisco.test", password: "definitely-the-wrong-one" },
  });
  assert.equal(wrongPassword.status, noSuchUser.status);
  // The trace id is deliberately unique per request; everything else a client
  // can see must be identical, or the difference is an enumeration oracle.
  const withoutTrace = (body: unknown) => {
    const { traceId, ...rest } = body as Record<string, unknown>;
    void traceId;
    return rest;
  };
  assert.deepEqual(withoutTrace(wrongPassword.body), withoutTrace(noSuchUser.body));
});

test("an unhandled Stripe event is acknowledged rather than retried forever", async () => {
  const h = harness();
  const result = await postWebhook(h, { type: "customer.subscription.updated", data: { object: {} } });
  assert.equal(result.status, 200);
  assert.equal((result.body as { handled: boolean }).handled, false);
});

test("a host sees only their own gigs on the dashboard", async () => {
  const h = harness();
  const owner = await onboard(h, { email: "list-owner@frisco.test", roles: ["host"], homeBase: FRISCO });
  const stranger = await onboard(h, { email: "list-other@frisco.test", roles: ["host"], homeBase: FRISCO });

  await h.call("POST", "/v1/gigs", { token: owner.token, body: BRIEF });
  await h.call("POST", "/v1/gigs", { token: owner.token, body: BRIEF });
  await h.call("POST", "/v1/gigs", { token: stranger.token, body: BRIEF });

  const mine = await h.call("GET", "/v1/me/gigs", { token: owner.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const gigs = (mine.body as { gigs: { hostId: string }[] }).gigs;
  assert.equal(gigs.length, 2);
  assert.ok(gigs.every((gig) => gig.hostId === owner.userId), "another host's gig leaked into the list");

  const theirs = await h.call("GET", "/v1/me/gigs", { token: stranger.token });
  assert.equal((theirs.body as { gigs: unknown[] }).gigs.length, 1);
});

test("a vendor without a profile is told to make one rather than shown nothing", async () => {
  const h = harness();
  const vendor = await onboard(h, { email: "bare@plano.test", roles: ["crew"], homeBase: PLANO });
  const result = await h.call("GET", "/v1/discover/gigs", { token: vendor.token });
  assert.equal(result.status, 400);
  assert.equal((result.body as { error: { code: string } }).error.code, "no_profile");
});

test("discovery shows a vendor the open gigs they can actually take, ranked", async () => {
  const h = harness();
  const host = await onboard(h, { email: "disc-host@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "disc-mua@plano.test");

  // A draft gig, and a published one. Only the published one is applicable.
  await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const live = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const liveId = (live.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${liveId}/publish`, { token: host.token });

  // And one for a speciality this vendor does not offer.
  const other = await h.call("POST", "/v1/gigs", {
    token: host.token,
    body: { ...BRIEF, specialty: "dj" },
  });
  const otherId = (other.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${otherId}/publish`, { token: host.token });

  const found = await h.call("GET", "/v1/discover/gigs", { token: vendor.token });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const rows = (found.body as {
    gigs: { gig: { id: string }; score: number; alreadyApplied: boolean }[];
  }).gigs;

  assert.deepEqual(rows.map((row) => row.gig.id), [liveId], "only the open, in-speciality gig should show");
  assert.ok((rows[0]?.score ?? 0) > 0, "a listed gig should carry the vendor's own match score");
  assert.equal(rows[0]?.alreadyApplied, false);
});

test("a gig a vendor already applied to is marked, not hidden", async () => {
  const h = harness();
  const host = await onboard(h, { email: "disc2-host@frisco.test", roles: ["host"], homeBase: FRISCO });
  const vendor = await payoutReadyVendor(h, "disc2-mua@plano.test");

  const created = await h.call("POST", "/v1/gigs", { token: host.token, body: BRIEF });
  const gigId = (created.body as { gig: { id: string } }).gig.id;
  await h.call("POST", `/v1/gigs/${gigId}/publish`, { token: host.token });
  await h.call("POST", `/v1/gigs/${gigId}/applications`, {
    token: vendor.token,
    body: { quotedRateCents: 60_000 },
  });

  const found = await h.call("GET", "/v1/discover/gigs", { token: vendor.token });
  const rows = (found.body as { gigs: { gig: { id: string }; alreadyApplied: boolean }[] }).gigs;
  const row = rows.find((entry) => entry.gig.id === gigId);
  assert.ok(row, "the gig should still be listed");
  assert.equal(row.alreadyApplied, true, "so the vendor is not invited to apply twice");
});

test("a host cannot use the vendor discovery feed", async () => {
  const h = harness();
  const host = await onboard(h, { email: "nosy-host@frisco.test", roles: ["host"], homeBase: FRISCO });
  const result = await h.call("GET", "/v1/discover/gigs", { token: host.token });
  assert.equal(result.status, 403);
});
