/**
 * PostgreSQL implementations of the repository interfaces.
 *
 * The shapes these return are the same domain objects the in-memory store
 * returns, so the routes and the domain cannot tell the two apart -- which is
 * the point of the interfaces, and what lets the same end-to-end test run
 * against either.
 *
 * Two rules are worth stating because the schema depends on them:
 *
 *  * The ledger and the gig transition log are append-only, enforced by
 *    database triggers. `save` therefore inserts the entries it has not seen
 *    before rather than rewriting the set.
 *  * Points are stored as PostGIS geography. They go in as ST_MakePoint(lng,
 *    lat) -- longitude first, which is the order everyone gets wrong once --
 *    and come back out as separate numeric columns.
 */
import type {
  ApplicationRepository,
  Application,
  CredentialRepository,
  Credentials,
  EscrowRepository,
  GigRepository,
  ProfileRepository,
  Store,
  UserRepository,
} from "../store.js";
import type { BaseUser, CrewProfile, CreatorProfile, HostProfile, Role } from "../../domain/users.js";
import type { Gig, GigBrief, GigState, TransitionRecord } from "../../domain/gig.js";
import type { Escrow, EscrowState, LedgerEntry } from "../../domain/escrow.js";
import type { Quote } from "../../domain/money.js";
import type { Database } from "./db.js";

/**
 * A statement that RETURNINGs a row must actually produce one; if it does not,
 * something is wrong with the statement rather than with the data, so fail
 * loudly instead of returning a half-built object.
 */
