/**
 * The match engine.
 *
 * The North Star metric is Time-to-Match: a host posting a gig should have
 * verified, genuinely available local talent in front of them inside 60
 * minutes. That is a ranking problem and a notification problem, and this
 * module owns both halves: score every candidate, then decide who gets pinged
 * and in what order.
 *
 * Every score is returned with its component breakdown. An opaque score is
 * unsupportable -- when a vendor asks why they stopped seeing Sangeet gigs, the
 * answer has to be a specific number, not a shrug.
 */
import { tagAffinity, type CulturalTag, type Language } from "./taxonomy.js";
import { quoteTravel, type LatLng, type TravelPolicy } from "./geo.js";
import type { Cents } from "./money.js";
import type { GigBrief } from "./gig.js";

export interface Candidate {
  readonly userId: string;
  readonly specialties: readonly string[];
  readonly culturalTags: readonly CulturalTag[];
  readonly languages: readonly Language[];
  readonly homeBase: LatLng;
  readonly startingRateCents: Cents;
  readonly travelPolicy?: Partial<TravelPolicy>;
  readonly unavailableDates?: readonly string[];
  readonly ratingAvg?: number;
  readonly ratingCount?: number;
  readonly completedGigs?: number;
  readonly medianResponseMinutes?: number;
  /** Payout-ready: ID verified, MFA on, Stripe Connect live. */
  readonly payoutReady?: boolean;
}

/** Weights sum to 1.0; the assertion in the tests keeps that honest. */
export const WEIGHTS = {
  cultural: 0.3,
  proximity: 0.22,
  budget: 0.16,
  language: 0.12,
  reputation: 0.12,
  responsiveness: 0.08,
} as const;

export interface ScoreBreakdown {
  readonly cultural: number;
  readonly proximity: number;
  readonly budget: number;
  readonly language: number;
  readonly reputation: number;
  readonly responsiveness: number;
}

export interface MatchResult {
  readonly userId: string;
  /** 0-100, rounded. */
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly travelMiles: number;
  readonly travelFeeCents: Cents;
  /** Why a candidate was dropped, when they were. */
  readonly rejectedFor?: string;
}

/** Hard filters. Failing any of these removes the candidate outright. */
export function disqualify(candidate: Candidate, brief: GigBrief): string | undefined {
  if (!candidate.specialties.includes(brief.specialty)) {
    return `does not offer ${brief.specialty}`;
  }
  if (candidate.unavailableDates?.includes(brief.eventDate)) {
    return `unavailable on ${brief.eventDate}`;
  }
  if (candidate.payoutReady === false) {
    return "cannot receive payouts yet";
  }
  const travel = quoteTravel(candidate.homeBase, brief.venue, candidate.travelPolicy);
  if (travel.outOfRange) {
    return `venue is ${travel.miles} miles away, beyond their travel radius`;
  }
  // A vendor whose floor is above the host's ceiling wastes both parties' time.
  // 15% of headroom is allowed, because rates are negotiable at the margin.
  if (candidate.startingRateCents > brief.budgetMaxCents * 1.15) {
    return "starting rate is above the posted budget";
  }
  return undefined;
}

/**
 * Cultural fit. Exact tag matches score full, adjacent styles half. A brief
 * with no tags scores neutral rather than zero, so an untagged corporate gig
 * does not rank everyone identically at the bottom.
 */
export function culturalScore(required: readonly CulturalTag[], offered: readonly CulturalTag[]): number {
  if (required.length === 0) return 0.6;
  if (offered.length === 0) return 0;
  let total = 0;
  for (const tag of required) {
    let best = 0;
    for (const candidateTag of offered) {
      best = Math.max(best, tagAffinity(tag, candidateTag));
      if (best === 1) break;
    }
    total += best;
  }
  return total / required.length;
}

/**
 * Proximity decays smoothly rather than stepping at a metro boundary: a vendor
 * in Plano and one in Denton are both serving a Frisco gig, and the fence
 * between DFW sub-cities is a map artefact, not a real constraint.
 */
export function proximityScore(miles: number): number {
  if (miles <= 15) return 1;
  if (miles >= 250) return 0;
  return Math.max(0, 1 - Math.log10(miles / 15) / Math.log10(250 / 15));
}

/** Rewards a rate comfortably inside the budget, without punishing the cheapest. */
export function budgetScore(rateCents: Cents, brief: GigBrief): number {
  const { budgetMinCents: min, budgetMaxCents: max } = brief;
  if (max <= 0) return 0.5;
  if (rateCents <= min) return 1;
  if (rateCents <= max) return 1 - (0.35 * (rateCents - min)) / Math.max(1, max - min);
  const overBy = (rateCents - max) / max;
  return Math.max(0, 0.65 - overBy * 3);
}

export function languageScore(required: readonly Language[], spoken: readonly Language[]): number {
  if (required.length === 0) return 1;
  const set = new Set(spoken);
  const matched = required.filter((language) => set.has(language)).length;
  return matched / required.length;
}

/**
 * Bayesian-smoothed rating, so a single five-star review does not outrank a
 * hundred jobs at 4.8. New vendors sit at the prior and climb from there,
 * which keeps the supply side joinable.
 */
