import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { unauthorized } from './errors.ts';

export interface Auth {
  keyId: string;
  projectId: string;
}

const KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;

// Keys are 256 random bits, so a plain SHA-256 is enough: there is nothing to
// brute-force, and the lookup is by the full hash, which gives a caller no
// byte-by-byte comparison to time.
export function hashKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function generateKey(): { secret: string; hash: Buffer; prefix: string } {
  const secret = `sk_${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashKey(secret), prefix: secret.slice(0, 9) };
}

/**
 * Resolves the Authorization header to a project. The database is asked on
 * every request and nothing is cached, so a revoked key stops working with the
 * transaction that revokes it.
 */
export async function authenticate(db: Db, header: string | undefined): Promise<Auth> {
  const match = header?.match(/^Bearer (.+)$/);
  const secret = match?.[1];
  if (!secret || !KEY_PATTERN.test(secret)) throw unauthorized();
  const found = await db.query('select key_id, project_id from auth_lookup($1)', [hashKey(secret)]);
  const row = found.rows[0];
  if (!row) throw unauthorized();
  return { keyId: row.key_id, projectId: row.project_id };
}
