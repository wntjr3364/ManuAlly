import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '@pw/domain/shared/db.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// The CSRF token is derived from the session token, so every tab of one session gets the same
// value and nothing needs rotating. A cross-site attacker cannot read the HttpOnly cookie and
// therefore cannot derive it.
export const csrfFor = (sessionToken: string) => createHmac('sha256', sessionToken).update('pw-csrf-v1').digest('base64url');

export interface SessionInfo { ownerId: string; username: string; tokenHash: string; csrf: string }

export async function createSession(db: Queryable, ownerId: string, ttlMs: number): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = csrfFor(token);
  await db.query("INSERT INTO sessions (token_hash, owner_id, csrf_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)", [sha256(token), ownerId, sha256(csrfToken), String(ttlMs)]);
  return { token, csrfToken };
}

export async function lookupSession(db: Queryable, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await db.query<{ owner_id: string; username: string; token_hash: string }>(
    `SELECT s.owner_id, o.username, s.token_hash FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { ownerId: r.owner_id, username: r.username, tokenHash: r.token_hash, csrf: csrfFor(token) } : null;
}

export async function revokeSession(db: Queryable, tokenHash: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
}

export function csrfMatches(header: unknown, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b); // compare byte lengths: non-ASCII headers must not throw
}
