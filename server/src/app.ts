import { createWriteStream } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { UUID_PATTERN, encodeValue, type MetricsPage, type Run, type WirePoint } from '@simmer/sdk';
import { authenticate, generateKey, type Auth } from './auth.ts';
import type { Config } from './config.ts';
import { assertKeyActive, lockKeyForRevocation, withProject, type Db, type Tx } from './db.ts';
import { HttpError, invalid, notFound, unauthorized } from './errors.ts';
import { Hub } from './hub.ts';
import { parseBatch, storeBatch } from './ingest.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
    released: boolean;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

const RUN_COLUMNS =
  'id, name, status, created_at, updated_at, finished_at, last_seq, point_count, conflict_count';

function toRun(row: Record<string, any>): Run {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    head: Number(row.last_seq),
    points: Number(row.point_count),
    conflicts: Number(row.conflict_count),
  };
}

function toKey(row: Record<string, any>, currentKeyId: string) {
  return {
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    current: row.id === currentKeyId,
  };
}

/** An id that is not even a UUID gets the same answer as one that matches nothing. */
function runIdOf(request: FastifyRequest): string {
  const { id } = request.params as { id: string };
  if (!UUID_PATTERN.test(id)) throw notFound();
  return id.toLowerCase();
}

function text(value: unknown, field: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw invalid(`${field} must be 1 to ${max} characters.`);
  }
  return value.trim();
}

function cursorOf(raw: unknown): number {
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw invalid('The cursor must be a non-negative integer.');
  return value;
}

async function assertRun(tx: Tx, runId: string): Promise<void> {
  const found = await tx.query('select 1 from runs where id = $1', [runId]);
  if (found.rowCount === 0) throw notFound();
}

