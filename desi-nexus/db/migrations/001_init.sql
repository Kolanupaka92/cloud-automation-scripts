-- DESI-NEXUS core schema (PostgreSQL 15+)
--
-- This is the ledger-of-record. Anything that must reconcile -- identities,
-- bookings, money -- lives here under real constraints. The fast-moving,
-- shape-varying data (chat history, portfolio metadata, notification state)
-- belongs in the document store; it is referenced from here by id and never
-- joined against.
--
-- Conventions:
--   * money is BIGINT cents, never NUMERIC and never a float
--   * timestamps are TIMESTAMPTZ, stored UTC
--   * enums are native PostgreSQL types, so a bad value cannot be written
--   * every table carries created_at; mutable ones carry updated_at

BEGIN;

-- Extensions are pinned to `public` rather than left to the search path. An
-- unqualified CREATE EXTENSION installs into the first schema on the search
-- path, so a deployment that puts the application's tables in their own schema
-- would install PostGIS there too -- and then dropping that schema takes the
-- geography type with it.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "postgis"  WITH SCHEMA public;  -- geography(Point)
CREATE EXTENSION IF NOT EXISTS "pg_trgm"  WITH SCHEMA public;  -- fuzzy name search
CREATE EXTENSION IF NOT EXISTS "citext"   WITH SCHEMA public;  -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('host', 'crew', 'creator', 'admin');

CREATE TYPE verification_level AS ENUM (
    'unverified', 'phone_verified', 'id_verified', 'business_verified'
);

CREATE TYPE gig_state AS ENUM (
    'Draft', 'Open', 'ApplicationsReview', 'EscrowLocked',
    'InTransit', 'Active', 'DeliveryPending', 'Completed',
    'Cancelled', 'Disputed'
);

CREATE TYPE escrow_state AS ENUM (
    'Initiated', 'AwaitingDeposit', 'DepositHeld', 'FullyFunded',
    'ReleasePending', 'Released', 'PartiallyRefunded', 'Refunded', 'Disputed'
);

CREATE TYPE application_status AS ENUM (
    'submitted', 'shortlisted', 'offered', 'accepted', 'declined', 'withdrawn'
);

CREATE TYPE ledger_entry_type AS ENUM (
    'deposit_captured', 'balance_captured', 'refund_issued',
    'payout_released', 'commission_taken', 'dispute_hold', 'dispute_released'
);

CREATE TYPE transition_actor AS ENUM ('host', 'vendor', 'system', 'admin');

-- ---------------------------------------------------------------------------
-- Reference data: the cultural vocabulary
--
-- These are tables rather than enums because the taxonomy grows -- adding a
-- regional ceremony must be a migration-free insert, not a type alteration
-- that locks every dependent table.
-- ---------------------------------------------------------------------------

