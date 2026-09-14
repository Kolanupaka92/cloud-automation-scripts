import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ApiCallError, applicants, gig as fetchGig, me } from "@/lib/api";
import { GIG_STATE_COPY, label, shortDate, usd } from "@/lib/format";
import { PublishButton } from "./PublishButton";
import { OfferForm } from "./OfferForm";
import { ApplyForm } from "./ApplyForm";
import { ScoreBar } from "@/components/ScoreBar";

export const metadata: Metadata = { title: "Gig" };

export default async function GigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let profile;
  try {
    profile = await me();
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) redirect("/login");
    throw error;
  }

  let data;
  try {
    data = await fetchGig(id);
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404) notFound();
    throw error;
  }

  const { gig } = data;
  const isOwner = gig.hostId === profile.user.id;
  const state = GIG_STATE_COPY[gig.state] ?? { label: gig.state, tone: "draft" as const };

  // Only the host may see who applied; a vendor viewing the gig sees the brief.
  const rows = isOwner ? await applicants(id).then((r) => r.applications).catch(() => []) : [];

  return (
    <div style={{ padding: "36px 0", maxWidth: 800 }}>
      <div className="spread">
        <div>
          <span className={`state ${state.tone}`}>{state.label}</span>
          <h1 style={{ marginTop: 10, marginBottom: 2 }}>{label(gig.brief.eventType)}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {label(gig.brief.specialty)} · {shortDate(gig.brief.eventDate)}
          </p>
        </div>
        {isOwner && gig.state === "Draft" && <PublishButton gigId={gig.id} />}
      </div>

      {gig.state === "Open" && gig.applicationCount === 0 && (
        <div className="notice info" style={{ marginTop: 18 }}>
          <strong>Live and matching.</strong> Matched vendors are being notified in waves —
          the strongest matches first, so you are not buried in applications.
        </div>
      )}

      <div className="card" style={{ marginTop: 22 }}>
        <h3>The brief</h3>
        <div className="grid two">
          <div>
            <p className="faint" style={{ margin: 0 }}>Budget</p>
            <p style={{ margin: 0 }}>
              {usd(gig.brief.budgetMinCents)} – {usd(gig.brief.budgetMaxCents)}
            </p>
          </div>
          <div>
            <p className="faint" style={{ margin: 0 }}>Guests</p>
            <p style={{ margin: 0 }}>{gig.brief.headcount ?? "Not specified"}</p>
          </div>
        </div>

        {gig.brief.culturalTags.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="faint" style={{ marginBottom: 6 }}>Style and tradition</p>
            <div className="row" style={{ gap: 7 }}>
              {gig.brief.culturalTags.map((tag) => (
                <span className="pill tag" key={tag}>{label(tag)}</span>
              ))}
            </div>
          </div>
        )}

        {gig.brief.languages.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="faint" style={{ marginBottom: 6 }}>Languages on the day</p>
            <div className="row" style={{ gap: 7 }}>
              {gig.brief.languages.map((language) => (
                <span className="pill plain" key={language}>{label(language)}</span>
              ))}
            </div>
          </div>
        )}

        {gig.brief.notes && (
          <div style={{ marginTop: 14 }}>
            <p className="faint" style={{ marginBottom: 4 }}>Notes</p>
            <p style={{ margin: 0 }}>{gig.brief.notes}</p>
          </div>
        )}
      </div>

      {!isOwner && (gig.state === "Open" || gig.state === "ApplicationsReview") && (
        <ApplyForm gigId={gig.id} />
      )}

      {isOwner && (
        <section style={{ marginTop: 28 }}>
          <h2>Applicants ({rows.length})</h2>
          {rows.length === 0 ? (
            <div className="card empty">
              <p style={{ margin: 0 }}>
                {gig.state === "Draft"
                  ? "This gig is still a draft. Publish it to start matching."
                  : "No applications yet. Matched vendors are being notified in waves."}
              </p>
            </div>
          ) : (
            <div className="stack">
              {rows.map((row) => (
                <div className="card" key={row.application.id}>
                  <div className="spread">
                    <div>
                      <h3 style={{ marginBottom: 2 }}>{row.displayName || "Vendor"}</h3>
                      <p className="faint" style={{ margin: 0 }}>
                        Quoted {usd(row.application.quotedRateCents)} ·{" "}
                        {row.travelMiles.toFixed(0)} miles away
                      </p>
                    </div>
                    <div style={{ minWidth: 190 }}>
                      <ScoreBar score={row.score} breakdown={row.breakdown} />
                    </div>
                  </div>

                  {row.application.message && (
                    <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
                      &ldquo;{row.application.message}&rdquo;
                    </p>
                  )}

                  {!gig.acceptedOfferId && (
                    <div style={{ marginTop: 14 }}>
                      <OfferForm gigId={gig.id} applicationId={row.application.id} />
                    </div>
                  )}
                  {gig.acceptedOfferId === row.application.id && (
                    <div className="notice good" style={{ marginTop: 14 }}>
                      <strong>Booked with this vendor.</strong> Payments open once the platform&rsquo;s
                      Stripe account is live — until then, settle directly and keep the thread here.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
