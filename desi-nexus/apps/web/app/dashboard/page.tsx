import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch, me, type Gig, ApiCallError } from "@/lib/api";
import { GIG_STATE_COPY, label, shortDate, usd } from "@/lib/format";
import { VerifyPrompt } from "./VerifyPrompt";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  let profile;
  try {
    profile = await me();
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) redirect("/login");
    throw error;
  }

  const { user, session } = profile;
  const isHost = user.roles.includes("host");
  const isVendor = user.roles.includes("crew") || user.roles.includes("creator");

  const gigs = isHost
    ? await apiFetch<{ gigs: Gig[] }>("/v1/me/gigs")
        .then((data) => data.gigs ?? [])
        .catch(() => [] as Gig[])
    : [];

  return (
    <div style={{ padding: "36px 0" }}>
      <div className="spread">
        <div>
          <h1 style={{ marginBottom: 4 }}>{user.displayName}</h1>
          <p className="faint" style={{ margin: 0 }}>
            {user.roles.map(label).join(" · ")}
          </p>
        </div>
        {isHost && (
          <Link href="/gigs/new" className="btn accent">
            Post a gig
          </Link>
        )}
      </div>

      {!session.mfa && <VerifyPrompt />}

      {isVendor && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="spread">
            <div>
              <h3>Your vendor profile</h3>
              <p className="muted" style={{ margin: 0, fontSize: "0.93rem" }}>
                Specialities and cultural tags are what put you in front of the right hosts.
              </p>
            </div>
            <Link href="/vendor" className="btn secondary small">
              Edit profile
            </Link>
          </div>
        </div>
      )}

      {isHost && (
        <section style={{ marginTop: 28 }}>
          <h2>Your gigs</h2>
          {gigs.length === 0 ? (
            <div className="card empty">
              <p style={{ margin: 0 }}>No gigs yet.</p>
              <p className="faint">Post one and we will start matching local talent immediately.</p>
              <Link href="/gigs/new" className="btn accent" style={{ marginTop: 12 }}>
                Post your first gig
              </Link>
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th>Budget</th>
                    <th>Applicants</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {gigs.map((row) => {
                    const state = GIG_STATE_COPY[row.state] ?? { label: row.state, tone: "draft" as const };
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link href={`/gigs/${row.id}`}>
                            <strong>{label(row.brief.eventType)}</strong>
                          </Link>
                          <div className="faint">{label(row.brief.specialty)}</div>
                        </td>
                        <td>{shortDate(row.brief.eventDate)}</td>
                        <td>
                          {usd(row.brief.budgetMinCents)}–{usd(row.brief.budgetMaxCents)}
                        </td>
                        <td>{row.applicationCount}</td>
                        <td>
                          <span className={`state ${state.tone}`}>{state.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