function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what} to return a row, got none`);
  return row;
}

const num = (value: unknown): number => (typeof value === "string" ? Number(value) : (value as number));

class PgUsers implements UserRepository {
  constructor(private readonly db: Database) {}

  async create(user: BaseUser): Promise<BaseUser> {
    const rows = await this.db.query(
      `INSERT INTO users (id, email, phone_e164, display_name, roles, verification,
                          mfa_enabled, home_base, metro_code, languages, created_at)
       VALUES ($1, $2, $3, $4, $5::user_role[], $6::verification_level, $7,
               ST_MakePoint($8, $9)::geography, $10, $11::text[], $12)
       RETURNING ${USER_COLUMNS}`,
      [
        user.id,
        user.email,
        user.phone ?? null,
        user.displayName,
        user.roles,
        user.verification,
        user.mfaEnabled,
        user.homeBase.lng,
        user.homeBase.lat,
        user.metroId || null,
        user.languages,
        user.createdAt,
      ],
    );
    return toUser(first(rows, "the inserted user"));
  }

  async byId(id: string): Promise<BaseUser | undefined> {
    const rows = await this.db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async byEmail(email: string): Promise<BaseUser | undefined> {
    // email is CITEXT, so the comparison is already case-insensitive.
    const rows = await this.db.query(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async update(id: string, patch: Partial<BaseUser>): Promise<BaseUser> {
    // Built column by column so that an absent key means "leave it alone",
    // rather than overwriting it with null.
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };

    if (patch.email !== undefined) set("email", patch.email);
    if (patch.phone !== undefined) set("phone_e164", patch.phone);
    if (patch.displayName !== undefined) set("display_name", patch.displayName);
    if (patch.roles !== undefined) set("roles", patch.roles, "::user_role[]");
    if (patch.verification !== undefined) set("verification", patch.verification, "::verification_level");
    if (patch.mfaEnabled !== undefined) set("mfa_enabled", patch.mfaEnabled);
    if (patch.metroId !== undefined) set("metro_code", patch.metroId || null);
    if (patch.languages !== undefined) set("languages", patch.languages, "::text[]");
    if (patch.suspendedAt !== undefined) set("suspended_at", patch.suspendedAt);
    if (patch.homeBase !== undefined) {
      values.push(patch.homeBase.lng, patch.homeBase.lat);
      sets.push(`home_base = ST_MakePoint($${values.length - 1}, $${values.length})::geography`);
    }
    if (sets.length === 0) {
      const existing = await this.byId(id);
      if (!existing) throw new Error(`no such user: ${id}`);
      return existing;
    }

    const rows = await this.db.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error(`no such user: ${id}`);
    return toUser(rows[0]);
  }
}

/**
 * `roles` is cast to text[] on the way out on purpose.
 *
 * It is declared `user_role[]`, and node-postgres only has parsers for the
 * built-in array types -- a custom enum array comes back as the raw string
 * "{host}" rather than an array, and the first `.map` on it throws. The cast
 * hands back a type the driver does parse. `languages` is already text[], so
 * it needs no help.
 */
const USER_COLUMNS = `id, email, phone_e164, display_name, roles::text[] AS roles,
  verification, mfa_enabled,
  ST_Y(home_base::geometry) AS lat, ST_X(home_base::geometry) AS lng,
  metro_code, languages, suspended_at, created_at`;

function toUser(row: Record<string, unknown>): BaseUser {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    roles: row.roles as Role[],
    verification: row.verification as BaseUser["verification"],
    mfaEnabled: row.mfa_enabled as boolean,
    homeBase: { lat: num(row.lat), lng: num(row.lng) },
    metroId: (row.metro_code as string | null) ?? "",
    languages: (row.languages as BaseUser["languages"]) ?? [],
    createdAt: iso(row.created_at),
    ...(row.phone_e164 ? { phone: row.phone_e164 as string } : {}),
    ...(row.suspended_at ? { suspendedAt: iso(row.suspended_at) } : {}),
  };
}

class PgProfiles implements ProfileRepository {
  constructor(private readonly db: Database) {}

  async putHost(profile: HostProfile): Promise<HostProfile> {
    const rows = await this.db.query(
      `INSERT INTO host_profiles (user_id, kind, business_name, about, events_hosted, rating_avg, rating_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         kind = EXCLUDED.kind, business_name = EXCLUDED.business_name, about = EXCLUDED.about,
         events_hosted = EXCLUDED.events_hosted, rating_avg = EXCLUDED.rating_avg,
         rating_count = EXCLUDED.rating_count
       RETURNING *`,
      [
        profile.userId,
        profile.kind,
        profile.businessName ?? null,
        profile.about ?? null,
        profile.eventsHosted,
        profile.ratingAvg ?? null,
        profile.ratingCount,
      ],
    );
    return toHost(first(rows, "the upserted host profile"));
  }

  async host(userId: string): Promise<HostProfile | undefined> {
    const rows = await this.db.query(`SELECT * FROM host_profiles WHERE user_id = $1`, [userId]);
    return rows[0] ? toHost(rows[0]) : undefined;
  }

  /**
   * A crew profile spans three tables. The whole write is one transaction, and
   * the tag/speciality sets are replaced wholesale, because a profile that
   * kept a speciality the vendor just removed would keep matching gigs they no
   * longer take.
   */
  async putCrew(profile: CrewProfile): Promise<CrewProfile> {
    return this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO crew_profiles (user_id, starting_rate_cents, years_experience,
             free_radius_miles, per_mile_cents, max_radius_miles,
             overnight_threshold_miles, overnight_cents,
             rating_avg, rating_count, completed_gigs, median_response_minutes,
             stripe_account_id)
         VALUES ($1,$2,$3,
                 COALESCE($4, 25), COALESCE($5, 90), COALESCE($6, 300),
                 COALESCE($7, 120), COALESCE($8, 18000),
                 $9,$10,$11,$12,$13)
         ON CONFLICT (user_id) DO UPDATE SET
           starting_rate_cents = EXCLUDED.starting_rate_cents,
           years_experience = EXCLUDED.years_experience,
           free_radius_miles = EXCLUDED.free_radius_miles,
           per_mile_cents = EXCLUDED.per_mile_cents,
           max_radius_miles = EXCLUDED.max_radius_miles,
           overnight_threshold_miles = EXCLUDED.overnight_threshold_miles,
           overnight_cents = EXCLUDED.overnight_cents,
           rating_avg = EXCLUDED.rating_avg,
           rating_count = EXCLUDED.rating_count,
           completed_gigs = EXCLUDED.completed_gigs,
           median_response_minutes = EXCLUDED.median_response_minutes,
           stripe_account_id = EXCLUDED.stripe_account_id`,
        [
          profile.userId,
          profile.startingRateCents,
          profile.yearsExperience,
          profile.travelPolicy?.freeRadiusMiles ?? null,
          profile.travelPolicy?.perMileCents ?? null,
          profile.travelPolicy?.maxRadiusMiles ?? null,
          profile.travelPolicy?.overnightThresholdMiles ?? null,
          profile.travelPolicy?.overnightCents ?? null,
          profile.ratingAvg ?? null,
          profile.ratingCount,
          profile.completedGigs,
          profile.medianResponseMinutes ?? null,
          profile.stripeAccountId ?? null,
        ],
      );

      await tx.query(`DELETE FROM crew_specialty_links WHERE user_id = $1`, [profile.userId]);
      if (profile.specialties.length > 0) {
        await tx.query(
          `INSERT INTO crew_specialty_links (user_id, specialty_code)
           SELECT $1, unnest($2::text[])`,
          [profile.userId, profile.specialties],
        );
      }

      await tx.query(`DELETE FROM crew_cultural_tags WHERE user_id = $1`, [profile.userId]);
      if (profile.culturalTags.length > 0) {
        await tx.query(
          `INSERT INTO crew_cultural_tags (user_id, tag_code) SELECT $1, unnest($2::text[])`,
          [profile.userId, profile.culturalTags],
        );
      }

      await tx.query(`DELETE FROM vendor_unavailability WHERE user_id = $1`, [profile.userId]);
      if (profile.unavailableDates.length > 0) {
        await tx.query(
          `INSERT INTO vendor_unavailability (user_id, on_date) SELECT $1, unnest($2::date[])`,
          [profile.userId, profile.unavailableDates],
        );
      }

      const loaded = await loadCrew(tx, profile.userId);
      if (!loaded) throw new Error("crew profile vanished mid-transaction");
      return loaded;
    });
  }

  async crew(userId: string): Promise<CrewProfile | undefined> {
    return loadCrew(this.db, userId);
  }

  /**
   * The candidate pool for a gig. The speciality filter is the one that has to
   * be an index lookup rather than a scan, because it runs on every posting.
   */
  async crewBySpecialty(specialty: string): Promise<CrewProfile[]> {
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM crew_specialty_links WHERE specialty_code = $1`,
      [specialty],
    );
    const profiles = await Promise.all(rows.map((row) => loadCrew(this.db, row.user_id)));
    return profiles.filter((profile): profile is CrewProfile => profile !== undefined);
  }

  async putCreator(profile: CreatorProfile): Promise<CreatorProfile> {
    return this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO creator_profiles (user_id, disciplines, height_cm, day_rate_cents,
             rate_per_post_cents, rating_avg, rating_count, stripe_account_id)
         VALUES ($1, $2::text[], $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET
           disciplines = EXCLUDED.disciplines, height_cm = EXCLUDED.height_cm,
           day_rate_cents = EXCLUDED.day_rate_cents,
           rate_per_post_cents = EXCLUDED.rate_per_post_cents,
           rating_avg = EXCLUDED.rating_avg, rating_count = EXCLUDED.rating_count,
           stripe_account_id = EXCLUDED.stripe_account_id`,
        [
          profile.userId,
          profile.disciplines,
          profile.heightCm ?? null,
          profile.dayRateCents ?? null,
          profile.ratePerPostCents ?? null,
          profile.ratingAvg ?? null,
          profile.ratingCount,
          profile.stripeAccountId ?? null,
        ],
      );

      for (const account of profile.socials) {
        await tx.query(
          `INSERT INTO creator_socials (user_id, platform, handle, followers,
               texas_audience_share, engagement_rate, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (platform, handle) DO UPDATE SET
             followers = EXCLUDED.followers,
             texas_audience_share = EXCLUDED.texas_audience_share,
             engagement_rate = EXCLUDED.engagement_rate,
             verified_at = EXCLUDED.verified_at`,
          [
            profile.userId,
            account.platform,
            account.handle,
            account.followers,
            account.texasAudienceShare ?? null,
            account.engagementRate ?? null,
            account.verifiedAt ?? null,
          ],
        );
      }

      const loaded = await loadCreator(tx, profile.userId);
      if (!loaded) throw new Error("creator profile vanished mid-transaction");
      return loaded;
    });
  }

  async creator(userId: string): Promise<CreatorProfile | undefined> {
    return loadCreator(this.db, userId);
  }
}

