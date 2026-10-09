// Runs selection requests (PW-020): ask -> a streamed answer; grammar/concise/rewrite -> a proposal.
// Every piece is reported as a job event under the run's fencing token, so a cancelled or taken-over
// run stops at its next report and changes nothing more. The final event (answer_done, proposal or
// no_change) and the proposal itself are written in the job's completion transaction: a run that does
// not finish leaves neither. The provider's label (MOCK) travels with every event the browser sees.
import { canonicalJson } from '@pw/domain/revisions/index.ts';
import { DomainError, type TxPool } from '@pw/domain/shared/db.ts';
import { appendJobEvent, appendJobEventIn, type Job } from '@pw/domain/jobs/index.ts';
import { createProposalIn, selectionSlice } from '@pw/domain/proposals/index.ts';
import type { SelectionJobPayload } from '@pw/domain/ai/index.ts';
import type { SelectionProvider, SliceItem } from '@pw/providers';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

const HEARTBEAT_EVERY_MS = 5_000;

export function selectionHandlers(pool: TxPool, provider: SelectionProvider): Record<'ask_selection' | 'revise_selection', JobHandler> {
  const tag = { provider: provider.id, label: provider.label };
  const start = async (job: Job, fencingToken: number) => {
    const p = job.payload as unknown as SelectionJobPayload;
    const report = (kind: Parameters<typeof appendJobEvent>[1]['kind'], data: Record<string, unknown>) => appendJobEvent(pool, { jobId: job.id, fencingToken, kind, data });
    await report('status', { state: 'running', ...tag });
    const slice = await selectionSlice(pool, job.paper_id, p.handle_id).catch((e) => {
      throw e instanceof DomainError && e.code !== 'CONFLICT' ? new JobOutcomeError(e.message, 'FAILED') : e;
    });
    return { p, report, items: slice.items as SliceItem[] };
  };

  const ask: JobHandler = async (job, ctx) => {
    const { p, report, items } = await start(job, ctx.fencingToken);
    const quote = items.map((i) => (i.type === 'text' ? i.text : '￼')).join('');
    let chars = 0;
    let beat = Date.now();
    for await (const piece of provider.answer({ question: p.instruction, quote })) {
      await report('delta', { text: piece });
      chars += piece.length;
      if (Date.now() - beat > HEARTBEAT_EVERY_MS) {
        if (!(await ctx.heartbeat())) throw new DomainError('CONFLICT', 'lease lost during the answer');
        beat = Date.now();
      }
    }
    return {
      apply: async (tx) => { await appendJobEventIn(tx, { jobId: job.id, kind: 'answer_done', data: { chars, ...tag } }); },
      result: { kind: 'answer', chars, ...tag },
    };
  };

  const revise: JobHandler = async (job, ctx) => {
    const { p, items } = await start(job, ctx.fencingToken);
    if (p.intent === 'ask') throw new JobOutcomeError('a question is not a correction', 'FAILED');
    const out = await provider.revise({ intent: p.intent, instruction: p.instruction, items });
    if (canonicalJson(out.items) === canonicalJson(items)) {
      return {
        apply: async (tx) => { await appendJobEventIn(tx, { jobId: job.id, kind: 'no_change', data: { explanation: out.explanation, ...tag } }); },
        result: { kind: 'no_change', ...tag },
      };
    }
    const result: Record<string, unknown> = { kind: 'proposal', ...tag };
    return {
      apply: async (tx) => {
        let proposal;
        try {
          proposal = await createProposalIn(tx, { paperId: job.paper_id, handleId: p.handle_id, intent: p.intent, replacement: out.items, explanation: out.explanation, origin: `worker:provider.${provider.id}` });
        } catch (e) {
          // e.g. the outline lost its approval meanwhile (rewrite) or the answer is malformed: final, not retried
          if (e instanceof DomainError && e.code !== 'CONFLICT') throw new JobOutcomeError(e.message, 'FAILED');
          throw e;
        }
        result.proposal_id = proposal.id;
        await appendJobEventIn(tx, { jobId: job.id, kind: 'proposal', data: { proposal_id: proposal.id, status: proposal.status, reason: proposal.status_reason, ...tag } });
      },
      result,
    };
  };

  return { ask_selection: ask, revise_selection: revise };
}
