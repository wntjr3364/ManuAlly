// Session bindings (PW-024, table agent_sessions): which native session a paper's work thread uses.
// Found only for the same paper, thread, provider version and auth profile; never "the latest".
import { UUID_RE } from './args.ts';

interface Q { query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }
export interface BindingKey { paperId: string; workThread: string; provider: 'claude_agent' | 'codex'; providerVersion: string; authProfileId: string }
export interface SessionBinding { id: string; paper_id: string; work_thread: string; provider: string; provider_version: string; auth_profile_id: string; native_session_id: string; run_state_dir: string; cwd: string; capability_snapshot: Record<string, unknown>; created_at: string }

export async function recordSessionBinding(db: Q, b: BindingKey & { nativeSessionId: string; runStateDir: string; cwd: string; capabilitySnapshot: Record<string, unknown> }): Promise<SessionBinding> {
  if (!UUID_RE.test(b.nativeSessionId)) throw new Error('native session id must be a uuid');
  const { rows } = await db.query<SessionBinding>(
    `INSERT INTO agent_sessions (paper_id, work_thread, provider, provider_version, auth_profile_id, native_session_id, run_state_dir, cwd, capability_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [b.paperId, b.workThread, b.provider, b.providerVersion, b.authProfileId, b.nativeSessionId.toLowerCase(), b.runStateDir, b.cwd, JSON.stringify(b.capabilitySnapshot)],
  );
  return rows[0]!;
}

export async function findSessionBinding(db: Q, k: BindingKey): Promise<SessionBinding | null> {
  const { rows } = await db.query<SessionBinding>(
    `SELECT * FROM agent_sessions WHERE paper_id = $1 AND work_thread = $2 AND provider = $3 AND provider_version = $4 AND auth_profile_id = $5
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [k.paperId, k.workThread, k.provider, k.providerVersion, k.authProfileId],
  );
  return rows[0] ?? null;
}
