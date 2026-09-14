import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ApiCallError, apiFetch, me, taxonomy } from "@/lib/api";
import { usd } from "@/lib/format";
import { createCrewProfileAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";
import { CheckGroup } from "@/components/Checks";

export const metadata: Metadata = { title: "Your vendor profile" };

interface CrewProfile {
  readonly specialties: string[];
  readonly culturalTags: string[];
  readonly startingRateCents: number;
  readonly yearsExperience: number;
  readonly completedGigs: number;
}

export default async function VendorPage() {
  let profile;
  try {
    profile = await me();
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) redirect("/login");
    throw error;
  }

  const data = await taxonomy();
  const existing = await apiFetch<{ profile: CrewProfile }>(
    `/v1/profiles/crew/${profile.user.id}`,
  )
    .then((result) => result.profile)
    .catch(() => null);

  return (
    <div style={{ maxWidth: 680, margin: "40px auto" }}>
      <h1>Your vendor profile</h1>
      <p className="muted">
        Cultural tags carry the most weight in matching. Tag only what you genuinely work —
        a wrong match costs you a review, not just a booking.
      </p>

      {existing && (
        <div className="notice good" style={{ marginBottom: 16 }}>
          Profile live · {existing.completedGigs} completed{" "}
          {existing.completedGigs === 1 ? "gig" : "gigs"} · from{" "}
          {usd(existing.startingRateCents)}
        </div>
      )}

      <div className="card">
        <ActionForm action={createCrewProfileAction} submitLabel="Save profile">
          <div className="field">
            <label>What do you do?</label>
            <CheckGroup
              name="specialties"
              options={data.crewSpecialties}
              defaultSelected={existing?.specialties ?? []}
            />
            <p className="hint">You are only shown gigs for the specialities you list here.</p>
          </div>

          <div className="field">
            <label>Styles and traditions you work</label>
            <CheckGroup
              name="culturalTags"
              options={data.culturalTags}
              defaultSelected={existing?.culturalTags ?? []}
            />
          </div>

          <div className="grid two">
            <div className="field">
              <label htmlFor="startingRate">Starting rate (USD)</label>
              <input
                id="startingRate"
                name="startingRate"
                type="number"
                min="1"
                step="1"
                required
                defaultValue={existing ? existing.startingRateCents / 100 : undefined}
              />
              <p className="hint">Hosts whose ceiling is far below this will not see you.</p>
            </div>
            <div className="field">
              <label htmlFor="yearsExperience">Years working</label>
              <input
                id="yearsExperience"
                name="yearsExperience"
                type="number"
                min="0"
                defaultValue={existing?.yearsExperience ?? 0}
              />
            </div>
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
