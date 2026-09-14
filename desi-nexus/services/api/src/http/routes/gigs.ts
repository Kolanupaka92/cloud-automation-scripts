/**
 * The gig lifecycle: post a brief, take applications, extend an offer, and
 * drive the state machine.
 */
import { randomUUID } from "node:crypto";
import { HttpError, type Router } from "../router.js";
import { authenticate, field, isNumber, isObject, isString, requireRole } from "../middleware.js";
import { toCandidate } from "./discovery.js";
import {
  allowedTransitions,
  isBriefComplete,
  transition,
  TransitionError,
  type Actor,
  type Gig,
  type GigBrief,
  type GigState,
} from "../../domain/gig.js";
import { isCrewSpecialty, isEventType } from "../../domain/taxonomy.js";
import { nearestMetro, withinPilotFootprint } from "../../domain/geo.js";
import { planNotificationWaves, rankCandidates } from "../../domain/matching.js";
import { TOPICS } from "../../events/bus.js";
import type { AppDeps } from "../../app.js";

export function registerGigRoutes(router: Router, deps: AppDeps): void {
  const { config, store, bus } = deps;
  const requireAuth = authenticate(config.tokenSecret);

  router.post(
    "/v1/gigs",
    async (ctx) => {
      const hostId = ctx.auth?.sub as string;
      const brief = parseBrief(ctx.body);
      const now = new Date().toISOString();

      const gig: Gig = {
        id: randomUUID(),
        hostId,
        state: "Draft",
        brief,
        applicationCount: 0,
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      const saved = await store.gigs.create(gig);
      return { status: 201, body: { gig: saved } };
    },
    requireAuth,
    requireRole("host"),
  );

  /**
   * The caller's own gigs, for the host dashboard.
   *
   * Deliberately not `/v1/gigs/mine`: the router matches in registration order,
   * so a literal segment only beats `:gigId` by accident of ordering. A path
   * that cannot collide is one less thing to get wrong later.
   */
  router.get(
    "/v1/me/gigs",
    async (ctx) => {
      const gigs = await store.gigs.byHost(ctx.auth?.sub as string);
      gigs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { status: 200, body: { gigs } };
    },
    requireAuth,
    requireRole("host"),
  );

  /**
   * Open gigs a vendor can apply to, ranked by their own match score.
   *
   * The same scoring the host sees, so a vendor is never puzzled about why a
   * gig they were shown went to someone else -- and gigs they would be
   * disqualified from are not shown at all.
   */
  router.get(
    "/v1/discover/gigs",
    async (ctx) => {
      const vendorId = ctx.auth?.sub as string;
      const profile = await store.profiles.crew(vendorId);
      if (!profile) {
        throw new HttpError(400, "no_profile", "create a vendor profile to see matching gigs");
      }

      const candidate = await toCandidate(profile, store);
      const open = await store.gigs.open(profile.specialties);
      const applied = new Set<string>();
      for (const candidateGig of open) {
        const existing = await store.applications.byGig(candidateGig.id);
        if (existing.some((application) => application.vendorId === vendorId)) {
          applied.add(candidateGig.id);
        }
      }

      const scored = open
        .map((candidateGig) => {
          const [match] = rankCandidates([candidate], candidateGig.brief, {
            minScore: 0,
            includeRejected: true,
          });
          return {
            gig: candidateGig,
            score: match?.score ?? 0,
            breakdown: match?.breakdown,
            travelMiles: match?.travelMiles ?? 0,
            travelFeeCents: match?.travelFeeCents ?? 0,
            rejectedFor: match?.rejectedFor,
            alreadyApplied: applied.has(candidateGig.id),
          };
        })
        // A gig they cannot take is noise, not a listing.
        .filter((row) => !row.rejectedFor)
        .sort((a, b) => b.score - a.score);

      return { status: 200, body: { gigs: scored, count: scored.length } };
    },
    requireAuth,
    requireRole("crew", "creator"),
  );

  router.get(
    "/v1/gigs/:gigId",
    async (ctx) => {
      const gig = await loadGig(store, ctx.params.gigId as string);
      const actor = actorFor(ctx.auth?.roles ?? [], gig.hostId, ctx.auth?.sub as string);
      return {
        status: 200,
        body: { gig, allowedTransitions: allowedTransitions(gig.state, actor) },
      };
    },
    requireAuth,
  );

  /**
   * Publish a draft. This is where the match engine runs and the notification
   * waves are scheduled -- the 60-minute Time-to-Match clock starts here.
   */
  router.post(
    "/v1/gigs/:gigId/publish",
    async (ctx) => {
      const gig = await loadGig(store, ctx.params.gigId as string);
      requireOwner(gig.hostId, ctx.auth?.sub as string);
      applyTransition(gig, "Open", "host", ctx.auth?.sub as string);
      await store.gigs.save(gig);

      const profiles = await store.profiles.crewBySpecialty(gig.brief.specialty);
      const candidates = await Promise.all(profiles.map((profile) => toCandidate(profile, store)));
      const ranked = rankCandidates(candidates, gig.brief);
      const waves = planNotificationWaves(ranked, { hoursUntilEvent: hoursUntil(gig.brief.eventDate) });

      await bus.publish(TOPICS.gigPosted, gig.id, { gigId: gig.id, brief: gig.brief }, ctx.traceId);
      for (const wave of waves) {
        await bus.publish(TOPICS.matchWaveScheduled, gig.id, { gigId: gig.id, ...wave }, ctx.traceId);
      }

      return {
        status: 200,
        body: {
          gig,
          shortlist: ranked.slice(0, 10).map((match) => ({
            userId: match.userId,
            score: match.score,
            travelMiles: match.travelMiles,
          })),
          notificationWaves: waves,
        },
      };
    },
    requireAuth,
    requireRole("host"),
  );

  router.post(
    "/v1/gigs/:gigId/applications",
    async (ctx) => {
      const vendorId = ctx.auth?.sub as string;
      const gig = await loadGig(store, ctx.params.gigId as string);
      if (gig.state !== "Open" && gig.state !== "ApplicationsReview") {
        throw new HttpError(409, "not_accepting", `this gig is ${gig.state} and is not taking applications`);
      }
      const quotedRateCents = field(ctx, "quotedRateCents", isNumber);
      if (!Number.isInteger(quotedRateCents) || quotedRateCents <= 0) {
        throw new HttpError(400, "invalid_request", "quotedRateCents must be a positive integer of cents");
      }

      const existing = await store.applications.byGig(gig.id);
      if (existing.some((application) => application.vendorId === vendorId)) {
        throw new HttpError(409, "already_applied", "you have already applied to this gig");
      }

      const profile = await store.profiles.crew(vendorId);
      if (!profile) throw new HttpError(400, "no_profile", "create a crew profile before applying");
      if (!profile.specialties.includes(gig.brief.specialty)) {
        throw new HttpError(400, "specialty_mismatch", `this gig is for ${gig.brief.specialty}`);
      }

      const body = ctx.body as Record<string, unknown>;
      const application = await store.applications.create({
        id: randomUUID(),
        gigId: gig.id,
        vendorId,
        quotedRateCents,
        status: "submitted",
        createdAt: new Date().toISOString(),
        ...(typeof body.message === "string" ? { message: body.message.slice(0, 2000) } : {}),
      });

      gig.applicationCount += 1;
      if (gig.state === "Open") {
        applyTransition(gig, "ApplicationsReview", "system", "match-engine");
      }
      await store.gigs.save(gig);
      await bus.publish(
        TOPICS.applicationReceived,
        gig.id,
        { gigId: gig.id, applicationId: application.id, vendorId },
        ctx.traceId,
      );

      return { status: 201, body: { application } };
    },
    requireAuth,
    requireRole("crew", "creator"),
  );

  router.get(
    "/v1/gigs/:gigId/applications",
    async (ctx) => {
      const gig = await loadGig(store, ctx.params.gigId as string);
      requireOwner(gig.hostId, ctx.auth?.sub as string);
      const applications = await store.applications.byGig(gig.id);

      // Rank the applicants the same way the shortlist was built, so the host
      // sees one consistent notion of fit rather than two.
      const scored = await Promise.all(
        applications.map(async (application) => {
          const profile = await store.profiles.crew(application.vendorId);
          const user = await store.users.byId(application.vendorId);
          if (!profile) return { application, score: 0 };
          const [match] = rankCandidates([await toCandidate(profile, store)], gig.brief, {
            minScore: 0,
            includeRejected: true,
          });
          return {
            application,
            displayName: user?.displayName ?? "",
            score: match?.score ?? 0,
            breakdown: match?.breakdown,
            travelMiles: match?.travelMiles ?? 0,
          };
        }),
      );
      scored.sort((a, b) => b.score - a.score);
      return { status: 200, body: { applications: scored } };
    },
    requireAuth,
    requireRole("host"),
  );

  /** Accept an applicant. The booking is not confirmed until the deposit clears. */
  router.post(
    "/v1/gigs/:gigId/offer",
    async (ctx) => {
      const gig = await loadGig(store, ctx.params.gigId as string);
      requireOwner(gig.hostId, ctx.auth?.sub as string);
      const applicationId = field(ctx, "applicationId", isString);

      const application = await store.applications.byId(applicationId);
      if (!application || application.gigId !== gig.id) {
        throw new HttpError(404, "not_found", "no such application on this gig");
      }
      if (gig.acceptedOfferId) {
        throw new HttpError(409, "already_offered", "an offer has already been accepted on this gig");
      }

      application.status = "accepted";
      await store.applications.save(application);
      gig.acceptedOfferId = application.id;
      await store.gigs.save(gig);
      await bus.publish(
        TOPICS.offerExtended,
        gig.id,
        { gigId: gig.id, applicationId, vendorId: application.vendorId },
        ctx.traceId,
      );

      return {
        status: 200,
        body: {
          gig,
          application,
          next: "POST /v1/gigs/{gigId}/escrow to fund the deposit and confirm the booking",
        },
      };
    },
    requireAuth,
    requireRole("host"),
  );

  /** Drive any remaining transition the state machine permits. */
  router.post(
    "/v1/gigs/:gigId/transition",
    async (ctx) => {
      const gig = await loadGig(store, ctx.params.gigId as string);
      const userId = ctx.auth?.sub as string;
      const to = field(ctx, "to", isString) as GigState;
      const actor = actorFor(ctx.auth?.roles ?? [], gig.hostId, userId);
      if (actor === "host") requireOwner(gig.hostId, userId);

      const escrow = await store.escrows.byGig(gig.id);
      const body = ctx.body as Record<string, unknown>;

      applyTransition(gig, to, actor, userId, {
        depositFunded: escrow ? escrow.state !== "AwaitingDeposit" : false,
        hoursUntilEvent: hoursUntil(gig.brief.eventDate),
        ...(typeof body.cancellationReason === "string"
          ? { cancellationReason: body.cancellationReason }
          : {}),
        ...(typeof body.checkedInAtVenue === "boolean"
          ? { checkedInAtVenue: body.checkedInAtVenue }
          : {}),
      });
      await store.gigs.save(gig);
      await bus.publish(
        TOPICS.gigStateChanged,
        gig.id,
        { gigId: gig.id, state: gig.state, actor, actorId: userId },
        ctx.traceId,
      );

      return { status: 200, body: { gig, allowedTransitions: allowedTransitions(gig.state, actor) } };
    },
    requireAuth,
  );
}

function parseBrief(body: unknown): GigBrief {
  if (!isObject(body)) throw new HttpError(400, "invalid_request", "a gig brief is required");
  const eventType = body.eventType;
  const specialty = body.specialty;
  if (typeof eventType !== "string" || !isEventType(eventType)) {
    throw new HttpError(400, "invalid_request", `unknown event type: ${String(eventType)}`);
  }
  if (typeof specialty !== "string" || !isCrewSpecialty(specialty)) {
    throw new HttpError(400, "invalid_request", `unknown speciality: ${String(specialty)}`);
  }
  const venue = body.venue;
  if (!isObject(venue) || typeof venue.lat !== "number" || typeof venue.lng !== "number") {
    throw new HttpError(400, "invalid_request", "a venue latitude and longitude are required");
  }
  const venuePoint = { lat: venue.lat, lng: venue.lng };
  if (!withinPilotFootprint(venuePoint)) {
    throw new HttpError(400, "outside_footprint", "that venue is outside the Texas pilot footprint");
  }

  const brief: GigBrief = {
    eventType,
    specialty,
    eventDate: typeof body.eventDate === "string" ? body.eventDate : "",
    venue: venuePoint,
    metroId: nearestMetro(venuePoint).metro.id,
    budgetMinCents: typeof body.budgetMinCents === "number" ? body.budgetMinCents : 0,
    budgetMaxCents: typeof body.budgetMaxCents === "number" ? body.budgetMaxCents : 0,
    culturalTags: (Array.isArray(body.culturalTags) ? body.culturalTags : []) as never,
    languages: (Array.isArray(body.languages) ? body.languages : []) as never,
    ...(typeof body.headcount === "number" ? { headcount: body.headcount } : {}),
    ...(typeof body.notes === "string" ? { notes: body.notes.slice(0, 4000) } : {}),
  };

  if (!isBriefComplete(brief)) {
    throw new HttpError(
      400,
      "incomplete_brief",
      "a gig needs an event type, an ISO event date, a venue and a budget range",
    );
  }
  return brief;
}

async function loadGig(store: AppDeps["store"], gigId: string): Promise<Gig> {
  const gig = await store.gigs.byId(gigId);
  if (!gig) throw new HttpError(404, "not_found", "no such gig");
  return gig;
}

function requireOwner(hostId: string, userId: string): void {
  if (hostId !== userId) throw new HttpError(403, "forbidden", "this gig belongs to another host");
}

export function actorFor(roles: readonly string[], hostId: string, userId: string): Actor {
  if (roles.includes("admin")) return "admin";
  if (userId === hostId) return "host";
  return "vendor";
}

export function applyTransition(
  gig: Gig,
  to: GigState,
  actor: Actor,
  actorId: string,
  context: Parameters<typeof transition>[4] = {},
): void {
  try {
    transition(gig, to, actor, actorId, context);
  } catch (error) {
    if (error instanceof TransitionError) {
      throw new HttpError(409, error.code, error.message, {
        from: gig.state,
        to,
        allowed: allowedTransitions(gig.state, actor),
      });
    }
    throw error;
  }
}

/** Hours between now and the event's date. Negative once it has passed. */
export function hoursUntil(eventDate: string, now: Date = new Date()): number {
  const parsed = Date.parse(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return (parsed - now.getTime()) / 3_600_000;
}
