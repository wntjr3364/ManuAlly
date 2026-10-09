// PW-024 — session bindings: the native session id is stored per paper and work thread, scoped to
// the owner's paper, and resumed only for the same provider version and auth profile (spec 07
// "세션 식별": no "latest session" or folder-based resume).
import { afterAll, beforeAll, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { findSessionBinding, recordSessionBinding } from '../../../packages/providers/src/claude/index.ts';

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let paperA: string;
let paperB: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  const owner = await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
  const mk = async () => (await pool.query("INSERT INTO paper_projects (owner_id, working_title, article_type) VALUES ($1, 'p', 'research_article') RETURNING id", [owner.id])).rows[0].id as string;
  paperA = await mk();
  paperB = await mk();
});
afterAll(async () => { await pool?.end(); await db?.drop(); });

const binding = (paperId: string, over: Record<string, unknown> = {}) => ({
  paperId, workThread: 'selection-chat', provider: 'claude_agent' as const, providerVersion: 'claude-code 2.1.294', authProfileId: 'profile-1',
  nativeSessionId: randomUUID(), runStateDir: '/runs/x', cwd: '/runs/x/work', capabilitySnapshot: { admission: 'approved' }, ...over,
});

test('the stored id is found only for the same paper, thread, provider version and auth profile', async () => {
  const b = binding(paperA);
  await recordSessionBinding(pool, b);
  const key = { paperId: paperA, workThread: 'selection-chat', provider: 'claude_agent' as const, providerVersion: 'claude-code 2.1.294', authProfileId: 'profile-1' };
  expect((await findSessionBinding(pool, key))?.native_session_id).toBe(b.nativeSessionId);
  expect(await findSessionBinding(pool, { ...key, paperId: paperB })).toBeNull();
  expect(await findSessionBinding(pool, { ...key, workThread: 'other' })).toBeNull();
  expect(await findSessionBinding(pool, { ...key, providerVersion: 'claude-code 2.2.0' })).toBeNull();
  expect(await findSessionBinding(pool, { ...key, authProfileId: 'profile-2' })).toBeNull();
});

test('a newer binding of the same thread wins; bindings are immutable and ids are unique per provider', async () => {
  const k = { paperId: paperA, workThread: 'outline', provider: 'claude_agent' as const, providerVersion: 'claude-code 2.1.294', authProfileId: 'profile-1' };
  const first = binding(paperA, { workThread: 'outline' });
  await recordSessionBinding(pool, first);
  const second = binding(paperA, { workThread: 'outline' });
  await recordSessionBinding(pool, second);
  expect((await findSessionBinding(pool, k))?.native_session_id).toBe(second.nativeSessionId);
  await expect(recordSessionBinding(pool, { ...binding(paperB), nativeSessionId: second.nativeSessionId })).rejects.toThrow();
  await expect(pool.query("UPDATE agent_sessions SET native_session_id = 'x'")).rejects.toThrow(/immutable/);
  await expect(recordSessionBinding(pool, binding(paperA, { nativeSessionId: 'not-a-uuid' }))).rejects.toThrow(/uuid/);
});