CREATE TABLE event_types (
    code          TEXT PRIMARY KEY,
    label         TEXT        NOT NULL,
    event_group   TEXT        NOT NULL,
    is_commercial BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crew_specialties (
    code       TEXT PRIMARY KEY,
    label      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cultural_tags (
    code       TEXT PRIMARY KEY,
    label      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adjacency between styles, powering the partial-credit half of the match
-- score. Symmetry is maintained by the application, not assumed here.
CREATE TABLE cultural_tag_affinity (
    tag_code       TEXT NOT NULL REFERENCES cultural_tags(code) ON DELETE CASCADE,
    related_code   TEXT NOT NULL REFERENCES cultural_tags(code) ON DELETE CASCADE,
    affinity       NUMERIC(3, 2) NOT NULL CHECK (affinity > 0 AND affinity <= 1),
    PRIMARY KEY (tag_code, related_code),
    CHECK (tag_code <> related_code)
);

CREATE TABLE metros (
    code          TEXT PRIMARY KEY,
    name          TEXT   NOT NULL,
    center        GEOGRAPHY(Point, 4326) NOT NULL,
    radius_miles  NUMERIC(6, 2) NOT NULL CHECK (radius_miles > 0),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE languages (
    code  TEXT PRIMARY KEY,
    label TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email              CITEXT      NOT NULL UNIQUE,
    phone_e164         TEXT UNIQUE CHECK (phone_e164 ~ '^\+[1-9]\d{7,14}$'),
    display_name       TEXT        NOT NULL CHECK (length(trim(display_name)) >= 2),
    roles              user_role[] NOT NULL CHECK (array_length(roles, 1) >= 1),
    verification       verification_level NOT NULL DEFAULT 'unverified',
    mfa_enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
    home_base          GEOGRAPHY(Point, 4326) NOT NULL,
    metro_code         TEXT        REFERENCES metros(code),
    languages          TEXT[]      NOT NULL DEFAULT '{}',
    suspended_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_home_base_gix ON users USING GIST (home_base);
CREATE INDEX users_metro_idx     ON users (metro_code);
CREATE INDEX users_roles_gin     ON users USING GIN (roles);

-- Credential material is split out so that the row a service reads to render a
-- profile is not the row that holds a password hash. No column here is ever
-- returned by an API.
CREATE TABLE user_credentials (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash   TEXT        NOT NULL,
    mfa_secret_enc  BYTEA,                       -- envelope-encrypted via KMS
    otp_hash        TEXT,
    otp_expires_at  TIMESTAMPTZ,
    failed_attempts INT         NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The polymorphic half: one row per role a user actually holds.
CREATE TABLE host_profiles (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('business', 'individual')),
    business_name TEXT,
    about         TEXT,
    events_hosted INT  NOT NULL DEFAULT 0,
    rating_avg    NUMERIC(3, 2) CHECK (rating_avg BETWEEN 1 AND 5),
    rating_count  INT  NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind <> 'business' OR business_name IS NOT NULL)
);

CREATE TABLE crew_profiles (
    user_id                   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    starting_rate_cents       BIGINT NOT NULL CHECK (starting_rate_cents > 0),
    years_experience          INT    NOT NULL DEFAULT 0,
    free_radius_miles         NUMERIC(6, 2) NOT NULL DEFAULT 25,
    per_mile_cents            BIGINT NOT NULL DEFAULT 90 CHECK (per_mile_cents >= 0),
    max_radius_miles          NUMERIC(6, 2) NOT NULL DEFAULT 300,
    overnight_threshold_miles NUMERIC(6, 2) NOT NULL DEFAULT 120,
    overnight_cents           BIGINT NOT NULL DEFAULT 18000 CHECK (overnight_cents >= 0),
    rating_avg                NUMERIC(3, 2) CHECK (rating_avg BETWEEN 1 AND 5),
    rating_count              INT    NOT NULL DEFAULT 0,
    completed_gigs            INT    NOT NULL DEFAULT 0,
    median_response_minutes   INT,
    -- Stripe's connected-account id. An opaque reference: no card, bank or tax
    -- detail is ever stored on our side.
    stripe_account_id         TEXT UNIQUE,
    payouts_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (max_radius_miles >= free_radius_miles)
);

CREATE TABLE crew_specialty_links (
    user_id        UUID NOT NULL REFERENCES crew_profiles(user_id) ON DELETE CASCADE,
    specialty_code TEXT NOT NULL REFERENCES crew_specialties(code),
    PRIMARY KEY (user_id, specialty_code)
);
CREATE INDEX crew_specialty_lookup ON crew_specialty_links (specialty_code, user_id);

CREATE TABLE crew_cultural_tags (
    user_id  UUID NOT NULL REFERENCES crew_profiles(user_id) ON DELETE CASCADE,
    tag_code TEXT NOT NULL REFERENCES cultural_tags(code),
    PRIMARY KEY (user_id, tag_code)
);
CREATE INDEX crew_tag_lookup ON crew_cultural_tags (tag_code, user_id);

CREATE TABLE creator_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    disciplines         TEXT[] NOT NULL DEFAULT '{}',
    height_cm           INT CHECK (height_cm BETWEEN 100 AND 250),
    day_rate_cents      BIGINT CHECK (day_rate_cents > 0),
    rate_per_post_cents BIGINT CHECK (rate_per_post_cents > 0),
    rating_avg          NUMERIC(3, 2) CHECK (rating_avg BETWEEN 1 AND 5),
    rating_count        INT    NOT NULL DEFAULT 0,
    stripe_account_id   TEXT UNIQUE,
    payouts_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Follower counts are only meaningful once proven through the platform's own
-- OAuth: verified_at NULL means the creator typed the number in themselves.
CREATE TABLE creator_socials (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES creator_profiles(user_id) ON DELETE CASCADE,
    platform              TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube')),
    handle                TEXT NOT NULL,
    followers             BIGINT NOT NULL DEFAULT 0 CHECK (followers >= 0),
    texas_audience_share  NUMERIC(4, 3) CHECK (texas_audience_share BETWEEN 0 AND 1),
    engagement_rate       NUMERIC(5, 4) CHECK (engagement_rate BETWEEN 0 AND 1),
    verified_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (platform, handle)
);

-- Availability is stored as blocked dates rather than free ones: a vendor is
-- assumed available, and the calendar sync writes exceptions.
CREATE TABLE vendor_unavailability (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    on_date    DATE NOT NULL,
    reason     TEXT,
    PRIMARY KEY (user_id, on_date)
);

-- Media lives in S3 behind CloudFront; only the reference is stored.
CREATE TABLE portfolio_assets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    s3_key       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    width_px     INT,
    height_px    INT,
    position     INT  NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX portfolio_by_user ON portfolio_assets (user_id, position);

-- ---------------------------------------------------------------------------
-- Gigs
-- ---------------------------------------------------------------------------

CREATE TABLE gigs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id             UUID NOT NULL REFERENCES users(id),
    state               gig_state NOT NULL DEFAULT 'Draft',
    event_type_code     TEXT NOT NULL REFERENCES event_types(code),
    specialty_code      TEXT NOT NULL REFERENCES crew_specialties(code),
    event_date          DATE NOT NULL,
    venue               GEOGRAPHY(Point, 4326) NOT NULL,
    venue_address       TEXT,
    metro_code          TEXT REFERENCES metros(code),
    budget_min_cents    BIGINT NOT NULL CHECK (budget_min_cents >= 0),
    budget_max_cents    BIGINT NOT NULL CHECK (budget_max_cents > 0),
    headcount           INT CHECK (headcount > 0),
    notes               TEXT,
    application_count   INT  NOT NULL DEFAULT 0,
    accepted_offer_id   UUID,
    escrow_id           UUID,
    cancellation_reason TEXT,
    published_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (budget_max_cents >= budget_min_cents),
    -- A gig past Draft must carry a reason it was cancelled, if it was.
    CHECK (state <> 'Cancelled' OR cancellation_reason IS NOT NULL OR published_at IS NULL)
);

CREATE INDEX gigs_venue_gix     ON gigs USING GIST (venue);
CREATE INDEX gigs_open_lookup   ON gigs (specialty_code, event_date) WHERE state IN ('Open', 'ApplicationsReview');
CREATE INDEX gigs_by_host       ON gigs (host_id, created_at DESC);

CREATE TABLE gig_cultural_tags (
    gig_id   UUID NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
    tag_code TEXT NOT NULL REFERENCES cultural_tags(code),
    PRIMARY KEY (gig_id, tag_code)
);

CREATE TABLE gig_languages (
    gig_id        UUID NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL REFERENCES languages(code),
    PRIMARY KEY (gig_id, language_code)
);

-- The audit trail the ledger reconciles against. Append-only: there is no
-- UPDATE or DELETE grant on this table for the application role.
CREATE TABLE gig_transitions (
    id           BIGSERIAL PRIMARY KEY,
    gig_id       UUID NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
    from_state   gig_state NOT NULL,
    to_state     gig_state NOT NULL,
    actor        transition_actor NOT NULL,
    actor_id     TEXT NOT NULL,
    reason       TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gig_transitions_by_gig ON gig_transitions (gig_id, id);

CREATE TABLE applications (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gig_id             UUID NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
    vendor_id          UUID NOT NULL REFERENCES users(id),
    quoted_rate_cents  BIGINT NOT NULL CHECK (quoted_rate_cents > 0),
    message            TEXT,
    status             application_status NOT NULL DEFAULT 'submitted',
    match_score        SMALLINT CHECK (match_score BETWEEN 0 AND 100),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One application per vendor per gig, enforced by the database rather than
    -- by a read-then-write race in the service.
    UNIQUE (gig_id, vendor_id)
);
CREATE INDEX applications_by_gig ON applications (gig_id, status);

-- Exactly one accepted application per gig, at the storage layer.
CREATE UNIQUE INDEX one_accepted_application_per_gig
    ON applications (gig_id) WHERE status = 'accepted';

ALTER TABLE gigs
    ADD CONSTRAINT gigs_accepted_offer_fk
    FOREIGN KEY (accepted_offer_id) REFERENCES applications(id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

CREATE TABLE escrows (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gig_id                 UUID NOT NULL UNIQUE REFERENCES gigs(id),
    host_id                UUID NOT NULL REFERENCES users(id),
    vendor_id              UUID NOT NULL REFERENCES users(id),
    state                  escrow_state NOT NULL DEFAULT 'AwaitingDeposit',
    transfer_group         TEXT NOT NULL UNIQUE,

    -- The quote, frozen at booking. Never recomputed: the parties agreed to
    -- these numbers, and a later change to the fee schedule must not move them.
    service_subtotal_cents BIGINT NOT NULL CHECK (service_subtotal_cents >= 0),
    travel_fee_cents       BIGINT NOT NULL DEFAULT 0 CHECK (travel_fee_cents >= 0),
    host_service_fee_cents BIGINT NOT NULL CHECK (host_service_fee_cents >= 0),
    host_total_cents       BIGINT NOT NULL CHECK (host_total_cents > 0),
    deposit_due_cents      BIGINT NOT NULL CHECK (deposit_due_cents >= 0),
    balance_due_cents      BIGINT NOT NULL CHECK (balance_due_cents >= 0),
    vendor_commission_cents BIGINT NOT NULL CHECK (vendor_commission_cents >= 0),
    vendor_payout_cents    BIGINT NOT NULL CHECK (vendor_payout_cents >= 0),
    platform_revenue_cents BIGINT NOT NULL CHECK (platform_revenue_cents >= 0),

    deposit_intent_id      TEXT UNIQUE,
    balance_intent_id      TEXT UNIQUE,
    transfer_id            TEXT UNIQUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The identities the application asserts, enforced here too. If these ever
    -- disagree with the code, the database wins and the write fails loudly.
    CONSTRAINT escrow_payout_split_balances
        CHECK (host_total_cents = vendor_payout_cents + platform_revenue_cents),
    CONSTRAINT escrow_capture_split_balances
        CHECK (host_total_cents = deposit_due_cents + balance_due_cents),
    CONSTRAINT escrow_host_and_vendor_differ
        CHECK (host_id <> vendor_id)
);

ALTER TABLE gigs
    ADD CONSTRAINT gigs_escrow_fk
    FOREIGN KEY (escrow_id) REFERENCES escrows(id) DEFERRABLE INITIALLY DEFERRED;

-- The append-only ledger. Balances are derived by folding this table; there is
-- deliberately no balance column to drift out of step with it.
CREATE TABLE ledger_entries (
    id           BIGSERIAL PRIMARY KEY,
    escrow_id    UUID NOT NULL REFERENCES escrows(id),
    entry_type   ledger_entry_type NOT NULL,
    -- Positive into the vault, negative out of it.
    amount_cents BIGINT NOT NULL,
    -- The Stripe object this entry corresponds to. Unique, so a replayed
    -- webhook cannot book the same capture twice however many times it arrives.
    stripe_ref   TEXT UNIQUE,
    note         TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_by_escrow ON ledger_entries (escrow_id, id);

CREATE TABLE disputes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id     UUID NOT NULL REFERENCES escrows(id),
    opened_by     UUID NOT NULL REFERENCES users(id),
    reason        TEXT NOT NULL,
    resolution    TEXT,
    to_vendor_cents BIGINT CHECK (to_vendor_cents >= 0),
    to_host_cents   BIGINT CHECK (to_host_cents >= 0),
    resolved_by   UUID REFERENCES users(id),
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    CHECK (resolved_at IS NULL OR resolution IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------

CREATE TABLE reviews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gig_id      UUID NOT NULL REFERENCES gigs(id),
    author_id   UUID NOT NULL REFERENCES users(id),
    subject_id  UUID NOT NULL REFERENCES users(id),
    rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One review per direction per gig, and never about yourself.
    UNIQUE (gig_id, author_id, subject_id),
    CHECK (author_id <> subject_id)
);

-- ---------------------------------------------------------------------------
-- Transactional outbox
--
-- Domain events are written here in the same transaction as the state change
-- they describe, and relayed to Kafka by a separate poller. Without this, a
-- broker blip means a gig goes live and nobody is ever notified.
-- ---------------------------------------------------------------------------

CREATE TABLE event_outbox (
    id           BIGSERIAL PRIMARY KEY,
    topic        TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    payload      JSONB NOT NULL,
    trace_id     TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON event_outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- The application connects as a non-superuser role. Even with a SQL-injection
-- foothold in a query, a host cannot read another host's bookings.
-- ---------------------------------------------------------------------------

ALTER TABLE gigs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrows  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews  ENABLE ROW LEVEL SECURITY;

CREATE POLICY gigs_visible_to_parties ON gigs
    FOR SELECT
    USING (
        host_id = current_setting('app.current_user_id', TRUE)::uuid
        OR state IN ('Open', 'ApplicationsReview')
        OR EXISTS (
            SELECT 1 FROM applications a
            WHERE a.gig_id = gigs.id
              AND a.vendor_id = current_setting('app.current_user_id', TRUE)::uuid
        )
    );

CREATE POLICY escrows_visible_to_parties ON escrows
    FOR SELECT
    USING (
        host_id   = current_setting('app.current_user_id', TRUE)::uuid
        OR vendor_id = current_setting('app.current_user_id', TRUE)::uuid
    );

CREATE POLICY reviews_are_public ON reviews FOR SELECT USING (TRUE);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER gigs_touch         BEFORE UPDATE ON gigs         FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER escrows_touch      BEFORE UPDATE ON escrows      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER applications_touch BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The ledger is append-only, enforced rather than merely intended.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only; correct by writing a compensating entry';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER transitions_no_update BEFORE UPDATE ON gig_transitions
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

COMMIT;
