"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/lib/actions";

export function Submit({ children, className = "btn" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

/**
 * A form bound to a server action, with its error surfaced above the fields.
 * The action is the only validator that matters; this just renders what it says.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  submitClassName,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  children: React.ReactNode;
  submitClassName?: string;
}) {
  const [state, formAction] = useActionState(action, {});

  return (
    <form action={formAction} className="stack">
      {state.error && (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="notice good" role="status">
          {state.notice}
        </div>
      )}
      {children}
      <div>
        <Submit className={submitClassName}>{submitLabel}</Submit>
      </div>
    </form>
  );
}
