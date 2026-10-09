// PW-020 — the page's view of a job is built from server events only: answering, answered, proposal
// ready (not applied) and applied stay distinct; resent events are ignored; the end always counts.
import { describe, expect, test } from 'vitest';
import { PHASE_LABEL, canCancel, initialState, partialAnswer, reduce, withProposalStatus, type ServerEvent } from '../../../apps/web/src/features/chat/stream-state.ts';

const run = (evs: ServerEvent[]) => evs.reduce(reduce, initialState);
const status: ServerEvent = { event: 'status', id: 1, data: { state: 'running', provider: 'mock', label: 'MOCK' } };

describe('job stream state', () => {
  test('an answer: queued -> running -> answering -> answered, with the MOCK label from the run', () => {
    expect(initialState.phase).toBe('queued');
    expect(run([status]).phase).toBe('running');
    const s = run([status, { event: 'delta', id: 2, data: { text: '[MOCK] a ' } }, { event: 'delta', id: 3, data: { text: 'b' } }]);
    expect(s).toMatchObject({ phase: 'answering', answer: '[MOCK] a b', label: 'MOCK', provider: 'mock' });
    expect(canCancel(s)).toBe(true);
    const done = reduce(reduce(s, { event: 'answer_done', id: 4, data: {} }), { event: 'end', id: 4, data: { status: 'SUCCEEDED' } });
    expect(done).toMatchObject({ phase: 'answered', ended: true });
    expect(canCancel(done)).toBe(false);
  });

  test('a resent numbered event is ignored, but job/end messages are never dropped (EventSource repeats the last id on them)', () => {
    const s = run([status, { event: 'delta', id: 2, data: { text: 'x' } }, { event: 'delta', id: 2, data: { text: 'x' } }]);
    expect(s.answer).toBe('x');
    const ended = reduce(s, { event: 'end', id: 2, data: { status: 'CANCELLED' } });
    expect(ended).toMatchObject({ phase: 'cancelled', ended: true });
    expect(reduce(initialState, { event: 'job', id: 0, data: { status: 'RUNNING' } }).phase).toBe('running');
  });

  test('a proposal is "ready, not applied" until its own status says applied', () => {
    const s = run([status, { event: 'proposal', id: 2, data: { proposal_id: 'p1', status: 'PENDING' } }, { event: 'end', id: 2, data: { status: 'SUCCEEDED' } }]);
    expect(s.phase).toBe('proposal_ready');
    expect(PHASE_LABEL[s.phase]).toContain('아직 원고에 적용되지 않음');
    expect(withProposalStatus(s, 'APPLIED').phase).toBe('applied');
    expect(withProposalStatus(s, 'REJECTED').phase).toBe('rejected');
    expect(withProposalStatus(initialState, 'APPLIED').phase).toBe('queued'); // no proposal, nothing to apply
    expect(run([status, { event: 'proposal', id: 2, data: { proposal_id: 'p', status: 'STALE', reason: 'late' } }]).phase).toBe('stale');
  });

  test('failure, cancel and no change end without a result', () => {
    expect(run([status, { event: 'end', data: { status: 'FAILED', last_error: 'boom' } }])).toMatchObject({ phase: 'failed', note: 'boom' });
    expect(run([status, { event: 'no_change', id: 2, data: { explanation: 'MOCK' } }]).phase).toBe('no_change');
    expect(run([{ event: 'end', data: { status: 'CANCELLED' } }]).phase).toBe('cancelled');
  });

  test('without a status event there is no provider label (never assumed real or mock)', () => {
    expect(run([{ event: 'delta', id: 1, data: { text: 'a' } }]).label).toBeNull();
  });
});

describe('review fixes', () => {
  test('MAJOR: a retried run replaces the earlier run\'s pieces instead of adding to them', () => {
    const s = run([
      { event: 'status', id: 1, data: { state: 'running', run: 1, label: 'MOCK', provider: 'mock' } },
      { event: 'delta', id: 2, data: { text: 'first try ' } },
      { event: 'job', data: { status: 'QUEUED' } },
      { event: 'status', id: 3, data: { state: 'running', run: 2, label: 'MOCK', provider: 'mock' } },
      { event: 'delta', id: 4, data: { text: 'second ' } },
      { event: 'delta', id: 5, data: { text: 'try' } },
      { event: 'answer_done', id: 6, data: {} },
    ]);
    expect(s).toMatchObject({ phase: 'answered', answer: 'second try', run: 2 });
  });
  test('a run waiting for its retry is shown as waiting, and its fragment is not a result', () => {
    const s = run([{ event: 'status', id: 1, data: { run: 1, label: 'MOCK' } }, { event: 'delta', id: 2, data: { text: 'frag' } }, { event: 'job', data: { status: 'QUEUED' } }]);
    expect(s).toMatchObject({ phase: 'queued', note: '다시 시도 대기' });
    expect(partialAnswer(s)).toBe(true);
  });
  test('MINOR: a cancelled or failed answer keeps its fragment only as an interrupted part', () => {
    const base = run([{ event: 'status', id: 1, data: { run: 1 } }, { event: 'delta', id: 2, data: { text: 'frag' } }]);
    expect(partialAnswer(base)).toBe(false); // still answering
    expect(partialAnswer(reduce(base, { event: 'end', data: { status: 'CANCELLED' } }))).toBe(true);
    expect(partialAnswer(reduce(base, { event: 'end', data: { status: 'FAILED' } }))).toBe(true);
    expect(partialAnswer(reduce(base, { event: 'answer_done', id: 3, data: {} }))).toBe(false);
  });
  test('waiting for an outside condition does not end the stream view', () => {
    const s = reduce(run([status]), { event: 'job', data: { status: 'WAITING_QUOTA' } });
    expect(s).toMatchObject({ phase: 'waiting', ended: false });
    expect(canCancel(s)).toBe(true);
  });
});
