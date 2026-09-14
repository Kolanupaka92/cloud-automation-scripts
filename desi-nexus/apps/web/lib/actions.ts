"use server";

/**
 * Server actions.
 *
 * Every one of these runs on the server, so the API token never crosses to the
 * browser and the API's own validation stays the single source of truth -- the
 * form here mirrors it for a decent error message, it does not replace it.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { apiFetch, ApiCallError } from "./api";
import { storeSession, type TokenPair } from "./session";

export interface FormState {
  readonly error?: string;
  readonly field?: string;
  readonly notice?: string;
}

/** Turn an API failure into something a person can act on. */
function explain(error: unknown): FormState {
  if (error instanceof ApiCallError) {
    const field = (error.details as { field?: string } | undefined)?.field;
    return { error: error.message, ...(field ? { field } : {}) };
  }
  if (error instanceof Error && /fetch failed|ECONNREFUSED/.test(error.message)) {
    return { error: "Cannot reach the booking service right now. Please try again in a moment." };
  }
  return { error: "Something went wrong. Please try again." };
}

const str = (form: FormData, key: string): string => String(form.get(key) ?? "").trim();
const cents = (form: FormData, key: string): number => {
  const dollars = Number(str(form, key));
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
};

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const roles = form.getAll("roles").map(String).filter(Boolean);
  const metro = str(form, "metro");
  const [lat, lng] = metro.split(",").map(Number);

  try {
    await apiFetch("/v1/auth/register", {
      method: "POST",
      authenticated: false,
      body: {
        email: str(form, "email"),
        password: str(form, "password"),
        displayName: str(form, "displayName"),
        phone: str(form, "phone") || undefined,
        roles: roles.length > 0 ? roles : ["host"],
        homeBase: { lat, lng },
        languages: form.getAll("languages").map(String),
      },
    });
  } catch (error) {
    return explain(error);
  }
  // Registration does not sign you in; the login below issues the session so
  // there is exactly one path that mints tokens.
  return loginAction({}, form);
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  let result: TokenPair & { mfaRequired: boolean };
  try {
    result = await apiFetch("/v1/auth/login", {
      method: "POST",
      authenticated: false,
      body: { email: str(form, "email"), password: str(form, "password") },
    });
  } catch (error) {
    return explain(error);
  }
  await storeSession(result);
  redirect("/dashboard");
}

export async function sendOtpAction(): Promise<FormState> {
  try {
    const result = await apiFetch<{ sentTo: string; devCode?: string }>("/v1/auth/otp/send", {
      method: "POST",
    });
    return {
      notice: result.devCode
        ? `Code sent to ${result.sentTo}. Development code: ${result.devCode}`
        : `Code sent to ${result.sentTo}.`,
    };
  } catch (error) {
    return explain(error);
  }
}

/**
 * Clearing an OTP challenge is what promotes a session to MFA-verified, which
 * every money endpoint requires. The new token pair replaces the weaker one.
 */
export async function verifyOtpAction(_prev: FormState, form: FormData): Promise<FormState> {
  let result: TokenPair;
  try {
    result = await apiFetch("/v1/auth/otp/verify", {
      method: "POST",
      body: { code: str(form, "code") },
    });
  } catch (error) {
    return explain(error);
  }
  await storeSession(result);
  redirect("/dashboard?verified=1");
}

export async function createGigAction(_prev: FormState, form: FormData): Promise<FormState> {
  const [lat, lng] = str(form, "venue").split(",").map(Number);
  let created: { gig: { id: string } };
  try {
    created = await apiFetch("/v1/gigs", {
      method: "POST",
      body: {
        eventType: str(form, "eventType"),
        specialty: str(form, "specialty"),
        eventDate: str(form, "eventDate"),
        venue: { lat, lng },
        budgetMinCents: cents(form, "budgetMin"),
        budgetMaxCents: cents(form, "budgetMax"),
        culturalTags: form.getAll("culturalTags").map(String),
        languages: form.getAll("languages").map(String),
        headcount: Number(str(form, "headcount")) || undefined,
        notes: str(form, "notes") || undefined,
      },
    });
  } catch (error) {
    return explain(error);
  }
  redirect(`/gigs/${created.gig.id}?created=1`);
}

/** Publishing runs the match engine and schedules the notification waves. */
export async function publishGigAction(gigId: string): Promise<FormState> {
  try {
    await apiFetch(`/v1/gigs/${gigId}/publish`, { method: "POST" });
  } catch (error) {
    return explain(error);
  }
  revalidatePath(`/gigs/${gigId}`);
  return { notice: "Your gig is live and matching vendors now." };
}

export async function applyToGigAction(_prev: FormState, form: FormData): Promise<FormState> {
  const gigId = str(form, "gigId");
  try {
    await apiFetch(`/v1/gigs/${gigId}/applications`, {
      method: "POST",
      body: {
        quotedRateCents: cents(form, "quotedRate"),
        message: str(form, "message") || undefined,
      },
    });
  } catch (error) {
    return explain(error);
  }
  revalidatePath(`/gigs/${gigId}`);
  return { notice: "Application sent. The host can see your portfolio and match score." };
}

export async function offerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const gigId = str(form, "gigId");
  try {
    await apiFetch(`/v1/gigs/${gigId}/offer`, {
      method: "POST",
      body: { applicationId: str(form, "applicationId") },
    });
  } catch (error) {
    return explain(error);
  }
  revalidatePath(`/gigs/${gigId}`);
  return { notice: "Offer accepted. Fund the deposit to confirm the booking." };
}

export async function createCrewProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await apiFetch("/v1/profiles/crew", {
      method: "POST",
      body: {
        specialties: form.getAll("specialties").map(String),
        culturalTags: form.getAll("culturalTags").map(String),
        startingRateCents: cents(form, "startingRate"),
        yearsExperience: Number(str(form, "yearsExperience")) || 0,
      },
    });
  } catch (error) {
    return explain(error);
  }
  revalidatePath("/vendor");
  return { notice: "Profile saved. You will start appearing in host searches." };
}
