function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: int('PORT', 3000),
  /** Connection of the unprivileged application role. */
  databaseUrl: required('DATABASE_URL'),
  /** Owner connection, used once at start to migrate. */
  migrateUrl: required('MIGRATE_DATABASE_URL'),
  appDbPassword: required('APP_DB_PASSWORD'),
  poolMax: int('DB_POOL_MAX', 20),
  /** How often a stream re-reads the run state and re-checks its key. */
  heartbeatMs: int('HEARTBEAT_MS', 5000),
  /** A stream whose socket has not drained for this long is closed. */
  stallMs: int('STREAM_STALL_MS', 30_000),
  streamPageRows: int('STREAM_PAGE_ROWS', 5000),
  maxStreamsPerProject: int('MAX_STREAMS_PER_PROJECT', 200),
  bodyLimit: int('BODY_LIMIT_BYTES', 1_048_576),
  /** Requests waiting for a database connection beyond this are refused with 503. */
  maxQueuedForDb: int('MAX_QUEUED_FOR_DB', 400),
  /**
   * Requests one project may have in progress at once. Below the pool size on
   * purpose: one project cannot occupy every database connection.
   */
  maxInFlightPerProject: int('MAX_IN_FLIGHT_PER_PROJECT', 12),
  /**
   * Host name of the reverse proxy whose X-Forwarded-For is believed. Anyone
   * else's is ignored, so a caller that reaches the API directly cannot pick
   * the address it is rate-limited under.
   */
  trustedProxyHost: process.env.TRUSTED_PROXY_HOST || undefined,
  maxActiveKeys: int('MAX_ACTIVE_KEYS', 20),
  /** If set, creating a project needs this value in the x-signup-token header. */
  signupToken: process.env.SIGNUP_TOKEN || undefined,
  /** Projects one address may create per hour. */
  signupsPerHour: int('SIGNUPS_PER_HOUR', 30),
  logFile: process.env.LOG_FILE || undefined,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Fault injection and process stats for the test suite. Off unless set to 1. */
  testHooks: process.env.TEST_HOOKS === '1',
};

export type Config = typeof config;