export async function buildApp(db: Db, config: Config): Promise<{ app: FastifyInstance; hub: Hub }> {
  const file = config.logFile ? createWriteStream(config.logFile, { flags: 'a' }) : undefined;
  // A log file that cannot be written must not take the API down with it.
  file?.on('error', (error) => console.error(`log file: ${error.message}`));
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    genReqId: () => randomUUID(),
    // The API sits behind nginx, which passes the caller's address on.
    trustProxy: true,
    // One log line per request (written below) instead of Fastify's two.
    disableRequestLogging: true,
    logger: {
      level: config.logLevel,
      // The default serializers log method, URL and status. Request headers
      // are not logged at all, and the redaction is a second lock on that.
      redact: ['req.headers.authorization', 'headers.authorization'],
      stream: {
        write(line: string) {
          process.stdout.write(line);
          file?.write(line);
        },
      },
    },
  });
  const hub = new Hub(db, config, app.log);

  app.decorateRequest('auth', null);

  // Under more load than the database pool can serve, requests used to pile up
  // in memory with latency growing without bound. Now the API says so early.
  // Refusing is safe for writers: a retry carries the same batch_id.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.public) return;
    if (db.waitingCount > config.maxQueuedForDb) {
      throw new HttpError(503, 'overloaded', 'The server is overloaded. Retry shortly.');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, url: request.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  // Authentication runs before the body is read or anything about the target
  // is looked at, so nothing an anonymous caller sends can reveal whether an
  // id exists.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.public) return;
    request.auth = await authenticate(db, request.headers.authorization);
    request.log = request.log.child({
      project_id: request.auth.projectId,
      key_id: request.auth.keyId,
    });
  });

  // Fairness between projects. All projects share one database pool, so a
  // project that sends a flood must run out of its own allowance before it
  // runs the pool dry for everyone else. Counted per API process.
  const inFlight = new Map<string, number>();
  const release = (request: FastifyRequest) => {
    const projectId = request.auth?.projectId;
    if (!projectId || request.released) return;
    request.released = true;
    const left = (inFlight.get(projectId) ?? 1) - 1;
    if (left > 0) inFlight.set(projectId, left);
    else inFlight.delete(projectId);
  };
  app.decorateRequest('released', false);
  app.addHook('onRequest', async (request, reply) => {
    const projectId = request.auth?.projectId;
    if (!projectId) return;
    const now = inFlight.get(projectId) ?? 0;
    if (now >= config.maxInFlightPerProject) {
      request.released = true;
      throw new HttpError(429, 'project_busy', 'This project has too many requests in progress. Retry shortly.');
    }
    inFlight.set(projectId, now + 1);
    reply.raw.once('close', () => release(request));
  });

  // Nothing here may be stored by a browser or a proxy and shown to the next
  // caller of the same URL.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.setNotFoundHandler((_request, reply) => {
    const error = notFound();
    reply.status(404).send({ error: { code: error.code, message: error.message } });
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof HttpError) {
      if (error.status === 503 || error.status === 429) reply.header('retry-after', '1');
      reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      // Malformed JSON, body too large, unsupported media type.
      const code = error.statusCode === 413 ? 'body_too_large' : 'bad_request';
      const message =
        error.statusCode === 413
          ? `The body is larger than ${config.bodyLimit} bytes.`
          : 'The request could not be read.';
      reply.status(error.statusCode).send({ error: { code, message } });
      return;
    }
    // The cause goes to the log. The caller only gets the request id to quote.
    request.log.error({ err: error }, 'request failed');
    reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong on the server.', details: { request_id: request.id } },
    });
  });

  const auth = (request: FastifyRequest): Auth => {
    if (!request.auth) throw unauthorized();
    return request.auth;
  };

  app.get('/healthz', { config: { public: true } }, async () => {
    await db.query('select 1');
    return { ok: true };
  });

  // Projects and keys

  // What the sign-in screen needs to know before anyone has a key.
  app.get('/config', { config: { public: true } }, async () => ({
    signup: config.signupToken ? 'token' : 'open',
  }));

  const signups = new Map<string, number[]>();
  const sameSecret = (a: string, b: string) =>
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

  app.post('/projects', { config: { public: true } }, async (request, reply) => {
    if (config.signupToken) {
      const given = request.headers['x-signup-token'];
      if (typeof given !== 'string' || !sameSecret(given, config.signupToken)) {
        throw new HttpError(403, 'signup_closed', 'Creating a project on this server needs an invite code.');
      }
    }
    const hourAgo = Date.now() - 3_600_000;
    const recent = (signups.get(request.ip) ?? []).filter((at) => at > hourAgo);
    if (recent.length >= config.signupsPerHour) {
      throw new HttpError(429, 'too_many_projects', 'Too many projects were created from this address. Try again later.');
    }
    signups.set(request.ip, [...recent, Date.now()]);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = text(body.name, 'name', 80);
    const projectId = randomUUID();
    const key = generateKey();
    const created = await withProject(db, projectId, async (tx) => {
      const project = await tx.query(
        'insert into projects (id, name) values ($1, $2) returning id, name, created_at',
        [projectId, name],
      );
      const apiKey = await tx.query(
        `insert into api_keys (project_id, key_hash, prefix, label) values ($1, $2, $3, 'First key')
         returning id, prefix, label, created_at, revoked_at`,
        [projectId, key.hash, key.prefix],
      );
      return { project: project.rows[0], apiKey: apiKey.rows[0] };
    });
    reply.status(201);
    return {
      project: {
        id: created.project.id,
        name: created.project.name,
        created_at: created.project.created_at.toISOString(),
      },
      api_key: { ...toKey(created.apiKey, created.apiKey.id), secret: key.secret },
    };
  });

  app.get('/project', async (request) => {
    const { projectId } = auth(request);
    const row = await withProject(db, projectId, async (tx) => {
      return (await tx.query('select id, name, created_at from projects')).rows[0];
    });
    if (!row) throw notFound();
    return { id: row.id, name: row.name, created_at: row.created_at.toISOString() };
  });

  app.get('/keys', async (request) => {
    const { projectId, keyId } = auth(request);
    const rows = await withProject(db, projectId, async (tx) => {
      const found = await tx.query(
        'select id, prefix, label, created_at, revoked_at from api_keys order by created_at desc',
      );
      return found.rows;
    });
    return { keys: rows.map((row) => toKey(row, keyId)) };
  });

  app.post('/keys', async (request, reply) => {
    const { projectId, keyId } = auth(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const label = text(body.label, 'label', 80, 'New key');
    const key = generateKey();
    const row = await withProject(db, projectId, async (tx) => {
      await assertKeyActive(tx, keyId);
      const made = await tx.query(
        `insert into api_keys (project_id, key_hash, prefix, label) values ($1, $2, $3, $4)
         returning id, prefix, label, created_at, revoked_at`,
        [projectId, key.hash, key.prefix, label],
      );
      return made.rows[0];
    }, keyId);
    request.log.info({ new_key_id: row.id }, 'key created');
    reply.status(201);
    return { ...toKey(row, keyId), secret: key.secret };
  });

  /**
   * Locks every active key of the project, in id order, and checks that the
   * caller's own key is still among them. Two revocations therefore run one
   * after the other, and the second sees what the first did: they cannot each
   * leave the other's key as "the one that remains", and a key that was just
   * revoked cannot revoke anything.
   */
  async function lockActiveKeys(tx: Tx, callerKeyId: string): Promise<{ id: string; label: string }[]> {
    const active = await tx.query(
      'select id, label from api_keys where revoked_at is null order by id for update',
    );
    if (!active.rows.some((k) => k.id === callerKeyId)) throw unauthorized();
    return active.rows;
  }

  /** Revokes inside the caller's transaction and tells every instance to drop its streams. */
  async function revoke(tx: Tx, keyId: string): Promise<void> {
    await lockKeyForRevocation(tx, keyId);
    const revoked = await tx.query(
      'update api_keys set revoked_at = now() where id = $1 and revoked_at is null returning id',
      [keyId],
    );
    if (revoked.rowCount === 0) throw notFound();
    await tx.query("select pg_notify('key_revoked', $1)", [keyId]);
  }

  // Rotation is one transaction: the replacement exists exactly when the old
  // key stops. There is no window in which both or neither work.
  app.post('/keys/:id/rotate', async (request, reply) => {
    const { projectId, keyId } = auth(request);
    const targetId = runIdOf(request);
    const key = generateKey();
    const row = await withProject(db, projectId, async (tx) => {
      const active = await lockActiveKeys(tx, keyId);
      const old = active.find((k) => k.id === targetId);
      if (!old) throw notFound();
      await revoke(tx, targetId);
      const made = await tx.query(
        `insert into api_keys (project_id, key_hash, prefix, label) values ($1, $2, $3, $4)
         returning id, prefix, label, created_at, revoked_at`,
        [projectId, key.hash, key.prefix, old.label],
      );
      return made.rows[0];
    });
    request.log.info({ revoked_key_id: targetId, new_key_id: row.id }, 'key rotated');
    reply.status(201);
    // If the caller rotated its own key, the new one is now the current one.
    return { ...toKey(row, targetId === keyId ? row.id : keyId), secret: key.secret };
  });

  app.delete('/keys/:id', async (request, reply) => {
    const { projectId, keyId } = auth(request);
    const targetId = runIdOf(request);
    await withProject(db, projectId, async (tx) => {
      const active = await lockActiveKeys(tx, keyId);
      if (!active.some((k) => k.id === targetId)) throw notFound();
      if (active.length === 1) {
        throw new HttpError(
          409,
          'last_key',
          'This is the only active key. Rotate it instead, or create another key first.',
        );
      }
      await revoke(tx, targetId);
    });
    request.log.info({ revoked_key_id: targetId }, 'key revoked');
    reply.status(204);
  });

  // Runs

  app.post('/runs', async (request, reply) => {
    const { projectId, keyId } = auth(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = randomUUID();
    const name = text(body.name, 'name', 120, `run-${id.slice(0, 8)}`);
    const row = await withProject(db, projectId, async (tx) => {
      await assertKeyActive(tx, keyId);
      const made = await tx.query(
        `insert into runs (id, project_id, name) values ($1, $2, $3) returning ${RUN_COLUMNS}`,
        [id, projectId, name],
      );
      return made.rows[0];
    }, keyId);
    reply.status(201);
    return toRun(row);
  });

  app.get('/runs', async (request) => {
    const { projectId } = auth(request);
    const rows = await withProject(db, projectId, async (tx) => {
      const found = await tx.query(
        `select ${RUN_COLUMNS} from runs order by created_at desc, id limit 200`,
      );
      return found.rows;
    });
    return { runs: rows.map(toRun) };
  });

  app.get('/runs/:id', async (request) => {
    const { projectId } = auth(request);
    const runId = runIdOf(request);
    const row = await withProject(db, projectId, async (tx) => {
      return (await tx.query(`select ${RUN_COLUMNS} from runs where id = $1`, [runId])).rows[0];
    });
    if (!row) throw notFound();
    return toRun(row);
  });

  app.post('/runs/:id/finish', async (request) => {
    const { projectId, keyId } = auth(request);
    const runId = runIdOf(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const status = body.status ?? 'finished';
    const row = await withProject(db, projectId, async (tx) => {
      await assertKeyActive(tx, keyId);
      await assertRun(tx, runId);
      if (status !== 'finished' && status !== 'failed') {
        throw invalid('status must be "finished" or "failed".');
      }
      // Finishing is a label for people. Late batches are still accepted
      // afterwards, because on a bad network "late" is not "wrong".
      const updated = await tx.query(
        `update runs set status = $2, finished_at = coalesce(finished_at, now()), updated_at = now()
         where id = $1 returning ${RUN_COLUMNS}`,
        [runId, status],
      );
      return updated.rows[0];
    }, keyId);
    hub.published(runId, true);
    return toRun(row);
  });

  // Metrics

  app.post('/runs/:id/metrics', async (request) => {
    const { projectId, keyId } = auth(request);
    const runId = runIdOf(request);
    let batch;
    try {
      batch = parseBatch(request.body);
    } catch (error) {
      // Access is decided before validity. Without this, a 422 for a run in
      // another project would confirm that the run exists.
      await withProject(db, projectId, (tx) => assertRun(tx, runId));
      throw error;
    }
    const fault = config.testHooks ? request.headers['x-test-fault'] : undefined;
    // Test-only: hold the request between the key check and the transaction.
    if (typeof fault === 'string' && fault.startsWith('pause:')) {
      await new Promise((resolve) => setTimeout(resolve, Number(fault.slice(6)) || 0));
    }
    const result = await withProject(db, projectId, (tx) =>
      storeBatch(tx, projectId, runId, keyId, batch, {
        beforeCommit: typeof fault === 'string' ? () => injectFault(fault) : undefined,
      }),
      keyId,
    );
    // Only now is the batch committed and visible to the streams' reads.
    if (result.seq !== null && !result.replayed) hub.published(runId);
    return result;
  });

  app.get('/runs/:id/metrics', async (request) => {
    const { projectId } = auth(request);
    const runId = runIdOf(request);
    const query = request.query as Record<string, string | undefined>;
    const page = await withProject(db, projectId, async (tx): Promise<MetricsPage> => {
      const run = await tx.query('select last_seq from runs where id = $1', [runId]);
      if (run.rowCount === 0) throw notFound();
      const after = cursorOf(query.after);
      const limit = Math.min(Math.max(cursorOf(query.limit) || 5000, 1000), 20_000);
      const found = await tx.query(
        'select key, step, value, seq from points where run_id = $1 and seq > $2 order by seq, key, step limit $3',
        [runId, after, limit + 1],
      );
      const rows = found.rows;
      let take = rows.length;
      if (rows.length > limit) {
        const cut = rows[rows.length - 1].seq;
        while (take > 0 && rows[take - 1].seq === cut) take--;
      }
      const points: WirePoint[] = rows
        .slice(0, take)
        .map((r) => [r.key, Number(r.step), encodeValue(r.value)]);
      return {
        from: after,
        to: take > 0 ? Number(rows[take - 1].seq) : after,
        head: Number(run.rows[0].last_seq),
        has_more: rows.length > limit,
        points,
      };
    });
    return page;
  });

  app.get('/runs/:id/events', async (request, reply) => {
    const who = auth(request);
    const runId = runIdOf(request);
    const query = request.query as Record<string, string | undefined>;
    const lastEventId = request.headers['last-event-id'];
    await withProject(db, who.projectId, (tx) => assertRun(tx, runId));
    const cursor = cursorOf(typeof lastEventId === 'string' ? lastEventId : query.after);
    if (hub.streamsFor(who.projectId) >= config.maxStreamsPerProject) {
      throw new HttpError(429, 'too_many_streams', 'This project has too many open live streams.');
    }
    release(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    });
    reply.raw.write(': open\n\n');
    request.log.info({ run_id: runId, cursor }, 'stream opened');
    hub.attach(reply.raw, who, runId, cursor);
  });

  if (config.testHooks) {
    app.log.warn('TEST_HOOKS is on: fault injection and /_test are enabled');
    app.get('/_test/stats', { config: { public: true } }, async () => ({
      rss: process.memoryUsage().rss,
      heap_used: process.memoryUsage().heapUsed,
      streams: hub.size,
      stream_buffered_bytes: hub.bufferedBytes,
      pool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    }));
  }

  return { app, hub };
}

/** Test-only. Each fault fires after every write of the batch and before commit. */
async function injectFault(fault: string): Promise<void> {
  const [kind, arg] = fault.split(':');
  if (kind === 'fail') throw new Error('injected failure before commit');
  if (kind === 'crash') process.exit(86);
  if (kind === 'delay') await new Promise((resolve) => setTimeout(resolve, Number(arg) || 0));
}
