/**
 * The polymorphic user model.
 *
 * One base identity, three profile shapes. A person is routinely more than one
 * of these -- a boutique owner in Frisco hosts gigs on Monday and models for a
 * lookbook on Saturday -- so roles are a set on the base user rather than three
 * separate account types.
 */
import {
  isCrewSpecialty,
  isCulturalTag,
  isLanguage,
  type CreatorDiscipline,
  type CrewSpecialty,
  type CulturalTag,
  type Language,
} from "./taxonomy.js";
import { type LatLng, nearestMetro, withinPilotFootprint } from "./geo.js";
import type { TravelPolicy } from "./geo.js";
import type { Cents } from "./money.js";

export type Role = "host" | "crew" | "creator" | "admin";

export type VerificationLevel =
  /** Email confirmed only. Can browse, cannot transact. */
  | "unverified"
  /** Phone OTP confirmed. Can apply to gigs. */
  | "phone_verified"
  /** Government ID checked. Required to receive payouts. */
  | "id_verified"
  /** ID plus Stripe Connect onboarding complete, with a business record. */
  | "business_verified";

export const VERIFICATION_ORDER: readonly VerificationLevel[] = [
  "unverified",
  "phone_verified",
  "id_verified",
  "business_verified",
];

export function meetsVerification(actual: VerificationLevel, required: VerificationLevel): boolean {
  return VERIFICATION_ORDER.indexOf(actual) >= VERIFICATION_ORDER.indexOf(required);
}

export interface BaseUser {
  readonly id: string;
  email: string;
  phone?: string;
  displayName: string;
  roles: Role[];
  verification: VerificationLevel;
  /** MFA is mandatory before any wallet or payout surface is reachable. */
  mfaEnabled: boolean;
  homeBase: LatLng;
  metroId: string;
  languages: Language[];
  readonly createdAt: string;
  suspendedAt?: string;
}

export interface HostProfile {
  readonly userId: string;
  /** A boutique or agency, as against a family booking their own function. */
  readonly kind: "business" | "individual";
  businessName?: string;
  /** Free-form, e.g. "Bridal boutique, 2 locations". Not used for matching. */
  about?: string;
  eventsHosted: number;
  /** Rating vendors give the host: pays on time, brief matches reality. */
  ratingAvg?: number;
  ratingCount: number;
}

export interface CrewProfile {
  readonly userId: string;
  specialties: CrewSpecialty[];
  culturalTags: CulturalTag[];
  /** Base rate used for budget filtering before a formal offer exists. */
  startingRateCents: Cents;
  travelPolicy: Partial<TravelPolicy>;
  /** ISO dates the vendor has blocked out. */
  unavailableDates: string[];
  yearsExperience: number;
  ratingAvg?: number;
  ratingCount: number;
  completedGigs: number;
  /** Median minutes to first reply, used to hit the 60-minute match target. */
  medianResponseMinutes?: number;
  portfolioAssetIds: string[];
  stripeAccountId?: string;
}

export interface CreatorProfile {
  readonly userId: string;
  disciplines: CreatorDiscipline[];
  culturalTags: CulturalTag[];
  heightCm?: number;
  /** Handle plus the follower count verified through the platform's OAuth. */
  socials: SocialAccount[];
  ratePerPostCents?: Cents;
  dayRateCents?: Cents;
  unavailableDates: string[];
  portfolioAssetIds: string[];
  ratingAvg?: number;
  ratingCount: number;
  stripeAccountId?: string;
}

export interface SocialAccount {
  readonly platform: "instagram" | "tiktok" | "youtube";
  handle: string;
  followers: number;
  /** Share of the audience inside Texas. A 400k national account is worth less
   *  to a Sugar Land boutique than a 20k account that is 70% Houston. */
  texasAudienceShare?: number;
  engagementRate?: number;
  /** Set when the handle was proven via platform OAuth, not merely typed in. */
  verifiedAt?: string;
}

/**
 * Local reach: the metric the boutiques actually buy. A creator with a large
 * but diffuse audience scores below a smaller, genuinely local one.
 */
export function localReach(account: SocialAccount): number {
  const share = account.texasAudienceShare ?? 0.15;
  const engagement = account.engagementRate ?? 0.02;
  return Math.round(account.followers * share * Math.min(1, engagement / 0.02));
}

export function totalLocalReach(profile: Pick<CreatorProfile, "socials">): number {
  return profile.socials.reduce((sum, account) => sum + localReach(account), 0);
}

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** E.164, which is what the OTP provider wants. */
const PHONE = /^\+1\d{10}$/;

export function validateBaseUser(input: Partial<BaseUser>): void {
  if (!input.email || !EMAIL.test(input.email)) {
    throw new ValidationError("email", "a valid email address is required");
  }
  if (input.phone && !PHONE.test(input.phone)) {
    throw new ValidationError("phone", "phone must be E.164, e.g. +14695550123");
  }
  if (!input.displayName || input.displayName.trim().length < 2) {
    throw new ValidationError("displayName", "a display name of at least 2 characters is required");
  }
  if (!input.roles?.length) {
    throw new ValidationError("roles", "at least one role is required");
  }
  for (const role of input.roles) {
    if (!["host", "crew", "creator", "admin"].includes(role)) {
      throw new ValidationError("roles", `unknown role: ${role}`);
    }
  }
  if (!input.homeBase || !Number.isFinite(input.homeBase.lat) || !Number.isFinite(input.homeBase.lng)) {
    throw new ValidationError("homeBase", "a home base latitude and longitude are required");
  }
  if (!withinPilotFootprint(input.homeBase)) {
    const { metro, miles } = nearestMetro(input.homeBase);
    throw new ValidationError(
      "homeBase",
      `outside the Texas pilot footprint: the nearest covered metro is ${metro.name}, ${Math.round(miles)} miles away`,
    );
  }
  for (const language of input.languages ?? []) {
    if (!isLanguage(language)) throw new ValidationError("languages", `unknown language: ${language}`);
  }
}

export function validateCrewProfile(input: Partial<CrewProfile>): void {
  if (!input.specialties?.length) {
    throw new ValidationError("specialties", "at least one speciality is required");
  }
  for (const specialty of input.specialties) {
    if (!isCrewSpecialty(specialty)) {
      throw new ValidationError("specialties", `unknown speciality: ${specialty}`);
    }
  }
  for (const tag of input.culturalTags ?? []) {
    if (!isCulturalTag(tag)) throw new ValidationError("culturalTags", `unknown cultural tag: ${tag}`);
  }
  if (typeof input.startingRateCents !== "number" || input.startingRateCents <= 0) {
    throw new ValidationError("startingRateCents", "a starting rate above zero is required");
  }
}

/**
 * Payouts require ID verification and MFA, with no exceptions and no admin
 * override. This is the control that stops a compromised password from
 * redirecting a vendor's money.
 */
export function canReceivePayouts(user: BaseUser, stripeAccountId?: string): { ok: boolean; reason?: string } {
  if (user.suspendedAt) return { ok: false, reason: "account is suspended" };
  if (!meetsVerification(user.verification, "id_verified")) {
    return { ok: false, reason: "identity verification is incomplete" };
  }
  if (!user.mfaEnabled) return { ok: false, reason: "multi-factor authentication is not enabled" };
  if (!stripeAccountId) return { ok: false, reason: "Stripe Connect onboarding is not complete" };
  return { ok: true };
}
