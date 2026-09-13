/**
 * The database handle.
 *
 * Two things here are load-bearing rather than ceremony:
 *
 * 1. `withTransaction` gives the repositories a unit of work. A gig and its
 *    cultural tags, or an escrow and its first ledger entry, must land together
 *    or not at all -- a gig that exists with none of its tags is a gig that
 *    silently matches nobody.
 *
 * 2. `asUser` sets the `app.current_user_id` GUC the row-level security
 *    policies read. It is set per transaction with `set_config(..., true)`, so
 *    it is scoped to that transaction and cannot leak to the next borrower of a
 *    pooled connection. A GUC left set on a returned connection is how one
 *    tenant ends up reading another's rows.
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** A view of this database whose statements run as `userId` for RLS. */
  asUser(userId: string | undefined): Database;
  close(): Promise<void>;
}

/** Set once per transaction; `true` makes it local to that transaction. */
const SET_USER = "SELECT set_config('app.current_user_id', $1, true)";

class PgDatabase implements Database {
  constructor(
    private readonly pool: Pool,
    private readonly client: PoolClient | undefined,
    private readonly userId: string | undefined,
  ) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    if (this.client) {
      const result = await this.client.query<T>(text, params as unknown[]);
      return result.rows;
    }
    // Outside a transaction the GUC still has to be scoped to this one
    // statement, which means borrowing a connection and wrapping it.
    if (this.userId !== undefined) {
      return this.withTransaction((tx) => tx.query<T>(text, params));
    }
    const result = await this.pool.query<T>(text, params as unknown[]);
    return result.rows;
  }

  async withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    // Already inside one: join it rather than opening a nested transaction,
    // so an inner failure rolls the whole unit of work back.
    if (this.client) return fn(this);

    const client = await this.pool.connect();
    const tx = new PgDatabase(this.pool, client, this.userId);
    try {
      await client.query("BEGIN");
      if (this.userId !== undefined) await client.query(SET_USER, [this.userId]);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback that fails means the connection is already broken; the
        // original error is the one worth surfacing.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  asUser(userId: string | undefined): Database {
    if (userId === this.userId) return this;
    if (this.client) {
      throw new Error("cannot change the acting user inside an open transaction");
    }
    return new PgDatabase(this.pool, undefined, userId);
  }

  async close(): Promise<void> {
    if (this.client) throw new Error("cannot close the pool from inside a transaction");
    await this.pool.end();
  }
}

export interface ConnectOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  /**
   * Schemas to resolve unqualified names against. Deployments that keep the
   * application's tables out of `public` set this; so do the tests, which give
   * each file its own schema so they can run in parallel without truncating
   * each other's rows.
   */
  readonly searchPath?: readonly string[];
}

export function connect(options: ConnectOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.searchPath?.length
      ? { options: `-c search_path=${options.searchPath.join(",")}` }
      : {}),
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    // A query that has run for 15 seconds on this service is a bug, and left
    // alone it holds a pooled connection that healthy requests need.
    statement_timeout: options.statementTimeoutMillis ?? 15_000,
  });
  // An idle-client error (server restart, network drop) is emitted on the pool
  // and would otherwise be an unhandled 'error' event, which ends the process.
  pool.on("error", (error) => {
    console.error("idle postgres client error", error);
  });
  return new PgDatabase(pool, undefined, undefined);
}

/** Postgres unique-violation, so a duplicate can be reported rather than thrown. */
export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";
export const FOREIGN_KEY_VIOLATION = "23503";

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}
