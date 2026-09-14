"use client";

import { applyToGigAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";

export function ApplyForm({ gigId }: { gigId: string }) {
  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3>Apply for this gig</h3>
      <p className="muted" style={{ fontSize: "0.93rem" }}>
        The host sees your quote, your message and your match score side by side with everyone
        else&rsquo;s.
      </p>
      <ActionForm action={applyToGigAction} submitLabel="Send application">
        <input type="hidden" name="gigId" value={gigId} />
        <div className="field">
          <label htmlFor="quotedRate">Your quote (USD)</label>
          <input id="quotedRate" name="quotedRate" type="number" min="1" step="1" required />
          <p className="hint">Travel beyond your free radius is added automatically.</p>
        </div>
        <div className="field">
          <label htmlFor="message">Message to the host</label>
          <textarea
            id="message"
            name="message"
            placeholder="What you have done that is like this function, and what you would need on the day."
          />
        </div>
      </ActionForm>
    </div>
  );
}
