/**
 * The application role's privileges.
 *
 * Row-level security is bypassed by the table owner, so every policy in
 * 001_init.sql protects nothing unless the service connects as a role that does
 * not own the schema. 003_app_role.sql creates that role; this checks it grants
 * what it should and withholds what it should.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "../src/infra/postgres/db.js";
import { createTestSchema, migration, skipWithoutDatabase } from "./db.js";

const skip = skipWithoutDatabase;
let db: Database;

before(async () => {
  if (skip) return;
  db = await createTestSchema("test_privs");
  await db.query(migration("003_app_role.sql"));
});

after(async () => {
  if (db) await db.close();
});

/** Ask PostgreSQL directly, rather than inferring from the migration text. */
async function may(action: string, table: string): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(
    `SELECT has_table_privilege('desi_nexus_app', $1, $2) AS ok`,
    [table, action],
  );
  return rows[0]?.ok ?? false;
}

test("the application role exists after the migration", { skip }, async () => {
  const rows = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'desi_nexus_app'`);
  assert.equal(rows.length, 1);
});

test("the role does not own the tables, so RLS actually binds it", { skip }, async () => {
  const rows = await db.query<{ owner: string }>(
    `SELECT tableowner AS owner FROM pg_tables
     WHERE schemaname = 'test_privs' AND tablename = 'gigs'`,
  );
  assert.notEqual(rows[0]?.owner, undefined, "the migration should have created gigs");
  assert.notEqual(rows[0]?.owner, "desi_nexus_app", "the app role must not own the tables it reads");
});

test("the role can read and write the operational tables", { skip }, async () => {
  for (const table of ["test_privs.users", "test_privs.gigs", "test_privs.escrows", "test_privs.applications"]) {
    assert.ok(await may("SELECT", table), `${table} should be readable`);
    assert.ok(await may("INSERT", table), `${table} should be insertable`);
  }
});

test("the role can never delete a user, a gig, a booking or a ledger row", { skip }, async () => {
  for (const table of [
    "test_privs.users",
    "test_privs.gigs",
    "test_privs.escrows",
    "test_privs.applications",
    "test_privs.ledger_entries",
    "test_privs.gig_transitions",
  ]) {
    assert.equal(await may("DELETE", table), false, `${table} must not be deletable by the service`);
  }
});

test("the append-only tables are insert-only for the service", { skip }, async () => {
  for (const table of ["test_privs.ledger_entries", "test_privs.gig_transitions"]) {
    assert.ok(await may("INSERT", table), `${table} should be insertable`);
    assert.equal(await may("UPDATE", table), false, `${table} must not be updatable`);
  }
});

test("reference data is read-only to the service; it changes by migration", { skip }, async () => {
  for (const table of ["test_privs.event_types", "test_privs.crew_specialties", "test_privs.cultural_tags", "test_privs.metros"]) {
    assert.ok(await may("SELECT", table), `${table} should be readable`);
    assert.equal(await may("INSERT", table), false, `${table} must not be writable at runtime`);
    assert.equal(await may("UPDATE", table), false, `${table} must not be writable at runtime`);
  }
});

test("join tables the service rewrites are deletable, because a set is replaced", { skip }, async () => {
  for (const table of [
    "test_privs.crew_specialty_links",
    "test_privs.crew_cultural_tags",
    "test_privs.gig_cultural_tags",
    "test_privs.gig_languages",
  ]) {
    assert.ok(await may("DELETE", table), `${table} must be replaceable`);
  }
});
