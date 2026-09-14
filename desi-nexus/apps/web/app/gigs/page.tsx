import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiCallError, apiFetch, me, type Gig, type ScoreBreakdown } from "@/lib/api";
import { label, shortDate, usd } from "@/lib/format";
import { ScoreBar } from "@/components/ScoreBar";

export const metadata: Metadata = { title: "Open gigs" };

interface DiscoverRow {
  readonly gig: Gig;
  readonly score: number;
  readonly breakdown?: ScoreBreakdown;
  readonly travelMiles: number;
  readonly travelFeeCents: number;
  readonly alreadyApplied: boolean;
}

export default async function BrowseGigsPage() {
  let profile;
  try {
    profile = await me();
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) redirect("/login");
    throw error;
  }

  const isVendor =
    profile.user.roles.includes("crew") || profile.user.roles.includes("creator");
  if (!isVendor) redirect("/dashboard");

  let rows: DiscoverRow[] = [];
  let missingProfile = false;
  try {
    rows = (await apiFetch<{ gigs: DiscoverRow[] }>("/v1/discover/gigs")).gigs;
  } catch (error) {
    if (error instanceof ApiCallError && error.code === "no_profile") missingProfile = true;
    else throw error;
  }

  return (
    <div style={{ padding: "36px 0", maxWidth: 800 }}>
      <h1>Open gigs for you</h1>
      <p className="muted">
        Only gigs in your specialities, inside your travel radius, on days you are free.
      </p>

      {missingProfile ? (
        <div className="card empty">
          <p style={{ margin: 0 }}>Set up your vendor profile first.</p>
          <p className="faint">We match on speciality and style, so we need those before we can show you anything.</p>
          <Link href="/vendor" className="btn accent" style={{ marginTop: 12 }}>
            Create your profile
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <div className="card empty">
          <p style={{ margin: 0 }}>Nothing open right now.</p>
          <p className="faint">
            You will get a push as soon as a matching gig is posted — the strongest matches are
            notified first.
          </p>
        </div>
      ) : (
        <div className="stack">
          {rows.map((row) => (
            <div className="card" key={row.gig.id}>
              <div className="spread">
                <div>
                  <h3 style={{ marginBottom: 2 }}>
                    <Link href={`/gigs/${row.gig.id}`}>{label(row.gig.brief.eventType)}</Link>
                  </h3>
                  <p className="faint" style={{ margin: 0 }}>
                    {shortDate(row.gig.brief.eventDate)} ·{" "}
                    {usd(row.gig.brief.budgetMinCents)}–{usd(row.gig.brief.budgetMaxCents)} ·{" "}
                    {row.travelMiles.toFixed(0)} miles
                    {row.travelFeeCents > 0 && ` (+${usd(row.travelFeeCents)} travel)`}
                  </p>
                  <div className="row" style={{ gap: 7, marginTop: 10 }}>
                    {row.gig.brief.culturalTags.map((tag) => (
                      <span className="pill tag" key={tag}>{label(tag)}</span>
                    ))}
                  </div>
                </div>
                <div style={{ minWidth: 190 }}>
                  <ScoreBar score={row.score} breakdown={row.breakdown} />
                  {row.alreadyApplied && (
                    <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
                      You have applied.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
