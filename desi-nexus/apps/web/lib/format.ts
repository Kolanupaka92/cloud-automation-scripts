/**
 * Presentation helpers.
 *
 * Money arrives as integer cents and is formatted here rather than divided
 * anywhere upstream, so no rounding ever creeps toward the API boundary.
 */
export function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function titleCase(code: string): string {
  return code
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const EVENT_LABELS: Record<string, string> = {
  half_saree_function: "Half-Saree Function",
  griha_pravesham: "Griha Pravesham",
  mundan_child_carnival: "Mundan / Child Carnival",
  seemantham_baby_shower: "Seemantham (Baby Shower)",
  sikh_anand_karaj: "Anand Karaj",
  garba_navratri: "Garba / Navratri",
  kerala_christian_wedding: "Kerala Christian Wedding",
  roka_engagement: "Roka / Engagement",
  hindu_ceremony: "Hindu Wedding Ceremony",
  mua: "Makeup Artist",
  dj: "DJ",
  priest_pandit: "Priest / Pandit",
  ugc_creator: "UGC Creator",
  hd_airbrush: "HD Airbrush",
  indo_western_fusion: "Indo-Western Fusion",
};

/** Codes are snake_case on the wire; a few need a hand-written label. */
export function label(code: string): string {
  return EVENT_LABELS[code] ?? titleCase(code);
}

export function shortDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** The gig state machine, rendered as something a host can read. */
export const GIG_STATE_COPY: Record<string, { label: string; tone: "draft" | "open" | "live" | "done" | "halt" }> = {
  Draft: { label: "Draft", tone: "draft" },
  Open: { label: "Open for applications", tone: "open" },
  ApplicationsReview: { label: "Reviewing applicants", tone: "open" },
  EscrowLocked: { label: "Booked", tone: "live" },
  InTransit: { label: "Vendor on the way", tone: "live" },
  Active: { label: "In progress", tone: "live" },
  DeliveryPending: { label: "Awaiting your sign-off", tone: "live" },
  Completed: { label: "Completed", tone: "done" },
  Cancelled: { label: "Cancelled", tone: "halt" },
  Disputed: { label: "In dispute", tone: "halt" },
};
