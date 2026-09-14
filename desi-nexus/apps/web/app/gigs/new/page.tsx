import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { taxonomy, me, ApiCallError } from "@/lib/api";
import { createGigAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";
import { CheckGroup } from "@/components/Checks";
import { EventPicker } from "./EventPicker";

export const metadata: Metadata = { title: "Post a gig" };

export default async function NewGigPage() {
  try {
    await me();
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) redirect("/login");
    throw error;
  }
  const data = await taxonomy();

  return (
    <div style={{ maxWidth: 680, margin: "40px auto" }}>
      <h1>Post a gig</h1>
      <p className="muted">
        The more specific the occasion, the better the match. &ldquo;Wedding&rdquo; gets you
        everyone; &ldquo;Half-Saree Function&rdquo; gets you the three people who have done
        forty of them.
      </p>

      <div className="card">
        <ActionForm action={createGigAction} submitLabel="Save as draft">
          <EventPicker groups={data.eventGroups} specialties={data.crewSpecialties} />

          <div className="field">
            <label htmlFor="eventDate">Event date</label>
            <input id="eventDate" name="eventDate" type="date" required />
          </div>

          <div className="field">
            <label htmlFor="venue">Venue metro</label>
            <select id="venue" name="venue" required defaultValue="">
              <option value="" disabled>
                Where is the event?
              </option>
              {data.metros.map((metro) => (
                <option key={metro.id} value={`${metro.center.lat},${metro.center.lng}`}>
                  {metro.name}
                </option>
              ))}
            </select>
            <p className="hint">
              Travel beyond a vendor&rsquo;s free radius is quoted automatically, round trip.
            </p>
          </div>

          <div className="grid two">
            <div className="field">
              <label htmlFor="budgetMin">Budget from (USD)</label>
              <input id="budgetMin" name="budgetMin" type="number" min="0" step="1" required />
            </div>
            <div className="field">
              <label htmlFor="budgetMax">Budget to (USD)</label>
              <input id="budgetMax" name="budgetMax" type="number" min="0" step="1" required />
            </div>
          </div>

          <div className="field">
            <label>Style and tradition</label>
            <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              This is the heaviest factor in matching. Pick what the day actually is.
            </p>
            <CheckGroup name="culturalTags" options={data.culturalTags} max={4} />
          </div>

          <div className="field">
            <label>Languages needed on the day</label>
            <CheckGroup name="languages" options={data.languages} max={4} />
          </div>

          <div className="field">
            <label htmlFor="headcount">Approximate guest count</label>
            <input id="headcount" name="headcount" type="number" min="1" />
          </div>

          <div className="field">
            <label htmlFor="notes">Anything the vendor should know</label>
            <textarea
              id="notes"
              name="notes"
              placeholder="Call time, getting-ready location, how many people need to be ready, parking."
            />
          </div>
        </ActionForm>
      </div>
      <p className="faint" style={{ marginTop: 12 }}>
        Saving creates a draft. Nothing is sent to vendors until you publish it.
      </p>
    </div>
  );
}
