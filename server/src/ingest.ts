import { createHash } from 'node:crypto';
import {
  KEY_PATTERN,
  MAX_BATCH_POINTS,
  MAX_STEP,
  UUID_PATTERN,
  decodeValue,
  encodeValue,
  sameValue,
  type BatchResult,
  type Point,
} from '@simmer/sdk';
import type { Tx } from './db.ts';
import { HttpError, invalid, notFound } from './errors.ts';

export interface ParsedBatch {
  batchId: string;
  points: Point[];
  /** Hash of the point set, independent of the order points were listed in. */
  hash: Buffer;
}

export function parseBatch(body: unknown): ParsedBatch {
  if (typeof body !== 'object' || body === null) throw invalid('The body must be a JSON object.');
  const { batch_id: batchId, points: raw } = body as Record<string, unknown>;
  if (typeof batchId !== 'string' || !UUID_PATTERN.test(batchId)) {
    throw invalid('batch_id must be a UUID chosen by the client and reused on every retry.');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('points must be a non-empty array.');
  if (raw.length > MAX_BATCH_POINTS) {
    throw invalid(`A batch holds at most ${MAX_BATCH_POINTS} points.`, { max: MAX_BATCH_POINTS });
  }

  const seen = new Map<string, number>();
  const points: Point[] = [];
  raw.forEach((item: unknown, index: number) => {
    const fail = (problem: string) => invalid(`points[${index}]: ${problem}`, { index });
    if (typeof item !== 'object' || item === null) throw fail('must be an object.');
    const { key, step, value: wire } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw fail('key must be 1 to 128 characters from A-Z a-z 0-9 _ . - /');
    }
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > MAX_STEP) {
      throw fail('step must be a non-negative integer.');
    }
    const value = decodeValue(wire);
    if (value === undefined) {
      throw fail('value must be a number, or the string "NaN", "Infinity" or "-Infinity".');
    }
    const id = `${key}\n${step}`;
    const earlier = seen.get(id);
    if (earlier === undefined) {
      seen.set(id, value);
      points.push({ key, step, value });
    } else if (!sameValue(earlier, value)) {
      throw fail(`${key} at step ${step} appears twice in this batch with different values.`);
    }
  });

  const canonical = [...points]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.step - b.step))
    .map((p) => [p.key, p.step, encodeValue(p.value === 0 ? 0 : p.value)]);
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest();
  return { batchId: batchId.toLowerCase(), points, hash };
}

export interface IngestHooks {
  /** Test-only fault injection, called after all writes and before commit. */
  beforeCommit?: () => Promise<void>;
}

/**
 * Stores one batch inside the caller's transaction. Either every effect below
 * commits or none does: the points, the batch record, the run counters and the
 * notification that wakes streams.
 */
export async function storeBatch(
  tx: Tx,
  projectId: string,
  runId: string,
  batch: ParsedBatch,
  hooks: IngestHooks = {},
): Promise<BatchResult> {
  // Locks the run row. Batches for one run are stored one after another, which
  // is what makes seq order equal commit order. Other runs are not affected.
  // Row-level security makes another project's run look like no run at all.
  const run = await tx.query('select last_seq from runs where id = $1 for update', [runId]);
  if (run.rowCount === 0) throw notFound();

  const earlier = await tx.query(
    'select payload_hash, result from batches where run_id = $1 and batch_id = $2',
    [runId, batch.batchId],
  );
  if (earlier.rowCount) {
    const stored = earlier.rows[0];
    if (!batch.hash.equals(stored.payload_hash)) {
      throw new HttpError(
        409,
        'batch_id_reused',
        'This batch_id was already used for different points. Use a new batch_id for new data.',
      );
    }
    return { ...(stored.result as Omit<BatchResult, 'replayed'>), replayed: true };
  }

  const seq = Number(run.rows[0].last_seq) + 1;
  const keys = batch.points.map((p) => p.key);
  const steps = batch.points.map((p) => p.step);
  const values = batch.points.map((p) => p.value);

  const inserted = await tx.query(
    `insert into points (run_id, project_id, key, step, value, seq)
     select $1, $2, t.key, t.step, t.value, $3
     from unnest($4::text[], $5::bigint[], $6::float8[]) as t (key, step, value)
     on conflict (run_id, key, step) do nothing
     returning key, step`,
    [runId, projectId, seq, keys, steps, values],
  );
  const accepted = inserted.rowCount ?? 0;

  // Points that were already stored are either harmless repeats (same value)
  // or conflicts (different value). The stored value always stays.
  let duplicates = 0;
  const conflicts: { key: string; step: number }[] = [];
  if (accepted < batch.points.length) {
    const fresh = new Set(inserted.rows.map((r) => `${r.key}\n${r.step}`));
    const rest = batch.points.filter((p) => !fresh.has(`${p.key}\n${p.step}`));
    const existing = await tx.query(
      `select p.key, p.step, p.value from points p
       join unnest($2::text[], $3::bigint[]) as t (key, step)
         on p.key = t.key and p.step = t.step
       where p.run_id = $1`,
      [runId, rest.map((p) => p.key), rest.map((p) => p.step)],
    );
    const stored = new Map<string, number>(
      existing.rows.map((r) => [`${r.key}\n${r.step}`, r.value as number]),
    );
    for (const point of rest) {
      const current = stored.get(`${point.key}\n${point.step}`);
      if (current !== undefined && sameValue(current, point.value)) duplicates++;
      else conflicts.push({ key: point.key, step: point.step });
    }
  }

  const result: Omit<BatchResult, 'replayed'> = {
    batch_id: batch.batchId,
    seq: accepted > 0 ? seq : null,
    accepted,
    duplicates,
    conflicts,
  };

  if (accepted > 0) {
    await tx.query(
      `update runs set last_seq = $2, point_count = point_count + $3,
         conflict_count = conflict_count + $4, updated_at = now()
       where id = $1`,
      [runId, seq, accepted, conflicts.length],
    );
    // Delivered to listeners only if and when this transaction commits.
    await tx.query("select pg_notify('run_seq', $1)", [`${runId}:${seq}`]);
  } else if (conflicts.length > 0) {
    await tx.query('update runs set conflict_count = conflict_count + $2 where id = $1', [
      runId,
      conflicts.length,
    ]);
  }

  await tx.query(
    'insert into batches (run_id, project_id, batch_id, payload_hash, result) values ($1, $2, $3, $4, $5)',
    [runId, projectId, batch.batchId, batch.hash, JSON.stringify(result)],
  );

  await hooks.beforeCommit?.();
  return { ...result, replayed: false };
}
