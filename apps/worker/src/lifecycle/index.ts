// Run lifecycle (PW-028, spec 07 "취소·소유권"): stop, interrupt, narrow termination, reconciliation.
// - The cancel is stored first (cancelJob, by the user's request). A supervisor watches the job row:
//   when the run's lease is no longer current (cancelled, or taken over after expiry), it asks the
//   provider to interrupt, waits a grace period, then ends only the run's own process group:
//   SIGTERM, then SIGKILL.
// - A process group is ended only when the live process still is the recorded run: same start time
//   (a reused pid is not ours) and the run's random marker in its environment. Nothing is ended by
//   process name or broadly.
// - After a worker restart, reconcileRunProcesses ends left-over runs of finished or orphaned jobs
//   on this host under the same identity check, and records what it found.
// - Late answers: the run's events and completion are fenced by the job (PW-013/020); a stopped run
//   cannot append events or apply anything.
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TxPool } from '@pw/domain/shared/db.ts';

export const MARKER_ENV = 'PW_RUN_MARKER';
export interface RunProcessRecord { id: string; job_id: string; fencing_token: number; host: string; pid: number; pgid: number; proc_start_ticks: number; marker: string }
export type EndReason = 'exited' | 'interrupted' | 'terminated' | 'killed' | 'reconciled' | 'gone';

// /proc/<pid>/stat: the fields after the command name (which may hold spaces and parentheses)
function statFields(pid: number): string[] | null {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ');
  } catch {
    return null;
  }
}
// field 22 (start time in clock ticks since boot) and field 5 (process group)
export const procStartTicks = (pid: number): number | null => { const f = statFields(pid); return f ? Number(f[19]) : null; };
const procGroup = (pid: number): number | null => { const f = statFields(pid); return f ? Number(f[2]) : null; };
const procState = (pid: number): string | null => statFields(pid)?.[0] ?? null;
function hasMarker(pid: number, marker: string): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`${MARKER_ENV}=${marker}`);
  } catch {
    return false;
  }
}
const isLive = (pid: number) => { const st = procState(pid); return st !== null && st !== 'Z' && st !== 'X'; };

// Is the recorded process the one alive now? (same start time, same group, the run's marker)
export function processMatches(r: RunProcessRecord): boolean {
  return r.host === os.hostname() && isLive(r.pid) && procStartTicks(r.pid) === Number(r.proc_start_ticks) && procGroup(r.pid) === r.pgid && hasMarker(r.pid, r.marker);
}

// Members of the recorded group (the leader may already be gone): processes carrying the run's marker,
// and — while the supervisor that watched the leader is still here (descendants: true) — also those
// that dropped the marker but started after the leader in its group (review MINOR-2). A group id is not
// reused while any member lives, so such a process descends from the run.
function groupMembers(r: RunProcessRecord, opts: { descendants?: boolean } = {}): number[] {
  const out: number[] = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (procGroup(pid) !== r.pgid || !isLive(pid)) continue;
    if (hasMarker(pid, r.marker) || (opts.descendants && (procStartTicks(pid) ?? -1) >= Number(r.proc_start_ticks))) out.push(pid);
  }
  return out;
}

export async function startRunProcess(pool: TxPool, a: { jobId: string; fencingToken: number; workerId: string; cmd: string; args: string[]; env: Record<string, string>; cwd?: string }): Promise<{ child: ChildProcess; record: RunProcessRecord }> {
  const marker = randomBytes(16).toString('hex');
  // its own process group (detached): ending the run never reaches the worker or other runs
  const child = spawn(a.cmd, a.args, { env: { ...a.env, [MARKER_ENV]: marker }, cwd: a.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const spawned = await new Promise<boolean>((res) => { child.once('spawn', () => res(true)); child.once('error', () => res(false)); });
  if (!spawned || !child.pid) throw new Error(`could not start ${a.cmd}`);
  child.stdin?.on('error', () => {});
  let ticks: number | null = null;
  for (let i = 0; i < 50 && ticks === null; i++) { ticks = procStartTicks(child.pid); if (ticks === null) await new Promise((r) => setTimeout(r, 5)); }
  try {
    // without its start time the run could never be recognised again: do not run it (review nit)
    if (ticks === null) throw new Error('could not read the start time of the run process');
    const { rows } = await pool.query<RunProcessRecord & { fencing_token: string; proc_start_ticks: string }>(
      `INSERT INTO run_processes (job_id, fencing_token, worker_id, host, pid, pgid, proc_start_ticks, marker) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)
       RETURNING id, job_id, fencing_token::text AS fencing_token, host, pid, pgid, proc_start_ticks::text AS proc_start_ticks, marker`,
      [a.jobId, a.fencingToken, a.workerId, os.hostname(), child.pid, ticks, marker]);
    return { child, record: { ...rows[0]!, fencing_token: Number(rows[0]!.fencing_token), proc_start_ticks: Number(rows[0]!.proc_start_ticks) } };
  } catch (e) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } // unrecorded: never leave it running
    throw e;
  }
}