export const RATING_PRIOR = 4.2;
export const RATING_PRIOR_WEIGHT = 8;

export function reputationScore(candidate: Candidate): number {
  const count = candidate.ratingCount ?? 0;
  const average = candidate.ratingAvg ?? RATING_PRIOR;
  const smoothed =
    (average * count + RATING_PRIOR * RATING_PRIOR_WEIGHT) / (count + RATING_PRIOR_WEIGHT);
  const rating = Math.max(0, Math.min(1, (smoothed - 1) / 4));
  // A track record of completed gigs is worth a modest, capped bonus.
  const experience = Math.min(1, (candidate.completedGigs ?? 0) / 40);
  return rating * 0.8 + experience * 0.2;
}

/** Fast repliers rank higher, because Time-to-Match is the metric. */
export function responsivenessScore(medianResponseMinutes: number | undefined): number {
  if (medianResponseMinutes === undefined) return 0.5;
  if (medianResponseMinutes <= 10) return 1;
  if (medianResponseMinutes >= 24 * 60) return 0;
  return Math.max(0, 1 - Math.log10(medianResponseMinutes / 10) / Math.log10(144));
}

export function scoreCandidate(candidate: Candidate, brief: GigBrief): MatchResult {
  const rejectedFor = disqualify(candidate, brief);
  const travel = quoteTravel(candidate.homeBase, brief.venue, candidate.travelPolicy);

  if (rejectedFor) {
    return {
      userId: candidate.userId,
      score: 0,
      breakdown: { cultural: 0, proximity: 0, budget: 0, language: 0, reputation: 0, responsiveness: 0 },
      travelMiles: travel.miles,
      travelFeeCents: travel.totalCents,
      rejectedFor,
    };
  }

  const breakdown: ScoreBreakdown = {
    cultural: culturalScore(brief.culturalTags, candidate.culturalTags),
    proximity: proximityScore(travel.miles),
    budget: budgetScore(candidate.startingRateCents, brief),
    language: languageScore(brief.languages, candidate.languages),
    reputation: reputationScore(candidate),
    responsiveness: responsivenessScore(candidate.medianResponseMinutes),
  };

  const weighted =
    breakdown.cultural * WEIGHTS.cultural +
    breakdown.proximity * WEIGHTS.proximity +
    breakdown.budget * WEIGHTS.budget +
    breakdown.language * WEIGHTS.language +
    breakdown.reputation * WEIGHTS.reputation +
    breakdown.responsiveness * WEIGHTS.responsiveness;

  return {
    userId: candidate.userId,
    score: Math.round(weighted * 100),
    breakdown,
    travelMiles: travel.miles,
    travelFeeCents: travel.totalCents,
  };
}

export interface RankOptions {
  readonly limit?: number;
  /** Drop anything below this score even if the shortlist is short. */
  readonly minScore?: number;
  readonly includeRejected?: boolean;
}

export function rankCandidates(
  candidates: readonly Candidate[],
  brief: GigBrief,
  options: RankOptions = {},
): MatchResult[] {
  const { limit = 25, minScore = 25, includeRejected = false } = options;
  const scored = candidates.map((candidate) => scoreCandidate(candidate, brief));
  const eligible = scored.filter((result) =>
    includeRejected ? true : !result.rejectedFor && result.score >= minScore,
  );
  eligible.sort((a, b) => b.score - a.score || a.travelMiles - b.travelMiles || a.userId.localeCompare(b.userId));
  return eligible.slice(0, limit);
}

/**
 * Notification fan-out.
 *
 * Blasting every eligible vendor at once gets the host thirty applications and
 * twenty-nine disappointed vendors, and trains everyone to ignore the push.
 * Instead the shortlist goes out in waves: the strongest matches get an
 * exclusive head start, and the next wave only fires if the gig is still short
 * of applications. Urgent gigs collapse the waves, because a Saturday-morning
 * cancellation cannot wait 45 minutes for wave three.
 */
export interface NotificationWave {
  readonly wave: number;
  readonly userIds: readonly string[];
  /** Minutes after posting that this wave fires. */
  readonly delayMinutes: number;
}

export function planNotificationWaves(
  ranked: readonly MatchResult[],
  options: { hoursUntilEvent?: number; targetApplications?: number } = {},
): NotificationWave[] {
  const { hoursUntilEvent = 24 * 30, targetApplications = 5 } = options;
  if (ranked.length === 0) return [];

  // Inside 72 hours the gig is urgent: everyone hears about it immediately.
  const urgent = hoursUntilEvent <= 72;
  const sizes = urgent
    ? [ranked.length]
    : [Math.max(targetApplications, 3), targetApplications * 2, ranked.length];
  const delays = urgent ? [0] : [0, 15, 40];

  const waves: NotificationWave[] = [];
  let cursor = 0;
  for (let i = 0; i < sizes.length && cursor < ranked.length; i += 1) {
    const size = sizes[i] ?? ranked.length;
    const slice = ranked.slice(cursor, cursor + size);
    if (slice.length === 0) break;
    waves.push({
      wave: i + 1,
      userIds: slice.map((result) => result.userId),
      delayMinutes: delays[i] ?? 60,
    });
    cursor += slice.length;
  }
  return waves;
}
