/**
 * The gig lifecycle, as an explicit state machine.
 *
 * Every transition is guarded. The reason this is a table rather than a pile of
 * `if` statements in route handlers is that money moves on some of these edges:
 * an unguarded jump from ApplicationsReview to Active would run a gig with no
 * funds held, which is precisely the failure the escrow exists to prevent.
 */
import type { CrewSpecialty, CulturalTag, EventType, Language } from "./taxonomy.js";
import type { Cents } from "./money.js";
import type { LatLng } from "./geo.js";

export const GIG_STATES = [
  "Draft",
  "Open",
  "ApplicationsReview",
  "EscrowLocked",
  "InTransit",
  "Active",
  "DeliveryPending",
  "Completed",
  "Cancelled",
  "Disputed",
] as const;
export type GigState = (typeof GIG_STATES)[number];

export const TERMINAL_STATES: readonly GigState[] = ["Completed", "Cancelled"];

/** Which actor is allowed to drive a given transition. */
export type Actor = "host" | "vendor" | "system" | "admin";

export interface Transition {
  readonly from: GigState;
  readonly to: GigState;
  readonly actors: readonly Actor[];
  /** Human-readable reason, surfaced in the audit log and the 409 body. */
  readonly requires?: string;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "Draft", to: "Open", actors: ["host"], requires: "a complete brief: event type, date, venue and budget" },
  { from: "Draft", to: "Cancelled", actors: ["host", "admin"] },

  { from: "Open", to: "ApplicationsReview", actors: ["host", "system"], requires: "at least one application" },
  { from: "Open", to: "Cancelled", actors: ["host", "admin"] },

  { from: "ApplicationsReview", to: "Open", actors: ["host"], requires: "no offer has been accepted yet" },
  { from: "ApplicationsReview", to: "EscrowLocked", actors: ["host", "system"], requires: "an accepted offer and a funded deposit" },
  { from: "ApplicationsReview", to: "Cancelled", actors: ["host", "admin"] },

  { from: "EscrowLocked", to: "InTransit", actors: ["vendor", "system"], requires: "the event date is within the call-time window" },
  { from: "EscrowLocked", to: "Cancelled", actors: ["host", "vendor", "admin"], requires: "a cancellation reason, so the refund tier can be applied" },
  { from: "EscrowLocked", to: "Disputed", actors: ["host", "vendor", "admin"] },

  { from: "InTransit", to: "Active", actors: ["vendor", "system"], requires: "vendor check-in at the venue" },
  { from: "InTransit", to: "Disputed", actors: ["host", "vendor", "admin"] },
  { from: "InTransit", to: "Cancelled", actors: ["admin"], requires: "an admin override: the vendor is already travelling" },

  { from: "Active", to: "DeliveryPending", actors: ["vendor"], requires: "the vendor marking the service delivered" },
  { from: "Active", to: "Disputed", actors: ["host", "vendor", "admin"] },

  { from: "DeliveryPending", to: "Completed", actors: ["host", "system"], requires: "host sign-off, or the auto-release window elapsing" },
  { from: "DeliveryPending", to: "Disputed", actors: ["host", "admin"] },

  { from: "Disputed", to: "Completed", actors: ["admin"], requires: "a dispute resolution in the vendor's favour" },
  { from: "Disputed", to: "Cancelled", actors: ["admin"], requires: "a dispute resolution in the host's favour" },
];

const TRANSITION_INDEX = new Map<string, Transition>(
  TRANSITIONS.map((t) => [`${t.from}>${t.to}`, t] as const),
);

export interface GigBrief {
  readonly eventType: EventType;
  readonly specialty: CrewSpecialty;
  /** ISO date of the event, e.g. "2026-11-14". */
  readonly eventDate: string;
  readonly venue: LatLng;
  readonly metroId: string;
  readonly budgetMinCents: Cents;
  readonly budgetMaxCents: Cents;
  readonly culturalTags: readonly CulturalTag[];
  readonly languages: readonly Language[];
  readonly headcount?: number;
  readonly notes?: string;
}

export interface Gig {
  readonly id: string;
  readonly hostId: string;
  state: GigState;
  brief: GigBrief;
  applicationCount: number;
  acceptedOfferId?: string;
  escrowId?: string;
  cancellationReason?: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Append-only audit trail; the ledger reconciles against this. */
  readonly history: TransitionRecord[];
}

export interface TransitionRecord {
  readonly from: GigState;
  readonly to: GigState;
  readonly actor: Actor;
  readonly actorId: string;
  readonly at: string;
  readonly reason?: string;
}

export class TransitionError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_transition") {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}

/** Facts the guards need that do not live on the gig itself. */
export interface TransitionContext {
  /** True once the deposit PaymentIntent has actually been captured. */
  readonly depositFunded?: boolean;
  /** Hours until the event starts; negative once it has begun. */
  readonly hoursUntilEvent?: number;
  readonly cancellationReason?: string;
  /** Set when the vendor's check-in carries a venue-proximate location fix. */
  readonly checkedInAtVenue?: boolean;
  /** Hours the delivery has been awaiting host sign-off. */
  readonly hoursAwaitingSignoff?: number;
}

