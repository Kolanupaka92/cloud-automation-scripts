/**
 * The typed client for the DESI-NEXUS API.
 *
 * Every call goes out from the server, never the browser. That is what keeps
 * the access token in an httpOnly cookie the page's own JavaScript cannot read:
 * a token in localStorage is one XSS away from being someone else's booking.
 */
import { cookies } from "next/headers";

const BASE_URL = process.env.API_URL ?? "http://127.0.0.1:8080";

export const ACCESS_COOKIE = "dn_access";
export const REFRESH_COOKIE = "dn_refresh";

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "ApiCallError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** Send the caller's bearer token. Off for public endpoints. */
  readonly authenticated?: boolean;
  /** Seconds to cache; omit for anything user-specific. */
  readonly revalidate?: number;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authenticated = true, revalidate } = options;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authenticated) {
    const token = (await cookies()).get(ACCESS_COOKIE)?.value;
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // User-specific reads must never be cached across users.
    ...(revalidate === undefined ? { cache: "no-store" as const } : { next: { revalidate } }),
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const error = (payload.error as ApiError | undefined) ?? {
      code: "unknown_error",
      message: `the API returned ${response.status}`,
    };
    throw new ApiCallError(response.status, error);
  }
  return payload as T;
}

/** Whether the caller is signed in at all. */
export async function isSignedIn(): Promise<boolean> {
  return Boolean((await cookies()).get(ACCESS_COOKIE)?.value);
}

// --- Response shapes, mirroring the API's public projections -----------------

export interface PublicUser {
  readonly id: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly verification: string;
  readonly mfaEnabled: boolean;
  readonly metroId: string;
  readonly languages: string[];
  readonly createdAt: string;
}

export interface Taxonomy {
  readonly eventGroups: Record<string, string[]>;
  readonly crewSpecialties: string[];
  readonly culturalTags: string[];
  readonly languages: string[];
  readonly metros: Array<{ id: string; name: string; center: { lat: number; lng: number }; radiusMiles: number }>;
}

export interface GigBrief {
  readonly eventType: string;
  readonly specialty: string;
  readonly eventDate: string;
  readonly venue: { lat: number; lng: number };
  readonly metroId: string;
  readonly budgetMinCents: number;
  readonly budgetMaxCents: number;
  readonly culturalTags: string[];
  readonly languages: string[];
  readonly headcount?: number;
  readonly notes?: string;
}

export interface Gig {
  readonly id: string;
  readonly hostId: string;
  readonly state: string;
  readonly brief: GigBrief;
  readonly applicationCount: number;
  readonly acceptedOfferId?: string;
  readonly escrowId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: Array<{ from: string; to: string; actor: string; at: string; reason?: string }>;
}

export interface ScoreBreakdown {
  readonly cultural: number;
  readonly proximity: number;
  readonly budget: number;
  readonly language: number;
  readonly reputation: number;
  readonly responsiveness: number;
}

export interface MatchRow {
  readonly userId: string;
  readonly displayName: string;
  readonly metroId: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly travelMiles: number;
  readonly travelFeeCents: number;
}

export interface ApplicantRow {
  readonly application: {
    readonly id: string;
    readonly vendorId: string;
    readonly quotedRateCents: number;
    readonly message?: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly displayName?: string;
  readonly score: number;
  readonly breakdown?: ScoreBreakdown;
  readonly travelMiles: number;
}

export const taxonomy = () =>
  apiFetch<Taxonomy>("/v1/taxonomy", { authenticated: false, revalidate: 3600 });

export const me = () => apiFetch<{ user: PublicUser; session: { mfa: boolean } }>("/v1/me");

export const gig = (id: string) =>
  apiFetch<{ gig: Gig; allowedTransitions: string[] }>(`/v1/gigs/${id}`);

export const applicants = (id: string) =>
  apiFetch<{ applications: ApplicantRow[] }>(`/v1/gigs/${id}/applications`);