async function markEnded(pool: TxPool, id: string, reason: EndReason): Promise<void> {
  await pool.query('UPDATE run_processes SET ended_at = clock_timestamp(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL', [id, reason]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitGone(r: RunProcessRecord, ms: number, descendants: boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!groupMembers(r, { descendants }).length) return true;
    await sleep(20);
  }
  return !groupMembers(r, { descendants }).length;
}

// Ends the run's process group: SIGTERM, a grace period, then SIGKILL — only while it is still the run.
export async function terminateRunGroup(pool: TxPool, r: RunProcessRecord, opts: { graceMs: number; reason?: (e: 'terminated' | 'killed') => EndReason; descendants?: boolean }): Promise<EndReason> {
  const descendants = opts.descendants ?? false;
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    // the identity check is repeated right before every signal
    if (r.host !== os.hostname() || !groupMembers(r, { descendants }).length) return false;
    try { process.kill(-r.pgid, sig); return true; } catch { return false; }
  };
  if (!signalGroup('SIGTERM')) {
    await markEnded(pool, r.id, 'gone');
    return 'gone';
  }
  let end: 'terminated' | 'killed' = 'terminated';
  if (!(await waitGone(r, opts.graceMs, descendants))) {
    end = 'killed';
    signalGroup('SIGKILL');
    await waitGone(r, 2000, descendants);
  }
  const reason = opts.reason?.(end) ?? end;
  await markEnded(pool, r.id, reason);
  return reason;
}

// Watches the job row: aborts when the run's fencing token is no longer the running one. A database
// that stays unreachable (maxFailures reads in a row) also stops the run: a cancel could not be seen.
export function watchJob(pool: TxPool, a: { jobId: string; fencingToken: number; pollMs: number; maxFailures?: number }): { signal: AbortSignal; stop(): void } {
  const ac = new AbortController();
  let stopped = false;
  let failures = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const { rows } = await pool.query<{ status: string; fencing_token: string }>('SELECT status, fencing_token::text AS fencing_token FROM jobs WHERE id = $1', [a.jobId]);
      failures = 0;
      const j = rows[0];
      if (!j || j.status === 'CANCELLED') ac.abort('cancelled');
      else if (j.status !== 'RUNNING' || j.fencing_token !== String(a.fencingToken)) ac.abort('lease_lost');
    } catch {
      // a database hiccup is not a cancel; a long outage is not a reason to run unsupervised
      if (++failures >= (a.maxFailures ?? 20)) ac.abort('db_unreachable');
    }
    if (!ac.signal.aborted && !stopped) timer = setTimeout(tick, a.pollMs);
  };
  let timer = setTimeout(tick, a.pollMs);
  return { signal: ac.signal, stop() { stopped = true; clearTimeout(timer); } };
}

export interface SuperviseResult { reason: 'exited' | 'cancelled' | 'lease_lost' | 'db_unreachable'; end: EndReason }

