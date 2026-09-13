/**
 * Geofencing and travel economics for Texas.
 *
 * Texas is the whole problem. DFW to Greater Houston is ~240 miles, which is
 * further than London to Paris, and a MUA who says "I cover Texas" means
 * something very different from one who says "I cover Frisco". Every match is
 * therefore filtered on a real distance, and every cross-metro booking carries
 * a travel fee computed the same way for both sides before anyone commits.
 */
import { assertCents, type Cents } from "./money.js";

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface Metro {
  readonly id: string;
  readonly name: string;
  readonly center: LatLng;
  /** Miles from the centre still considered "in metro" for fee purposes. */
  readonly radiusMiles: number;
}

/** The pilot footprint. Centres are metro centroids, not city halls. */
export const TEXAS_METROS: readonly Metro[] = [
  { id: "dfw", name: "Dallas-Fort Worth", center: { lat: 32.8, lng: -97.05 }, radiusMiles: 45 },
  { id: "hou", name: "Greater Houston", center: { lat: 29.79, lng: -95.42 }, radiusMiles: 45 },
  { id: "aus", name: "Austin", center: { lat: 30.31, lng: -97.75 }, radiusMiles: 32 },
  { id: "sat", name: "San Antonio", center: { lat: 29.47, lng: -98.52 }, radiusMiles: 32 },
  { id: "elp", name: "El Paso", center: { lat: 31.79, lng: -106.42 }, radiusMiles: 25 },
  { id: "rgv", name: "Rio Grande Valley", center: { lat: 26.23, lng: -98.13 }, radiusMiles: 35 },
  { id: "cc", name: "Corpus Christi", center: { lat: 27.78, lng: -97.42 }, radiusMiles: 25 },
  { id: "lbb", name: "Lubbock", center: { lat: 33.58, lng: -101.86 }, radiusMiles: 20 },
];

const METRO_BY_ID = new Map(TEXAS_METROS.map((m) => [m.id, m]));

export function metroById(id: string): Metro | undefined {
  return METRO_BY_ID.get(id);
}

const EARTH_RADIUS_MILES = 3958.7613;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in miles.
 *
 * This is the cheap filter that runs against every candidate in the index. A
 * road-distance call to the Distance Matrix API is made only for the shortlist
 * that survives it, because billing a Maps request per candidate per gig does
 * not survive contact with a busy Saturday.
 */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight-line miles understate what the driver actually drives. Until a road
 * distance is fetched for the shortlist, inflate by a metro-typical factor so
 * quotes are not systematically low.
 */
export const ROAD_DETOUR_FACTOR = 1.18;

export function estimatedRoadMiles(a: LatLng, b: LatLng): number {
  return haversineMiles(a, b) * ROAD_DETOUR_FACTOR;
}

export function nearestMetro(point: LatLng): { metro: Metro; miles: number } {
  let best: { metro: Metro; miles: number } | undefined;
  for (const metro of TEXAS_METROS) {
    const miles = haversineMiles(point, metro.center);
    if (!best || miles < best.miles) best = { metro, miles };
  }
  // TEXAS_METROS is non-empty, so this is always assigned.
  return best as { metro: Metro; miles: number };
}

/** Whether the point sits inside any pilot metro's fence. */
export function withinPilotFootprint(point: LatLng): boolean {
  const { metro, miles } = nearestMetro(point);
  return miles <= metro.radiusMiles;
}

export interface TravelPolicy {
  /** Miles the vendor absorbs before charging anything. */
  readonly freeRadiusMiles: number;
  /** Charged per mile beyond the free radius, in cents, round trip. */
  readonly perMileCents: Cents;
  /** Hard limit on how far the vendor will travel at all. */
  readonly maxRadiusMiles: number;
  /** Beyond this, the job needs a hotel the night before. */
  readonly overnightThresholdMiles: number;
  /** Flat lodging/per-diem charge when the overnight threshold is crossed. */
  readonly overnightCents: Cents;
}

export const DEFAULT_TRAVEL_POLICY: TravelPolicy = {
  freeRadiusMiles: 25,
  perMileCents: 90,
  maxRadiusMiles: 300,
  overnightThresholdMiles: 120,
  overnightCents: 18_000,
};

export function normalizeTravelPolicy(input: Partial<TravelPolicy> | undefined): TravelPolicy {
  const policy = { ...DEFAULT_TRAVEL_POLICY, ...(input ?? {}) };
  assertCents(policy.perMileCents, "perMileCents");
  assertCents(policy.overnightCents, "overnightCents");
  for (const key of ["freeRadiusMiles", "maxRadiusMiles", "overnightThresholdMiles"] as const) {
    const value = policy[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }
  if (policy.maxRadiusMiles < policy.freeRadiusMiles) {
    throw new Error("maxRadiusMiles must be at least freeRadiusMiles");
  }
  return policy;
}

export interface TravelQuote {
  readonly miles: number;
  readonly billableMiles: number;
  readonly mileageCents: Cents;
  readonly overnightCents: Cents;
  readonly totalCents: Cents;
  readonly outOfRange: boolean;
  readonly requiresOvernight: boolean;
}

/**
 * Price a round trip from the vendor's base to the venue.
 *
 * Mileage is billed both ways: the vendor drives home, and a 9am Griha
 * Pravesham in Katy booked out of Plano is two long drives, not one.
 */
export function quoteTravel(
  base: LatLng,
  venue: LatLng,
  input?: Partial<TravelPolicy>,
): TravelQuote {
  const policy = normalizeTravelPolicy(input);
  const miles = round1(estimatedRoadMiles(base, venue));
  const outOfRange = miles > policy.maxRadiusMiles;
  const billableMiles = round1(Math.max(0, miles - policy.freeRadiusMiles));
  const requiresOvernight = miles >= policy.overnightThresholdMiles;

  if (outOfRange) {
    return {
      miles,
      billableMiles: 0,
      mileageCents: 0,
      overnightCents: 0,
      totalCents: 0,
      outOfRange: true,
      requiresOvernight,
    };
  }

  const mileageCents = Math.round(billableMiles * 2 * policy.perMileCents);
  const overnightCents = requiresOvernight ? policy.overnightCents : 0;
  return {
    miles,
    billableMiles,
    mileageCents,
    overnightCents,
    totalCents: mileageCents + overnightCents,
    outOfRange: false,
    requiresOvernight,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
