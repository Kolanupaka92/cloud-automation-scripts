"use client";

import { useState, useTransition } from "react";
import { publishGigAction } from "@/lib/actions";

/**
 * Publishing is the moment the match engine runs and the notification waves are
 * scheduled, so it is a deliberate second step rather than a side effect of
 * saving a draft.
 *
 * Only the failure case is rendered here. On success the action revalidates the
 * page, the gig is no longer a Draft, and this button unmounts along with
 * anything it was holding -- so a success message shown from here could never
 * actually be read. The state badge and the applicants section are what confirm
 * it worked, and they survive the re-render.
 */
export function PublishButton({ gigId }: { gigId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div style={{ textAlign: "right" }}>
      <button
        className="btn accent"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await publishGigAction(gigId);
            if (result.error) setError(result.error);
          })
        }
      >
        {pending ? "Publishing…" : "Publish and start matching"}
      </button>
      {error && (
        <p className="notice error" style={{ marginTop: 8, maxWidth: 280, textAlign: "left" }}>
          {error}
        </p>
      )}
    </div>
  );
}