/** Hours after delivery before funds auto-release, so vendors are not held hostage. */
export const AUTO_RELEASE_HOURS = 72;

/** Vendors may start travelling this many hours before the event. */
export const CALL_TIME_WINDOW_HOURS = 24;

export function canTransition(from: GigState, to: GigState, actor: Actor): boolean {
  const transition = TRANSITION_INDEX.get(`${from}>${to}`);
  return Boolean(transition && transition.actors.includes(actor));
}

export function allowedTransitions(from: GigState, actor: Actor): GigState[] {
  return TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.to);
}

export function isBriefComplete(brief: GigBrief | undefined): boolean {
  if (!brief) return false;
  return Boolean(
    brief.eventType &&
      brief.specialty &&
      /^\d{4}-\d{2}-\d{2}$/.test(brief.eventDate ?? "") &&
      brief.venue &&
      Number.isFinite(brief.venue.lat) &&
      Number.isFinite(brief.venue.lng) &&
      brief.budgetMaxCents > 0 &&
      brief.budgetMaxCents >= brief.budgetMinCents,
  );
}

/**
 * Apply a transition, or throw explaining exactly which guard failed.
 *
 * Mutates the gig and appends to its history only once every check has passed,
 * so a rejected transition leaves no trace and no partial state.
 */
export function transition(
  gig: Gig,
  to: GigState,
  actor: Actor,
  actorId: string,
  context: TransitionContext = {},
  now: Date = new Date(),
): Gig {
  const from = gig.state;
  if (from === to) throw new TransitionError(`gig is already ${to}`, "no_op");

  const edge = TRANSITION_INDEX.get(`${from}>${to}`);
  if (!edge) {
    throw new TransitionError(
      `cannot move a gig from ${from} to ${to}; allowed from ${from}: ${
        allowedTransitions(from, actor).join(", ") || "nothing"
      }`,
    );
  }
  if (!edge.actors.includes(actor)) {
    throw new TransitionError(
      `${actor} may not move a gig from ${from} to ${to}; that is for: ${edge.actors.join(", ")}`,
      "forbidden_actor",
    );
  }

  const failure = guard(gig, edge, context);
  if (failure) throw new TransitionError(failure, "guard_failed");

  gig.state = to;
  gig.updatedAt = now.toISOString();
  if (to === "Cancelled" && context.cancellationReason) {
    gig.cancellationReason = context.cancellationReason;
  }
  gig.history.push({
    from,
    to,
    actor,
    actorId,
    at: gig.updatedAt,
    ...(edge.requires ? { reason: edge.requires } : {}),
  });
  return gig;
}

function guard(gig: Gig, edge: Transition, ctx: TransitionContext): string | undefined {
  switch (`${edge.from}>${edge.to}`) {
    case "Draft>Open":
      return isBriefComplete(gig.brief)
        ? undefined
        : "the brief is incomplete: an event type, date, venue and budget are all required before a gig goes live";

    case "Open>ApplicationsReview":
      return gig.applicationCount > 0 ? undefined : "no applications have been received yet";

    case "ApplicationsReview>Open":
      return gig.acceptedOfferId
        ? "an offer has already been accepted; cancel the booking instead of reopening it"
        : undefined;

    case "ApplicationsReview>EscrowLocked":
      if (!gig.acceptedOfferId) return "no offer has been accepted";
      return ctx.depositFunded
        ? undefined
        : "the deposit has not cleared; funds must be held before the booking is confirmed";

    case "EscrowLocked>InTransit":
      if (ctx.hoursUntilEvent === undefined) return undefined;
      return ctx.hoursUntilEvent <= CALL_TIME_WINDOW_HOURS
        ? undefined
        : `too early to travel: the event is ${Math.round(ctx.hoursUntilEvent)}h away and the call-time window is ${CALL_TIME_WINDOW_HOURS}h`;

    case "EscrowLocked>Cancelled":
      return ctx.cancellationReason
        ? undefined
        : "a cancellation reason is required once funds are held, so the refund tier can be applied";

    case "InTransit>Active":
      return ctx.checkedInAtVenue === false
        ? "check-in was not recorded at the venue"
        : undefined;

    case "DeliveryPending>Completed":
      if (ctx.hoursAwaitingSignoff !== undefined && ctx.hoursAwaitingSignoff >= AUTO_RELEASE_HOURS) {
        return undefined;
      }
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Cancellation refund tiers, in the host's favour the earlier they cancel.
 * Returns the fraction of the host's total that is refunded.
 */
export function refundFraction(hoursUntilEvent: number, cancelledBy: Actor): number {
  // A vendor who drops the booking refunds the host in full, always. Vendor
  // ghosting is the single loudest complaint in this market; the platform eats
  // the processing cost rather than passing it to the family.
  if (cancelledBy === "vendor") return 1;
  if (hoursUntilEvent >= 30 * 24) return 1;
  if (hoursUntilEvent >= 14 * 24) return 0.75;
  if (hoursUntilEvent >= 7 * 24) return 0.5;
  if (hoursUntilEvent >= 48) return 0.25;
  return 0;
}
