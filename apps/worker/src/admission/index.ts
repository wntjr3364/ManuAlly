// Admission of a run (PW-050, spec 08 "Budget", "자동 재개": provider fallback, extra payment and reset
// credits need the owner's explicit approval — which this app does not take, so they are never admitted).
// Before a run: no paid overage, no reset credit, no API-key login (v1, ADR-012), the job's own provider and
// login, at most five runs per job, and for a run charged per call a known estimate within the owner's
// budgets (reserved). After it (also when it failed): settled from the usage ledger.
// A refusal is not a retry: WAITING_BUDGET (a budget or an unknown cost) or WAITING_USER (anything the
// owner must decide). Nothing resumes those on its own.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { reserveRun, settleReservation, type CostClass, type Reservation, type ReserveRefusal } from '@pw/domain/budget/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export const MAX_RUNS_PER_JOB = 5;
export type CostClassOf = (provider: string, authMode: string) => CostClass;
// the logins this app allows (RFC-004/ADR-012): the MOCK, and subscription logins limited by quota
export const defaultCostClass: CostClassOf = (provider, authMode) =>
  provider === 'mock' ? 'free'
    : (provider === 'claude_agent' && authMode === 'subscription_cli_login') || (provider === 'codex' && authMode === 'chatgpt_login') ? 'subscription_included'
      : 'unknown';

const NEXT: Record<ReserveRefusal, 'WAITING_BUDGET' | 'WAITING_USER'> = {
  provider_changed: 'WAITING_USER', too_many_runs: 'WAITING_USER', cost_class_unknown: 'WAITING_BUDGET', cost_unknown: 'WAITING_BUDGET', no_budget: 'WAITING_BUDGET', budget_exhausted: 'WAITING_BUDGET', run_limit: 'WAITING_BUDGET',
};

export async function admitRun(pool: TxPool, a: {
  paperId: string; jobId: string; fencingToken: number; provider: string; authMode: string; estimateUsd: number | null;
  costClassOf?: CostClassOf; paidOverage?: boolean; resetCredit?: boolean;
}): Promise<Reservation> {
  if (a.paidOverage) throw new JobOutcomeError('paid overage is never used without the owner\'s explicit approval', 'WAITING_USER');
  if (a.resetCredit) throw new JobOutcomeError('a rate-limit reset credit is never used without the owner\'s explicit approval', 'WAITING_USER');
  if (a.authMode === 'api_key') throw new JobOutcomeError('API key logins are not used (v1: the owner\'s own subscription login only)', 'WAITING_USER');
  try {
    return await reserveRun(pool, { paperId: a.paperId, jobId: a.jobId, fencingToken: a.fencingToken, provider: a.provider, authMode: a.authMode, costClass: (a.costClassOf ?? defaultCostClass)(a.provider, a.authMode), estimateUsd: a.estimateUsd, maxRuns: MAX_RUNS_PER_JOB });
  } catch (e) {
    const reason = e instanceof DomainError ? (e.details as { reason?: ReserveRefusal } | undefined)?.reason : undefined;
    if (reason) throw new JobOutcomeError(e instanceof Error ? e.message : String(e), NEXT[reason]);
    throw e;
  }
}

// A handler wrapper: admit before the run, settle after it (also when it failed).
export function withAdmission<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, o: { provider: string; authMode: string; estimateUsd: (job: Job) => number | null; costClassOf?: CostClassOf }): Record<K, JobHandler> {
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job, ctx) => {
      const r = await admitRun(pool, { paperId: job.paper_id, jobId: job.id, fencingToken: ctx.fencingToken, provider: o.provider, authMode: o.authMode, estimateUsd: o.estimateUsd(job), costClassOf: o.costClassOf });
      try {
        return await handler(job, ctx);
      } finally {
        // a settlement that fails must not hide the run's own outcome (review n5); the sweep settles it later
        await settleReservation(pool, { reservationId: r.id }).catch((e) => console.error('settlement failed:', e instanceof Error ? e.message : e));
      }
    };
  }
  return out;
}