function toHost(row: Record<string, unknown>): HostProfile {
  return {
    userId: row.user_id as string,
    kind: row.kind as HostProfile["kind"],
    eventsHosted: num(row.events_hosted),
    ratingCount: num(row.rating_count),
    ...(row.business_name ? { businessName: row.business_name as string } : {}),
    ...(row.about ? { about: row.about as string } : {}),
    ...(row.rating_avg === null || row.rating_avg === undefined
      ? {}
      : { ratingAvg: num(row.rating_avg) }),
  };
}

async function loadCrew(db: Database, userId: string): Promise<CrewProfile | undefined> {
  const rows = await db.query(`SELECT * FROM crew_profiles WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return undefined;

  const [specialties, tags, dates] = await Promise.all([
    db.query<{ specialty_code: string }>(
      `SELECT specialty_code FROM crew_specialty_links WHERE user_id = $1 ORDER BY specialty_code`,
      [userId],
    ),
    db.query<{ tag_code: string }>(
      `SELECT tag_code FROM crew_cultural_tags WHERE user_id = $1 ORDER BY tag_code`,
      [userId],
    ),
    db.query<{ on_date: Date }>(
      `SELECT on_date FROM vendor_unavailability WHERE user_id = $1 ORDER BY on_date`,
      [userId],
    ),
    ]);
  const assets = await db.query<{ id: string }>(
    `SELECT id FROM portfolio_assets WHERE user_id = $1 ORDER BY position, id`,
    [userId],
  );

  return {
    userId,
    specialties: specialties.map((r) => r.specialty_code) as CrewProfile["specialties"],
    culturalTags: tags.map((r) => r.tag_code) as CrewProfile["culturalTags"],
    startingRateCents: num(row.starting_rate_cents),
    travelPolicy: {
      freeRadiusMiles: num(row.free_radius_miles),
      perMileCents: num(row.per_mile_cents),
      maxRadiusMiles: num(row.max_radius_miles),
      overnightThresholdMiles: num(row.overnight_threshold_miles),
      overnightCents: num(row.overnight_cents),
    },
    unavailableDates: dates.map((r) => dateOnly(r.on_date)),
    yearsExperience: num(row.years_experience),
    ratingCount: num(row.rating_count),
    completedGigs: num(row.completed_gigs),
    portfolioAssetIds: assets.map((r) => r.id),
    ...(row.rating_avg === null ? {} : { ratingAvg: num(row.rating_avg) }),
    ...(row.median_response_minutes === null
      ? {}
      : { medianResponseMinutes: num(row.median_response_minutes) }),
    ...(row.stripe_account_id ? { stripeAccountId: row.stripe_account_id as string } : {}),
  };
}

async function loadCreator(db: Database, userId: string): Promise<CreatorProfile | undefined> {
  const rows = await db.query(`SELECT * FROM creator_profiles WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return undefined;

  const socials = await db.query(
    `SELECT * FROM creator_socials WHERE user_id = $1 ORDER BY platform, handle`,
    [userId],
  );
  const dates = await db.query<{ on_date: Date }>(
    `SELECT on_date FROM vendor_unavailability WHERE user_id = $1 ORDER BY on_date`,
    [userId],
  );
  const assets = await db.query<{ id: string }>(
    `SELECT id FROM portfolio_assets WHERE user_id = $1 ORDER BY position, id`,
    [userId],
  );

  return {
    userId,
    disciplines: (row.disciplines as CreatorProfile["disciplines"]) ?? [],
    culturalTags: [],
    socials: socials.map((account) => ({
      platform: account.platform as "instagram" | "tiktok" | "youtube",
      handle: account.handle as string,
      followers: num(account.followers),
      ...(account.texas_audience_share === null
        ? {}
        : { texasAudienceShare: num(account.texas_audience_share) }),
      ...(account.engagement_rate === null ? {} : { engagementRate: num(account.engagement_rate) }),
      ...(account.verified_at ? { verifiedAt: iso(account.verified_at) } : {}),
    })),
    unavailableDates: dates.map((r) => dateOnly(r.on_date)),
    portfolioAssetIds: assets.map((r) => r.id),
    ratingCount: num(row.rating_count),
    ...(row.height_cm === null ? {} : { heightCm: num(row.height_cm) }),
    ...(row.day_rate_cents === null ? {} : { dayRateCents: num(row.day_rate_cents) }),
    ...(row.rate_per_post_cents === null
      ? {}
      : { ratePerPostCents: num(row.rate_per_post_cents) }),
    ...(row.rating_avg === null ? {} : { ratingAvg: num(row.rating_avg) }),
    ...(row.stripe_account_id ? { stripeAccountId: row.stripe_account_id as string } : {}),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A DATE column must not be shifted by the server's timezone on the way out. */
function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

export { PgUsers, PgProfiles, loadCrew, loadCreator, toUser, iso, dateOnly, num, USER_COLUMNS };

/**
 * Gigs.
 *
 * The brief's cultural tags and languages are join tables, and the transition
 * history is an append-only log that a database trigger refuses to let anyone
 * update. `save` therefore appends the transitions it has not already written
 * rather than replacing them.
 */
class PgGigs implements GigRepository {
  constructor(private readonly db: Database) {}

  async create(gig: Gig): Promise<Gig> {
    return this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO gigs (id, host_id, state, event_type_code, specialty_code, event_date,
             venue, metro_code, budget_min_cents, budget_max_cents, headcount, notes,
             application_count, created_at)
         VALUES ($1, $2, $3::gig_state, $4, $5, $6,
                 ST_MakePoint($7, $8)::geography, $9, $10, $11, $12, $13, $14, $15)`,
        [
          gig.id,
          gig.hostId,
          gig.state,
          gig.brief.eventType,
          gig.brief.specialty,
          gig.brief.eventDate,
          gig.brief.venue.lng,
          gig.brief.venue.lat,
          gig.brief.metroId || null,
          gig.brief.budgetMinCents,
          gig.brief.budgetMaxCents,
          gig.brief.headcount ?? null,
          gig.brief.notes ?? null,
          gig.applicationCount,
          gig.createdAt,
        ],
      );
      await writeBriefLinks(tx, gig);
      await appendTransitions(tx, gig.id, gig.history, 0);
      return loadGigOrThrow(tx, gig.id);
    });
  }

  async byId(id: string): Promise<Gig | undefined> {
    return loadGig(this.db, id);
  }

  async byHost(hostId: string): Promise<Gig[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM gigs WHERE host_id = $1 ORDER BY created_at DESC`,
      [hostId],
    );
    const gigs = await Promise.all(rows.map((row) => loadGig(this.db, row.id)));
    return gigs.filter((gig): gig is Gig => gig !== undefined);
  }

  async open(specialties?: readonly string[]): Promise<Gig[]> {
    // The WHERE clause mirrors the partial index in 001_init.sql exactly, so
    // the planner can use it; widening it here would quietly turn this into a
    // sequential scan on the busiest read in the vendor app.
    const rows = specialties?.length
      ? await this.db.query<{ id: string }>(
          `SELECT id FROM gigs
           WHERE state IN ('Open', 'ApplicationsReview')
             AND specialty_code = ANY($1::text[])
           ORDER BY event_date`,
          [specialties],
        )
      : await this.db.query<{ id: string }>(
          `SELECT id FROM gigs
           WHERE state IN ('Open', 'ApplicationsReview')
           ORDER BY event_date`,
        );
    const gigs = await Promise.all(rows.map((row) => loadGig(this.db, row.id)));
    return gigs.filter((gig): gig is Gig => gig !== undefined);
  }

  async save(gig: Gig): Promise<Gig> {
    return this.db.withTransaction(async (tx) => {
      const existing = await tx.query<{ transitions: string }>(
        `SELECT count(*)::text AS transitions FROM gig_transitions WHERE gig_id = $1`,
        [gig.id],
      );
      const alreadyWritten = Number(first(existing, "a transition count").transitions);

      const updated = await tx.query(
        `UPDATE gigs SET
           state = $2::gig_state,
           event_type_code = $3,
           specialty_code = $4,
           event_date = $5,
           venue = ST_MakePoint($6, $7)::geography,
           metro_code = $8,
           budget_min_cents = $9,
           budget_max_cents = $10,
           headcount = $11,
           notes = $12,
           application_count = $13,
           accepted_offer_id = $14,
           escrow_id = $15,
           cancellation_reason = $16,
           published_at = COALESCE(published_at, CASE WHEN $2 <> 'Draft' THEN now() END)
         WHERE id = $1
         RETURNING id`,
        [
          gig.id,
          gig.state,
          gig.brief.eventType,
          gig.brief.specialty,
          gig.brief.eventDate,
          gig.brief.venue.lng,
          gig.brief.venue.lat,
          gig.brief.metroId || null,
          gig.brief.budgetMinCents,
          gig.brief.budgetMaxCents,
          gig.brief.headcount ?? null,
          gig.brief.notes ?? null,
          gig.applicationCount,
          gig.acceptedOfferId ?? null,
          gig.escrowId ?? null,
          gig.cancellationReason ?? null,
        ],
      );
      if (updated.length === 0) throw new Error(`no such gig: ${gig.id}`);

      await writeBriefLinks(tx, gig);
      await appendTransitions(tx, gig.id, gig.history, alreadyWritten);
      return loadGigOrThrow(tx, gig.id);
    });
  }
}

async function writeBriefLinks(tx: Database, gig: Gig): Promise<void> {
  await tx.query(`DELETE FROM gig_cultural_tags WHERE gig_id = $1`, [gig.id]);
  if (gig.brief.culturalTags.length > 0) {
    await tx.query(
      `INSERT INTO gig_cultural_tags (gig_id, tag_code) SELECT $1, unnest($2::text[])`,
      [gig.id, gig.brief.culturalTags],
    );
  }
  await tx.query(`DELETE FROM gig_languages WHERE gig_id = $1`, [gig.id]);
  if (gig.brief.languages.length > 0) {
    await tx.query(
      `INSERT INTO gig_languages (gig_id, language_code) SELECT $1, unnest($2::text[])`,
      [gig.id, gig.brief.languages],
    );
  }
}

/**
 * Write only the transitions beyond those already stored. The log is
 * append-only at the database level, so re-writing the whole history would be
 * rejected by the trigger rather than quietly duplicating rows.
 */
async function appendTransitions(
  tx: Database,
  gigId: string,
  history: readonly TransitionRecord[],
  alreadyWritten: number,
): Promise<void> {
  for (const record of history.slice(alreadyWritten)) {
    await tx.query(
      `INSERT INTO gig_transitions (gig_id, from_state, to_state, actor, actor_id, reason, occurred_at)
       VALUES ($1, $2::gig_state, $3::gig_state, $4::transition_actor, $5, $6, $7)`,
      [gigId, record.from, record.to, record.actor, record.actorId, record.reason ?? null, record.at],
    );
  }
}

const GIG_COLUMNS = `id, host_id, state, event_type_code, specialty_code, event_date,
  ST_Y(venue::geometry) AS lat, ST_X(venue::geometry) AS lng,
  metro_code, budget_min_cents, budget_max_cents, headcount, notes,
  application_count, accepted_offer_id, escrow_id, cancellation_reason,
  created_at, updated_at`;

async function loadGig(db: Database, id: string): Promise<Gig | undefined> {
  const rows = await db.query(`SELECT ${GIG_COLUMNS} FROM gigs WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return undefined;

  const [tags, languages, history] = await Promise.all([
    db.query<{ tag_code: string }>(
      `SELECT tag_code FROM gig_cultural_tags WHERE gig_id = $1 ORDER BY tag_code`,
      [id],
    ),
    db.query<{ language_code: string }>(
      `SELECT language_code FROM gig_languages WHERE gig_id = $1 ORDER BY language_code`,
      [id],
    ),
    db.query(`SELECT * FROM gig_transitions WHERE gig_id = $1 ORDER BY id`, [id]),
  ]);

  const brief: GigBrief = {
    eventType: row.event_type_code as GigBrief["eventType"],
    specialty: row.specialty_code as GigBrief["specialty"],
    eventDate: dateOnly(row.event_date),
    venue: { lat: num(row.lat), lng: num(row.lng) },
    metroId: (row.metro_code as string | null) ?? "",
    budgetMinCents: num(row.budget_min_cents),
    budgetMaxCents: num(row.budget_max_cents),
    culturalTags: tags.map((t) => t.tag_code) as GigBrief["culturalTags"],
    languages: languages.map((l) => l.language_code) as GigBrief["languages"],
    ...(row.headcount === null ? {} : { headcount: num(row.headcount) }),
    ...(row.notes ? { notes: row.notes as string } : {}),
  };

  return {
    id: row.id as string,
    hostId: row.host_id as string,
    state: row.state as GigState,
    brief,
    applicationCount: num(row.application_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    history: history.map((record) => ({
      from: record.from_state as GigState,
      to: record.to_state as GigState,
      actor: record.actor as TransitionRecord["actor"],
      actorId: record.actor_id as string,
      at: iso(record.occurred_at),
      ...(record.reason ? { reason: record.reason as string } : {}),
    })),
    ...(row.accepted_offer_id ? { acceptedOfferId: row.accepted_offer_id as string } : {}),
    ...(row.escrow_id ? { escrowId: row.escrow_id as string } : {}),
    ...(row.cancellation_reason ? { cancellationReason: row.cancellation_reason as string } : {}),
  };
}

async function loadGigOrThrow(db: Database, id: string): Promise<Gig> {
  const gig = await loadGig(db, id);
  if (!gig) throw new Error(`no such gig: ${id}`);
  return gig;
}

class PgApplications implements ApplicationRepository {
  constructor(private readonly db: Database) {}

  async create(application: Application): Promise<Application> {
    const rows = await this.db.query(
      `INSERT INTO applications (id, gig_id, vendor_id, quoted_rate_cents, message, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::application_status, $7)
       RETURNING *`,
      [
        application.id,
        application.gigId,
        application.vendorId,
        application.quotedRateCents,
        application.message ?? null,
        application.status,
        application.createdAt,
      ],
    );
    return toApplication(first(rows, "the inserted application"));
  }

  async byId(id: string): Promise<Application | undefined> {
    const rows = await this.db.query(`SELECT * FROM applications WHERE id = $1`, [id]);
    return rows[0] ? toApplication(rows[0]) : undefined;
  }

  async byGig(gigId: string): Promise<Application[]> {
    const rows = await this.db.query(
      `SELECT * FROM applications WHERE gig_id = $1 ORDER BY created_at`,
      [gigId],
    );
    return rows.map(toApplication);
  }

  async save(application: Application): Promise<Application> {
    const rows = await this.db.query(
      `UPDATE applications SET quoted_rate_cents = $2, message = $3, status = $4::application_status
       WHERE id = $1 RETURNING *`,
      [application.id, application.quotedRateCents, application.message ?? null, application.status],
    );
    if (rows.length === 0) throw new Error(`no such application: ${application.id}`);
    return toApplication(first(rows, "the updated application"));
  }
}

function toApplication(row: Record<string, unknown>): Application {
  return {
    id: row.id as string,
    gigId: row.gig_id as string,
    vendorId: row.vendor_id as string,
    quotedRateCents: num(row.quoted_rate_cents),
    status: row.status as Application["status"],
    createdAt: iso(row.created_at),
    ...(row.message ? { message: row.message as string } : {}),
  };
}

/**
 * Escrows.
 *
 * The quote is frozen at booking: it is written once on create and never
 * updated, because the parties agreed to those numbers and a later change to
 * the fee schedule must not move them. `save` writes the escrow's mutable
 * state and appends any new ledger entries -- the ledger itself is append-only
 * and a trigger enforces it.
 */
class PgEscrows implements EscrowRepository {
  constructor(private readonly db: Database) {}

  async create(escrow: Escrow): Promise<Escrow> {
    return this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO escrows (id, gig_id, host_id, vendor_id, state, transfer_group,
             service_subtotal_cents, travel_fee_cents, host_service_fee_cents, host_total_cents,
             deposit_due_cents, balance_due_cents, vendor_commission_cents, vendor_payout_cents,
             platform_revenue_cents, deposit_intent_id, balance_intent_id, transfer_id, created_at)
         VALUES ($1,$2,$3,$4,$5::escrow_state,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          escrow.id,
          escrow.gigId,
          escrow.hostId,
          escrow.vendorId,
          escrow.state,
          escrow.transferGroup,
          escrow.quote.serviceSubtotal,
          escrow.quote.travelFee,
          escrow.quote.hostServiceFee,
          escrow.quote.hostTotal,
          escrow.quote.depositDue,
          escrow.quote.balanceDue,
          escrow.quote.vendorCommission,
          escrow.quote.vendorPayout,
          escrow.quote.platformRevenue,
          escrow.depositIntentId ?? null,
          escrow.balanceIntentId ?? null,
          escrow.transferId ?? null,
          escrow.createdAt,
        ],
      );
      await appendLedger(tx, escrow.id, escrow.entries, 0);
      return loadEscrowOrThrow(tx, escrow.id);
    });
  }

  async byId(id: string): Promise<Escrow | undefined> {
    return loadEscrow(this.db, id);
  }

  async byGig(gigId: string): Promise<Escrow | undefined> {
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM escrows WHERE gig_id = $1`, [gigId]);
    return rows[0] ? loadEscrow(this.db, rows[0].id) : undefined;
  }

  async save(escrow: Escrow): Promise<Escrow> {
    return this.db.withTransaction(async (tx) => {
      const counted = await tx.query<{ entries: string }>(
        `SELECT count(*)::text AS entries FROM ledger_entries WHERE escrow_id = $1`,
        [escrow.id],
      );
      const alreadyWritten = Number(first(counted, "a ledger count").entries);

      const updated = await tx.query(
        `UPDATE escrows SET state = $2::escrow_state, deposit_intent_id = $3,
             balance_intent_id = $4, transfer_id = $5
         WHERE id = $1 RETURNING id`,
        [
          escrow.id,
          escrow.state,
          escrow.depositIntentId ?? null,
          escrow.balanceIntentId ?? null,
          escrow.transferId ?? null,
        ],
      );
      if (updated.length === 0) throw new Error(`no such escrow: ${escrow.id}`);

      await appendLedger(tx, escrow.id, escrow.entries, alreadyWritten);
      return loadEscrowOrThrow(tx, escrow.id);
    });
  }
}

async function appendLedger(
  tx: Database,
  escrowId: string,
  entries: readonly LedgerEntry[],
  alreadyWritten: number,
): Promise<void> {
  for (const entry of entries.slice(alreadyWritten)) {
    await tx.query(
      `INSERT INTO ledger_entries (escrow_id, entry_type, amount_cents, stripe_ref, note, occurred_at)
       VALUES ($1, $2::ledger_entry_type, $3, $4, $5, $6)`,
      [escrowId, entry.type, entry.amountCents, entry.stripeRef ?? null, entry.note ?? null, entry.at],
    );
  }
}

async function loadEscrow(db: Database, id: string): Promise<Escrow | undefined> {
  const rows = await db.query(`SELECT * FROM escrows WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return undefined;

  const entries = await db.query(
    `SELECT * FROM ledger_entries WHERE escrow_id = $1 ORDER BY id`,
    [id],
  );

  const quote: Quote = {
    serviceSubtotal: num(row.service_subtotal_cents),
    travelFee: num(row.travel_fee_cents),
    hostServiceFee: num(row.host_service_fee_cents),
    hostTotal: num(row.host_total_cents),
    depositDue: num(row.deposit_due_cents),
    balanceDue: num(row.balance_due_cents),
    vendorCommission: num(row.vendor_commission_cents),
    vendorPayout: num(row.vendor_payout_cents),
    platformRevenue: num(row.platform_revenue_cents),
  };

  return {
    id: row.id as string,
    gigId: row.gig_id as string,
    hostId: row.host_id as string,
    vendorId: row.vendor_id as string,
    quote,
    state: row.state as EscrowState,
    transferGroup: row.transfer_group as string,
    entries: entries.map((entry) => ({
      id: String(entry.id),
      type: entry.entry_type as LedgerEntry["type"],
      amountCents: num(entry.amount_cents),
      at: iso(entry.occurred_at),
      ...(entry.stripe_ref ? { stripeRef: entry.stripe_ref as string } : {}),
      ...(entry.note ? { note: entry.note as string } : {}),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.deposit_intent_id ? { depositIntentId: row.deposit_intent_id as string } : {}),
    ...(row.balance_intent_id ? { balanceIntentId: row.balance_intent_id as string } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id as string } : {}),
  };
}

async function loadEscrowOrThrow(db: Database, id: string): Promise<Escrow> {
  const escrow = await loadEscrow(db, id);
  if (!escrow) throw new Error(`no such escrow: ${id}`);
  return escrow;
}

class PgCredentials implements CredentialRepository {
  constructor(private readonly db: Database) {}

  async put(credentials: Credentials): Promise<Credentials> {
    const rows = await this.db.query(
      `INSERT INTO user_credentials (user_id, password_hash, otp_hash, otp_expires_at,
           failed_attempts, locked_until)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         otp_hash = EXCLUDED.otp_hash,
         otp_expires_at = EXCLUDED.otp_expires_at,
         failed_attempts = EXCLUDED.failed_attempts,
         locked_until = EXCLUDED.locked_until
       RETURNING *`,
      [
        credentials.userId,
        credentials.passwordHash,
        credentials.otpHash ?? null,
        credentials.otpExpiresAt ?? null,
        credentials.failedAttempts,
        credentials.lockedUntil ?? null,
      ],
    );
    return toCredentials(first(rows, "the upserted credentials"));
  }

  async byUserId(userId: string): Promise<Credentials | undefined> {
    const rows = await this.db.query(`SELECT * FROM user_credentials WHERE user_id = $1`, [userId]);
    return rows[0] ? toCredentials(rows[0]) : undefined;
  }
}

function toCredentials(row: Record<string, unknown>): Credentials {
  return {
    userId: row.user_id as string,
    passwordHash: row.password_hash as string,
    failedAttempts: num(row.failed_attempts),
    ...(row.otp_hash ? { otpHash: row.otp_hash as string } : {}),
    ...(row.otp_expires_at ? { otpExpiresAt: iso(row.otp_expires_at) } : {}),
    ...(row.locked_until ? { lockedUntil: iso(row.locked_until) } : {}),
  };
}

/**
 * Build a Store backed by PostgreSQL. Pass a database scoped with `asUser` to
 * have every read go through the row-level security policies as that user.
 */
export function createPostgresStore(db: Database): Store {
  return {
    users: new PgUsers(db),
    profiles: new PgProfiles(db),
    gigs: new PgGigs(db),
    applications: new PgApplications(db),
    escrows: new PgEscrows(db),
    credentials: new PgCredentials(db),
  };
}

export { PgGigs, PgApplications, PgEscrows, PgCredentials, loadGig, loadEscrow };
