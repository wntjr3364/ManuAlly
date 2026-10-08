import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '@pw/domain/shared/db.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export interface SessionInfo { ownerId: string; username: string; csrfHash: string; tokenHash: string }

export async function createSession(db: Queryable, ownerId: string, ttlMs: number): Promise<{ token: string; csrfToken: string }> {
  const t = token();
  const csrf = token();
  await db.query('INSERT INTO sessions (token_hash, owner_id, csrf_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || \' milliseconds\')::interval)', [sha256(t), ownerId, sha256(csrf), String(ttlMs)]);
  return { token: t, csrfToken: csrf };
}

export async function lookupSession(db: Queryable, t: string | undefined): Promise<SessionInfo | null> {
  if (!t || t.length > 200) return null;
  const { rows } = await db.query<{ owner_id: string; username: string; csrf_hash: string; token_hash: string }>(
    `SELECT s.owner_id, o.username, s.csrf_hash, s.token_hash FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(t)],
  );
  const r = rows[0];
  return r ? { ownerId: r.owner_id, username: r.username, csrfHash: r.csrf_hash, tokenHash: r.token_hash } : null;
}

export async function rotateCsrf(db: Queryable, tokenHash: string): Promise<string> {
  const csrf = token();
  await db.query('UPDATE sessions SET csrf_hash = $2 WHERE token_hash = $1', [tokenHash, sha256(csrf)]);
  return csrf;
}

export async function revokeSession(db: Queryable, tokenHash: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [tokenHash]);
}

export const csrfMatches = (header: unknown, csrfHash: string) => typeof header === 'string' && header.length <= 200 && sha256(header) === csrfHash;
