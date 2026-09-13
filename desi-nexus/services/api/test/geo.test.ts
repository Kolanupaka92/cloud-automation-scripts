import test from "node:test";
import assert from "node:assert/strict";
import {
  TEXAS_METROS,
  haversineMiles,
  nearestMetro,
  quoteTravel,
  withinPilotFootprint,
  normalizeTravelPolicy,
} from "../src/domain/geo.js";

const FRISCO = { lat: 33.1507, lng: -96.8236 };
const SUGAR_LAND = { lat: 29.6197, lng: -95.6349 };
const AUSTIN_DOWNTOWN = { lat: 30.2672, lng: -97.7431 };
const DENVER = { lat: 39.7392, lng: -104.9903 };

test("DFW to Greater Houston is the long haul the fee model exists for", () => {
  const miles = haversineMiles(FRISCO, SUGAR_LAND);
  assert.ok(miles > 220 && miles < 260, `expected ~240 straight-line miles, got ${miles}`);
});

test("Texas venues resolve to the right metro", () => {
  assert.equal(nearestMetro(FRISCO).metro.id, "dfw");
  assert.equal(nearestMetro(SUGAR_LAND).metro.id, "hou");
  assert.equal(nearestMetro(AUSTIN_DOWNTOWN).metro.id, "aus");
});

test("out-of-state addresses fall outside the pilot footprint", () => {
  assert.equal(withinPilotFootprint(FRISCO), true);
  assert.equal(withinPilotFootprint(DENVER), false);
});

test("a local job inside the free radius costs nothing to travel to", () => {
  const nearby = { lat: 33.0198, lng: -96.6989 };
  const quote = quoteTravel(FRISCO, nearby);
  assert.equal(quote.totalCents, 0);
  assert.equal(quote.billableMiles, 0);
  assert.equal(quote.requiresOvernight, false);
});

test("a cross-metro job bills round-trip mileage plus an overnight", () => {
  const quote = quoteTravel(FRISCO, SUGAR_LAND);
  assert.equal(quote.outOfRange, false);
  assert.equal(quote.requiresOvernight, true);
  assert.equal(quote.overnightCents, 18_000);
  // Round trip: billable miles are charged twice.
  assert.equal(quote.mileageCents, Math.round(quote.billableMiles * 2 * 90));
  assert.equal(quote.totalCents, quote.mileageCents + quote.overnightCents);
});

test("a venue beyond the vendor's radius is flagged and priced at zero", () => {
  const quote = quoteTravel(FRISCO, SUGAR_LAND, { maxRadiusMiles: 50 });
  assert.equal(quote.outOfRange, true);
  assert.equal(quote.totalCents, 0);
});

test("road distance is never shorter than the straight line", () => {
  const straight = haversineMiles(FRISCO, AUSTIN_DOWNTOWN);
  const quote = quoteTravel(FRISCO, AUSTIN_DOWNTOWN);
  assert.ok(quote.miles > straight, "road estimate should exceed straight-line distance");
});

test("an incoherent travel policy is rejected", () => {
  assert.throws(() => normalizeTravelPolicy({ maxRadiusMiles: 10, freeRadiusMiles: 25 }));
  assert.throws(() => normalizeTravelPolicy({ perMileCents: -5 }));
});

test("every pilot metro has a positive fence", () => {
  for (const metro of TEXAS_METROS) {
    assert.ok(metro.radiusMiles > 0, `${metro.id} has no radius`);
    assert.ok(withinPilotFootprint(metro.center), `${metro.id} centre is outside its own fence`);
  }
});
