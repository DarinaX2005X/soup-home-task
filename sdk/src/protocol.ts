// Wire protocol shared by the server, the web app and the tests.

export const MAX_BATCH_POINTS = 1000;
export const MAX_STEP = Number.MAX_SAFE_INTEGER;
export const KEY_PATTERN = /^[A-Za-z0-9_.\-/]{1,128}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// JSON has no NaN or Infinity, and a diverging loss is exactly when a tracker
// must not lose data. Those three values travel as strings.
export type WireValue = number | 'NaN' | 'Infinity' | '-Infinity';

export interface Point {
  key: string;
  step: number;
  value: number;
}

export type WirePoint = [key: string, step: number, value: WireValue];

export function encodeValue(value: number): WireValue {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return value;
}

export function decodeValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  return undefined;
}

/** Equality used for "is this the same point value": NaN equals NaN, 0 equals -0. */
export function sameValue(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

export interface BatchRequest {
  batch_id: string;
  points: { key: string; step: number; value: WireValue }[];
}

export interface BatchResult {
  batch_id: string;
  /** The seq this batch was stored under, or null when it added no new point. */
  seq: number | null;
  accepted: number;
  duplicates: number;
  conflicts: { key: string; step: number }[];
  /** True when this exact batch had been stored before and the first answer is returned. */
  replayed: boolean;
}

export type RunStatus = 'running' | 'finished' | 'failed';

export interface Run {
  id: string;
  name: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  head: number;
  points: number;
  conflicts: number;
}

/** `event: points`. Continues from cursor `from` and leaves the reader at cursor `to`. */
export interface PointsMessage {
  from: number;
  to: number;
  points: WirePoint[];
}

/** `event: run`. A full state, so a missed one is simply replaced by the next. */
export interface RunStateMessage {
  status: RunStatus;
  head: number;
  points: number;
  conflicts: number;
  finished_at: string | null;
}

/** `event: bye`. The server is ending the stream on purpose. */
export interface ByeMessage {
  reason: 'key_revoked' | 'run_gone' | 'shutdown' | 'stalled';
}

export interface MetricsPage {
  from: number;
  to: number;
  head: number;
  has_more: boolean;
  points: WirePoint[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function uuidv4(): string {
  const b = new Uint8Array(16);
  // randomUUID needs a secure context in browsers, getRandomValues does not.
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
