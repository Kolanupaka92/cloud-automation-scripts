import test from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHTS,
  budgetScore,
  culturalScore,
  disqualify,
  languageScore,
  planNotificationWaves,
  proximityScore,
  rankCandidates,
  reputationScore,
  responsivenessScore,
  scoreCandidate,
  type Candidate,
} from "../src/domain/matching.js";
import type { GigBrief } from "../src/domain/gig.js";

const FRISCO = { lat: 33.1507, lng: -96.8236 };
const PLANO = { lat: 33.0198, lng: -96.6989 };
const HOUSTON = { lat: 29.7604, lng: -95.3698 };

const brief: GigBrief = {
  eventType: "half_saree_function",
  specialty: "mua",
  eventDate: "2026-06-20",
  venue: FRISCO,
  metroId: "dfw",
  budgetMinCents: 40_000,
  budgetMaxCents: 90_000,
  culturalTags: ["telugu_traditional"],
  languages: ["telugu"],
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    userId: "usr_1",
    specialties: ["mua"],
    culturalTags: ["telugu_traditional"],
    languages: ["telugu", "english"],
    homeBase: PLANO,
    startingRateCents: 55_000,
    ratingAvg: 4.8,
    ratingCount: 30,
    completedGigs: 40,
    medianResponseMinutes: 8,
    ...overrides,
  };
}

