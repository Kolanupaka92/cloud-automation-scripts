"use client";

import { useState, useTransition } from "react";
import { sendOtpAction, verifyOtpAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";

/**
 * Verifying a phone is what promotes the session to MFA-verified, which the API
 * demands before anything touching money. Surfacing it here rather than at the
 * payment step means nobody discovers it with a vendor waiting on them.
 */
export function VerifyPrompt() {
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="notice info" style={{ marginTop: 20 }}>
      <div className="spread">
        <div>
          <strong>Verify your phone to book or get paid.</strong>
          <div style={{ fontSize: "0.9rem", marginTop: 2 }}>
            Signing in is not enough for anything that moves money — that is deliberate.
          </div>
        </div>
        {!open && (
          <button
            className="btn small"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await sendOtpAction();
                setNotice(result.notice ?? result.error ?? null);
                setOpen(true);
              })
            }
          >
            {pending ? "Sending…" : "Send code"}
          </button>
        )}
      </div>

      {notice && (
        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
          {notice}
        </p>
      )}

      {open && (
        <div style={{ marginTop: 12, maxWidth: 260 }}>
          <ActionForm action={verifyOtpAction} submitLabel="Verify" submitClassName="btn small">
            <div className="field">
              <label htmlFor="code">6-digit code</label>
              <input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" required />
            </div>
          </ActionForm>
        </div>
      )}
    </div>
  );
}
