// Where the system under test lives. Defaults match the test compose stack
// when the tests are run from the host.
export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
/** A second API instance on the same database, when the stack has one. */
export const API2_URL = process.env.API2_URL;
export const WEB_URL = process.env.WEB_URL ?? 'http://localhost:8080';
export const OWNER_DATABASE_URL =
  process.env.OWNER_DATABASE_URL ?? 'postgres://simmer_owner:owner-local-only@localhost:54329/simmer';
export const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://simmer_app:app-local-only@localhost:54329/simmer';
export const API_LOG_FILE = process.env.API_LOG_FILE;
export const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
/** The crash test kills the API process and needs something to restart it. */
export const CAN_CRASH_API = process.env.CAN_CRASH_API === '1';