// Runs until the process exits or the job says stop. Stop: provider interrupt → grace → group end.
export async function superviseRun(pool: TxPool, a: {
  jobId: string; fencingToken: number; record: RunProcessRecord; child: ChildProcess;
  interrupt?: () => Promise<void> | void; pollMs?: number; interruptGraceMs?: number; killGraceMs?: number;
}): Promise<SuperviseResult> {
  const exited = new Promise<void>((res) => {
    if (a.child.exitCode !== null || a.child.signalCode !== null) res();
    else a.child.once('exit', () => res());
  });
  const watch = watchJob(pool, { jobId: a.jobId, fencingToken: a.fencingToken, pollMs: a.pollMs ?? 500 });
  const aborted = new Promise<void>((res) => { if (watch.signal.aborted) res(); else watch.signal.addEventListener('abort', () => res(), { once: true }); });
  await Promise.race([exited, aborted]);
  watch.stop();
  if (!watch.signal.aborted) {
    // the run ended by itself: whatever it left in its group (with its marker) is ended too
    const rest = groupMembers(a.record, { descendants: true }).length ? await terminateRunGroup(pool, a.record, { graceMs: a.killGraceMs ?? 2000, reason: () => 'exited', descendants: true }) : null;
    if (!rest) await markEnded(pool, a.record.id, 'exited');
    return { reason: 'exited', end: 'exited' };
  }
  const reason = watch.signal.reason as 'cancelled' | 'lease_lost' | 'db_unreachable';
  // 1. ask the provider to stop (Codex turn/interrupt, Claude cancel …), bounded
  try { await Promise.race([Promise.resolve(a.interrupt?.()), sleep(a.interruptGraceMs ?? 5000)]); } catch { /* the group end follows */ }
  const settled = await Promise.race([exited.then(() => true), sleep(a.interruptGraceMs ?? 5000).then(() => false)]);
  if (settled) {
    const rest = groupMembers(a.record, { descendants: true }).length ? await terminateRunGroup(pool, a.record, { graceMs: a.killGraceMs ?? 2000, reason: () => 'interrupted', descendants: true }) : null;
    if (!rest) await markEnded(pool, a.record.id, 'interrupted');
    return { reason, end: 'interrupted' };
  }
  // 2. the provider did not stop: end the run's own group
  const end = await terminateRunGroup(pool, a.record, { graceMs: a.killGraceMs ?? 2000, descendants: true });
  return { reason, end };
}

// After a restart: ends open run processes on this host whose job no longer runs under that token
// (cancelled, finished, re-queued or taken over), and this worker's own runs whose lease expired. Another
// worker's run whose lease merely expired (a late heartbeat) is left alone (review MINOR-3). A process
// that is no longer the run is only marked.
export async function reconcileRunProcesses(pool: TxPool, a: { host?: string; workerId?: string; graceMs?: number } = {}): Promise<{ ended: number; gone: number; kept: number }> {
  const host = a.host ?? os.hostname();
  const { rows } = await pool.query<Omit<RunProcessRecord, 'fencing_token' | 'proc_start_ticks'> & { fencing_token: string; proc_start_ticks: string; worker_id: string; status: string; current_token: string; lease_live: boolean }>(
    `SELECT r.id, r.job_id, r.fencing_token::text AS fencing_token, r.worker_id, r.host, r.pid, r.pgid, r.proc_start_ticks::text AS proc_start_ticks, r.marker,
            j.status, j.fencing_token::text AS current_token, (j.lease_expires_at > clock_timestamp()) AS lease_live
     FROM run_processes r JOIN jobs j ON j.id = r.job_id WHERE r.ended_at IS NULL AND r.host = $1 ORDER BY r.started_at`, [host]);
  const out = { ended: 0, gone: 0, kept: 0 };
  for (const row of rows) {
    const r: RunProcessRecord = { ...row, fencing_token: Number(row.fencing_token), proc_start_ticks: Number(row.proc_start_ticks) };
    const current = row.status === 'RUNNING' && row.current_token === row.fencing_token;
    const stillRunning = current && (row.lease_live === true || row.worker_id !== a.workerId);
    if (stillRunning && processMatches(r)) { out.kept++; continue; }
    if (!processMatches(r) && !groupMembers(r).length) { await markEnded(pool, r.id, 'gone'); out.gone++; continue; }
    const end = await terminateRunGroup(pool, r, { graceMs: a.graceMs ?? 2000, reason: () => 'reconciled' });
    if (end === 'gone') out.gone++;
    else out.ended++;
  }
  return out;
}
