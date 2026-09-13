/**
 * The cultural vocabulary the marketplace matches on.
 *
 * This is the part a generic gig platform cannot copy by adding a category
 * dropdown. A Telugu family booking a Half-Saree Function and a Frisco boutique
 * booking a Langa Voni lookbook want the same specialist; the taxonomy is what
 * lets one index serve both.
 */

/** Event types, grouped so the "Post a Gig" wizard can present them by occasion. */
export const EVENT_GROUPS = {
  wedding: [
    "roka_engagement",
    "mehndi",
    "haldi",
    "sangeet",
    "baraat",
    "hindu_ceremony",
    "nikah",
    "sikh_anand_karaj",
    "kerala_christian_wedding",
    "reception",
  ],
  religious: [
    "griha_pravesham",
    "satyanarayan_puja",
    "ayush_homam",
    "upanayanam",
    "namakaranam",
  ],
  milestone: [
    "half_saree_function",
    "mundan_child_carnival",
    "seemantham_baby_shower",
    "first_birthday",
    "graduation_party",
  ],
  festival: ["garba_navratri", "diwali_celebration", "holi_event", "bhangra_night"],
  commercial: [
    "boutique_lookbook",
    "brand_campaign_shoot",
    "jewellery_catalogue",
    "corporate_diwali",
    "corporate_offsite",
    "restaurant_launch",
    "influencer_collab",
  ],
} as const;

export type EventGroup = keyof typeof EVENT_GROUPS;
export type EventType = (typeof EVENT_GROUPS)[EventGroup][number];

export const EVENT_TYPES: readonly EventType[] = Object.values(EVENT_GROUPS).flat() as EventType[];

const EVENT_GROUP_BY_TYPE = new Map<string, EventGroup>(
  (Object.keys(EVENT_GROUPS) as EventGroup[]).flatMap((group) =>
    EVENT_GROUPS[group].map((type) => [type as string, group] as const),
  ),
);

export function isEventType(value: string): value is EventType {
  return EVENT_GROUP_BY_TYPE.has(value);
}

export function eventGroupOf(type: EventType): EventGroup {
  const group = EVENT_GROUP_BY_TYPE.get(type);
  if (!group) throw new Error(`unknown event type: ${type}`);
  return group;
}

/** A commercial gig is billed and staffed differently from a family function. */
export function isCommercial(type: EventType): boolean {
  return eventGroupOf(type) === "commercial";
}

/** Crew specialities. A profile may hold several. */
export const CREW_SPECIALTIES = [
  "mua",
  "hair_stylist",
  "photographer",
  "videographer",
  "drone_operator",
  "henna_artist",
  "decorator",
  "florist",
  "dj",
  "live_musician",
  "dhol_player",
  "choreographer",
  "caterer",
  "priest_pandit",
  "event_planner",
  "mehndi_assistant",
  "saree_draper",
] as const;
export type CrewSpecialty = (typeof CREW_SPECIALTIES)[number];

const CREW_SPECIALTY_SET = new Set<string>(CREW_SPECIALTIES);
export function isCrewSpecialty(value: string): value is CrewSpecialty {
  return CREW_SPECIALTY_SET.has(value);
}

/** Creator disciplines, for the influencer/model side of the marketplace. */
export const CREATOR_DISCIPLINES = [
  "fashion_model",
  "bridal_model",
  "ugc_creator",
  "lifestyle_influencer",
  "food_influencer",
  "dance_creator",
  "comedy_creator",
  "host_emcee",
] as const;
export type CreatorDiscipline = (typeof CREATOR_DISCIPLINES)[number];

/**
 * Cultural style tags. These carry the real signal: a MUA who does South Indian
 * bridal is not interchangeable with one who does Punjabi Sikh bridal, and
 * booking the wrong one is the single most common source of a ruined function.
 */
export const CULTURAL_TAGS = [
  "south_indian_bridal",
  "north_indian_bridal",
  "telugu_traditional",
  "tamil_iyer",
  "kannada_traditional",
  "malayali_traditional",
  "gujarati_traditional",
  "punjabi_sikh",
  "marathi_traditional",
  "bengali_traditional",
  "rajasthani_traditional",
  "muslim_nikah",
  "indo_western_fusion",
  "minimal_natural",
  "hd_airbrush",
] as const;
export type CulturalTag = (typeof CULTURAL_TAGS)[number];

