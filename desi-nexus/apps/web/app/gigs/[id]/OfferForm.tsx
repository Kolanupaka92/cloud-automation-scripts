"use client";

import { offerAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";

export function OfferForm({ gigId, applicationId }: { gigId: string; applicationId: string }) {
  return (
    <ActionForm action={offerAction} submitLabel="Book this vendor" submitClassName="btn small">
      <input type="hidden" name="gigId" value={gigId} />
      <input type="hidden" name="applicationId" value={applicationId} />
    </ActionForm>
  );
}
