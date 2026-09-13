-- The role the service connects as.
--
-- This matters more than it looks. Row-level security is bypassed by the table
-- owner, so the policies in 001_init.sql protect nothing if the application
-- connects as the role that owns the schema. Deployments must use this role.
--
-- No password is set here on purpose: it is issued out of band by the secrets
-- manager and rotated there. Run this as the schema owner after 001 and 002.
--
-- Every statement is applied to current_schema() rather than to a hardcoded
-- `public`. 001_init.sql creates its tables unqualified, so it builds into
-- whichever schema is current; if this file named `public` directly then a
-- deployment (or a test) that puts the tables elsewhere would silently grant
-- against one schema and revoke against another, leaving the append-only
-- tables writable.

BEGIN;

DO $$
DECLARE
    target text := current_schema();
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desi_nexus_app') THEN
        CREATE ROLE desi_nexus_app LOGIN;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO desi_nexus_app', target);

    -- Read and write the operational tables.
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO desi_nexus_app', target);
    EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO desi_nexus_app', target);

    -- The service never deletes a user, a gig, a booking or a ledger row.
    -- Records are cancelled, suspended or compensated; nothing is erased.
    -- Withholding DELETE entirely means a bug cannot erase history either.
    EXECUTE format(
        'REVOKE DELETE ON ALL TABLES IN SCHEMA %I FROM desi_nexus_app', target);

    -- Except where a row genuinely is a replaceable set member rather than a
    -- record: the join tables a profile or a brief rewrites wholesale.
    EXECUTE format(
        'GRANT DELETE ON %I.crew_specialty_links, %I.crew_cultural_tags,
                         %I.vendor_unavailability, %I.gig_cultural_tags,
                         %I.gig_languages, %I.portfolio_assets
         TO desi_nexus_app',
        target, target, target, target, target, target);

    -- Reference data is read-only to the application; it changes by migration.
    EXECUTE format(
        'REVOKE INSERT, UPDATE ON %I.event_types, %I.crew_specialties,
                                  %I.cultural_tags, %I.cultural_tag_affinity,
                                  %I.metros, %I.languages
         FROM desi_nexus_app',
        target, target, target, target, target, target);

    -- The append-only tables are insert-only for the application. The triggers
    -- in 001_init.sql already refuse updates, but withholding the grant means
    -- the attempt is refused before it ever reaches a trigger.
    EXECUTE format(
        'REVOKE UPDATE ON %I.ledger_entries, %I.gig_transitions FROM desi_nexus_app',
        target, target);

    -- Tables added by later migrations default to the same posture.
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I
         GRANT SELECT, INSERT, UPDATE ON TABLES TO desi_nexus_app', target);
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I
         GRANT USAGE, SELECT ON SEQUENCES TO desi_nexus_app', target);
END
$$;

COMMIT;