const CULTURAL_TAG_SET = new Set<string>(CULTURAL_TAGS);
export function isCulturalTag(value: string): value is CulturalTag {
  return CULTURAL_TAG_SET.has(value);
}

/**
 * Tags that read as near-substitutes. A host who asked for `telugu_traditional`
 * is usually well served by a `south_indian_bridal` specialist, so partial
 * credit is scored rather than dropping the candidate entirely.
 */
const TAG_AFFINITY: Record<string, readonly string[]> = {
  south_indian_bridal: ["telugu_traditional", "tamil_iyer", "kannada_traditional", "malayali_traditional"],
  telugu_traditional: ["south_indian_bridal", "kannada_traditional"],
  tamil_iyer: ["south_indian_bridal", "malayali_traditional"],
  kannada_traditional: ["south_indian_bridal", "telugu_traditional"],
  malayali_traditional: ["south_indian_bridal", "tamil_iyer"],
  north_indian_bridal: ["punjabi_sikh", "rajasthani_traditional", "hd_airbrush"],
  punjabi_sikh: ["north_indian_bridal"],
  rajasthani_traditional: ["north_indian_bridal", "gujarati_traditional"],
  gujarati_traditional: ["rajasthani_traditional", "marathi_traditional"],
  marathi_traditional: ["gujarati_traditional"],
  bengali_traditional: ["north_indian_bridal"],
  muslim_nikah: ["north_indian_bridal", "hd_airbrush"],
  indo_western_fusion: ["minimal_natural", "hd_airbrush"],
  minimal_natural: ["indo_western_fusion"],
  hd_airbrush: ["north_indian_bridal", "indo_western_fusion"],
};

/**
 * 1.0 for an exact tag match, 0.5 for an adjacent style, 0 otherwise.
 */
export function tagAffinity(required: string, offered: string): number {
  if (required === offered) return 1;
  return TAG_AFFINITY[required]?.includes(offered) ? 0.5 : 0;
}

/** Languages spoken on set. Mis-matching these is a booking that goes quiet. */
export const LANGUAGES = [
  "english",
  "hindi",
  "telugu",
  "tamil",
  "gujarati",
  "punjabi",
  "urdu",
  "bengali",
  "marathi",
  "kannada",
  "malayalam",
  "nepali",
  "sinhala",
] as const;
export type Language = (typeof LANGUAGES)[number];

const LANGUAGE_SET = new Set<string>(LANGUAGES);
export function isLanguage(value: string): value is Language {
  return LANGUAGE_SET.has(value);
}

/**
 * Event types that customarily need a specialist for a given speciality, used
 * to pre-fill the gig wizard and to warn a host whose brief is under-staffed.
 */
export const CUSTOMARY_CREW: Partial<Record<EventType, readonly CrewSpecialty[]>> = {
  mehndi: ["henna_artist", "photographer", "mua"],
  haldi: ["photographer", "decorator", "mua"],
  sangeet: ["choreographer", "dj", "photographer", "videographer", "mua"],
  baraat: ["dhol_player", "photographer", "videographer"],
  hindu_ceremony: ["priest_pandit", "photographer", "videographer", "decorator", "mua", "saree_draper"],
  nikah: ["photographer", "videographer", "decorator", "mua"],
  sikh_anand_karaj: ["photographer", "videographer", "decorator"],
  reception: ["photographer", "videographer", "dj", "mua", "decorator"],
  griha_pravesham: ["priest_pandit", "photographer", "caterer"],
  half_saree_function: ["mua", "photographer", "saree_draper", "decorator"],
  mundan_child_carnival: ["priest_pandit", "photographer", "decorator"],
  garba_navratri: ["dj", "live_musician", "photographer", "choreographer"],
  boutique_lookbook: ["photographer", "mua", "hair_stylist", "saree_draper"],
  brand_campaign_shoot: ["photographer", "videographer", "mua", "drone_operator"],
  corporate_diwali: ["event_planner", "decorator", "dj", "caterer", "photographer"],
};