test("the weights sum to one, so a perfect candidate scores 100", () => {
  const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test("the local, exactly-matched, well-reviewed specialist scores near the ceiling", () => {
  const result = scoreCandidate(candidate(), brief);
  assert.equal(result.rejectedFor, undefined);
  assert.ok(result.score >= 90, `expected a near-perfect score, got ${result.score}`);
});

test("a candidate without the speciality is dropped, whatever else they offer", () => {
  const result = scoreCandidate(candidate({ specialties: ["photographer"] }), brief);
  assert.match(result.rejectedFor ?? "", /does not offer mua/);
  assert.equal(result.score, 0);
});

test("a candidate booked on the day is dropped", () => {
  const reason = disqualify(candidate({ unavailableDates: ["2026-06-20"] }), brief);
  assert.match(reason ?? "", /unavailable on 2026-06-20/);
});

test("a candidate who cannot be paid is never shown", () => {
  const reason = disqualify(candidate({ payoutReady: false }), brief);
  assert.match(reason ?? "", /cannot receive payouts/);
});

test("a vendor beyond their own travel radius is dropped", () => {
  const reason = disqualify(candidate({ homeBase: HOUSTON, travelPolicy: { maxRadiusMiles: 60 } }), brief);
  assert.match(reason ?? "", /beyond their travel radius/);
});

test("a rate far above the posted ceiling is dropped, with a little negotiating room", () => {
  assert.equal(disqualify(candidate({ startingRateCents: 100_000 }), brief), undefined);
  assert.match(
    disqualify(candidate({ startingRateCents: 140_000 }), brief) ?? "",
    /above the posted budget/,
  );
});

test("adjacent cultural styles earn partial credit, unrelated ones none", () => {
  assert.equal(culturalScore(["telugu_traditional"], ["telugu_traditional"]), 1);
  assert.equal(culturalScore(["telugu_traditional"], ["south_indian_bridal"]), 0.5);
  assert.equal(culturalScore(["telugu_traditional"], ["punjabi_sikh"]), 0);
  // An untagged brief is neutral rather than zero.
  assert.equal(culturalScore([], ["punjabi_sikh"]), 0.6);
});

test("cultural fit is what separates two otherwise identical vendors", () => {
  const exact = scoreCandidate(candidate({ userId: "a" }), brief);
  const wrong = scoreCandidate(candidate({ userId: "b", culturalTags: ["punjabi_sikh"] }), brief);
  assert.ok(exact.score - wrong.score >= 25, `expected a wide gap, got ${exact.score} vs ${wrong.score}`);
});

test("proximity decays with distance rather than stepping at a metro line", () => {
  assert.equal(proximityScore(10), 1);
  assert.ok(proximityScore(30) > proximityScore(80));
  assert.ok(proximityScore(80) > proximityScore(200));
  assert.equal(proximityScore(300), 0);
});

test("budget scoring rewards a rate inside the range without punishing the cheapest", () => {
  assert.equal(budgetScore(30_000, brief), 1);
  assert.ok(budgetScore(50_000, brief) > budgetScore(88_000, brief));
  assert.ok(budgetScore(120_000, brief) < budgetScore(90_000, brief));
  assert.ok(budgetScore(400_000, brief) === 0);
});

test("language coverage is proportional", () => {
  assert.equal(languageScore(["telugu"], ["telugu", "english"]), 1);
  assert.equal(languageScore(["telugu", "hindi"], ["telugu"]), 0.5);
  assert.equal(languageScore([], ["english"]), 1);
});

test("one five-star review does not outrank a long record", () => {
  const rookie = reputationScore(candidate({ ratingAvg: 5, ratingCount: 1, completedGigs: 1 }));
  const veteran = reputationScore(candidate({ ratingAvg: 4.8, ratingCount: 120, completedGigs: 140 }));
  assert.ok(veteran > rookie, `veteran ${veteran} should outrank rookie ${rookie}`);
});

test("a brand new vendor still scores well enough to be discoverable", () => {
  const fresh = scoreCandidate(
    candidate({ userId: "new", ratingCount: 0, completedGigs: 0, medianResponseMinutes: undefined }),
    brief,
  );
  assert.ok(fresh.score >= 60, `a cold-start vendor scored ${fresh.score}; supply would never build`);
});

test("fast repliers rank above slow ones", () => {
  assert.equal(responsivenessScore(5), 1);
  assert.ok(responsivenessScore(30) > responsivenessScore(600));
  assert.equal(responsivenessScore(24 * 60), 0);
});

test("ranking is ordered, filtered and deterministic", () => {
  const pool: Candidate[] = [
    candidate({ userId: "perfect" }),
    candidate({ userId: "far", homeBase: HOUSTON, travelPolicy: { maxRadiusMiles: 300 } }),
    candidate({ userId: "wrong_style", culturalTags: ["punjabi_sikh"] }),
    candidate({ userId: "wrong_job", specialties: ["dj"] }),
    candidate({ userId: "busy", unavailableDates: ["2026-06-20"] }),
  ];
  const ranked = rankCandidates(pool, brief);
  const ids = ranked.map((result) => result.userId);

  assert.equal(ids[0], "perfect");
  assert.ok(!ids.includes("wrong_job"), "a mismatched speciality must not appear");
  assert.ok(!ids.includes("busy"), "an unavailable vendor must not appear");
  assert.deepEqual(rankCandidates(pool, brief).map((r) => r.userId), ids, "ranking must be stable");
});

test("a shortlist is notified in waves, so the host is not buried and vendors are not spammed", () => {
  const ranked = rankCandidates(
    Array.from({ length: 20 }, (_, i) => candidate({ userId: `usr_${i}` })),
    brief,
  );
  const waves = planNotificationWaves(ranked, { hoursUntilEvent: 30 * 24 });

  assert.ok(waves.length > 1, "a non-urgent gig should fan out gradually");
  assert.equal(waves[0]?.delayMinutes, 0);
  assert.ok((waves[1]?.delayMinutes ?? 0) > 0, "later waves must be delayed");

  const notified = waves.flatMap((wave) => wave.userIds);
  assert.equal(new Set(notified).size, notified.length, "nobody should be notified twice");
  assert.equal(notified.length, ranked.length, "everyone shortlisted should eventually hear about it");
});

test("an urgent gig collapses into a single immediate wave", () => {
  const ranked = rankCandidates(
    Array.from({ length: 12 }, (_, i) => candidate({ userId: `usr_${i}` })),
    brief,
  );
  const waves = planNotificationWaves(ranked, { hoursUntilEvent: 20 });
  assert.equal(waves.length, 1);
  assert.equal(waves[0]?.delayMinutes, 0);
  assert.equal(waves[0]?.userIds.length, ranked.length);
});

test("an empty shortlist schedules nothing", () => {
  assert.deepEqual(planNotificationWaves([]), []);
});
