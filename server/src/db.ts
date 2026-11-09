import pg from 'pg';
import { UUID_PATTERN } from '@simmer/sdk';
import { migrations } from './schema.ts';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max: number): Db {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client that errors (database restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/**
 * Runs `fn` in a transaction that is bound to one project. set_config is
 * transaction-local, so the setting cannot survive into the next request that
 * borrows this connection from the pool. All tenant data access goes through
 * here: row-level security then filters every statement to that project.
 */
export async function withProject<T>(
  db: Db,
  projectId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(projectId)) throw new Error('withProject needs a project id');
  const tx = await db.connect();
  let broken: Error | undefined;
  // The pool only listens for errors on idle clients. If this connection dies
  // while we hold it and no query is in flight, pg emits 'error' on the
  // client, and an unhandled 'error' takes the whole process down.
  const onError = (error: Error) => {
    broken = error;
  };
  tx.on('error', onError);
  try {
    // One round trip instead of two. A multi-statement query cannot take
    // parameters, so the id is checked to be a UUID before it is put in.
    await tx.query(`begin; select set_config('app.project_id', '${projectId}', true)`);
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (error) {
    try {
      await tx.query('rollback');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    tx.off('error', onError);
    tx.release(broken);
  }
}

export async function migrate(ownerUrl: string, appPassword: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Several API instances may start at once. One migrates, the rest wait.
    await client.query('select pg_advisory_lock(727001)');
    const role = await client.query("select 1 from pg_roles where rolname = 'simmer_app'");
    const verb = role.rowCount ? 'alter' : 'create';
    const ddl = await client.query(
      `select format('${verb} role simmer_app login password %L nosuperuser nobypassrls', $1::text) as sql`,
      [appPassword],
    );
    await client.query(ddl.rows[0].sql);
    await client.query(
      'create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query('select id from schema_migrations')).rows.map((r) => r.id as string),
    );
    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      applied.push(migration.id);
    }
  } finally {
    await client.end();
  }
  return applied;
}
