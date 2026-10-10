// Reviewer comments, answers and the submission freeze (PW-058). A comment is pasted as the reviewer wrote it;
// an answer "수정함" must point to blocks that were really changed after the comment (the server refuses
// otherwise), and the list shows whether that change is still in the manuscript. Freezing is the owner's act:
// the check runs first, problems that block a submission-ready version are listed, warnings must be
// confirmed, and a draft can be frozen with its problems recorded.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

type Status = 'addressed' | 'partly_addressed' | 'disagree' | 'explained' | 'not_addressed';
interface Link { revision_id: string; block_id: string; change: string; heading: string | null }
interface Comment {
  id: string; round: string; reviewer: string; position: number; text: string; base_revision_id: string;
  response: { status: Status; text: string; links: Link[]; holds_now: boolean | null } | null;
}
interface Change { block_id: string; change: 'changed' | 'added' | 'removed'; heading: string | null; before: string | null; after: string | null }
interface Item { kind: string; count: number; examples: string[]; note: string }
interface Checks { revision_id?: string; blocking: Item[]; warnings: Item[] }
interface Submission { id: string; label: string; target: string | null; status: 'draft' | 'submission_ready'; revision_id: string; docx_sha256: string; archive_export_id: string; checks: Checks; created_at: string }
const STATUS: Record<Status, string> = { addressed: '수정함', partly_addressed: '일부 수정함', disagree: '동의하지 않음', explained: '설명함', not_addressed: '반영하지 않음' };
const CHANGE: Record<string, string> = { changed: '바뀜', added: '새 문단', removed: '지운 문단' };
const when = (t: string) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' });

function Items({ items, tone, testId }: { items: Item[]; tone: 'error' | 'warn'; testId: string }) {
  if (!items.length) return null;
  return <ul className={tone} data-testid={testId}>{items.map((i) => <li key={i.kind} data-kind={i.kind}>{i.note} ({i.count}{i.examples.length ? `: ${i.examples.join(', ')}` : ''})</li>)}</ul>;
}

function Answer({ paperId, c, canChange, onDone }: { paperId: string; c: Comment; canChange: boolean; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState<Status>('addressed');
  const [text, setText] = useState('');
  const [changes, setChanges] = useState<{ head_revision_id: string; blocks: Change[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const needsLinks = status === 'addressed' || status === 'partly_addressed';
  useEffect(() => {
    if (!needsLinks) return;
    api<{ head_revision_id: string; blocks: Change[] }>('GET', `/api/papers/${paperId}/review-comments/${c.id}/changes`).then(setChanges).catch((e) => setError(errorText(e)));
  }, [paperId, c.id, needsLinks]);
  const send = async () => {
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/review-comments/${c.id}/responses`, { status, text, links: needsLinks && changes ? picked.map((block_id) => ({ revision_id: changes.head_revision_id, block_id })) : [] });
      setText('');
      setPicked([]);
      await onDone();
    } catch (e) { setError(errorText(e)); }
  };
  return (
    <div className="answer" data-testid="answer-form">
      <label>답<select value={status} onChange={(e) => setStatus(e.target.value as Status)} data-testid="answer-status">{(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}</select></label>
      <label>답변<textarea value={text} onChange={(e) => setText(e.target.value)} data-testid="answer-text" /></label>
      {needsLinks && (
        <fieldset>
          <legend>수정한 곳(의견 뒤 실제로 바뀐 문단만 고를 수 있습니다)</legend>
          {changes && changes.blocks.length === 0 && <p className="hint" data-testid="no-changes">의견을 받은 뒤 바뀐 문단이 없습니다. 원고를 고친 뒤 답하세요.</p>}
          {changes?.blocks.map((b) => (
            <label key={b.block_id} className="change" data-testid="change">
              <input type="checkbox" checked={picked.includes(b.block_id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, b.block_id] : p.filter((x) => x !== b.block_id)))} />
              {b.heading ?? '(제목 없음)'} · {CHANGE[b.change]}: {b.after ?? b.before}
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" disabled={!canChange || (needsLinks && picked.length === 0)} onClick={() => void send()}>답 저장</button>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

export function SubmissionPanel({ paperId, documentId, headRevisionId, canChange }: { paperId: string; documentId: string; headRevisionId: string; canChange: boolean }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [reviewer, setReviewer] = useState('Reviewer 1');
  const [round, setRound] = useState('R1');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setComments(await api<Comment[]>('GET', `/api/papers/${paperId}/review-comments`));
      setSubs(await api<Submission[]>('GET', `/api/papers/${paperId}/submissions`));
    } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { void load(); }, [load, headRevisionId]);
  // a new manuscript version: earlier checks and confirmations no longer apply (an open answer form is
  // remounted for the new version and fetches its change list again)
  useEffect(() => { setChecks(null); setConfirm(false); }, [headRevisionId]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) {
      setError(errorText(e));
      const d = (e as { body?: { blocking?: Item[]; warnings?: Item[] } }).body;
      if (d && (d.blocking || d.warnings)) setChecks({ blocking: d.blocking ?? [], warnings: d.warnings ?? [] });
    } finally { setBusy(false); await load(); }
  };
  const freeze = (status: 'draft' | 'submission_ready') => act(async () => {
    // only the warnings shown here are confirmed; any other one sends the owner back to look at it
    await api('POST', `/api/papers/${paperId}/submissions`, { intent: 'freeze_submission', document_id: documentId, expected_revision_id: headRevisionId, status, label, target: target || null, confirm_warnings: confirm && checks ? checks.warnings.map((w) => w.kind) : [] });
    setChecks(null);
    setConfirm(false);
  });
  return (
    <section className="card" data-testid="submission">
      <h2>리뷰어 의견과 제출판</h2>
      <p className="hint">리뷰어 의견을 붙여 넣고 답을 기록합니다. "수정함"은 의견 뒤 실제로 바뀐 문단을 가리켜야 저장됩니다. 제출판은 그 순간의 원고·문헌·그림을 스냅샷과 원본 묶음으로 고정하며 바뀌지 않습니다. 투고는 직접 하세요(자동 투고 없음).</p>
      <h3>의견 붙여 넣기</h3>
      <div className="toolbar">
        <label>차수<input value={round} onChange={(e) => setRound(e.target.value)} style={{ width: '5em' }} /></label>
        <label>리뷰어<input value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
      </div>
      <label>의견<textarea value={text} onChange={(e) => setText(e.target.value)} data-testid="comment-text" /></label>
      <button type="button" disabled={busy || !canChange || !text.trim()} onClick={() => void act(async () => { await api('POST', `/api/papers/${paperId}/review-comments`, { document_id: documentId, round, reviewer, text }); setText(''); })}>의견 추가</button>
      <ol className="comments">
        {comments.map((c) => (
          <li key={c.id} data-testid="review-comment" data-status={c.response?.status ?? 'none'}>
            <strong>{c.round} {c.reviewer}</strong> <span className="hint">#{c.position}</span>
            <blockquote>{c.text}</blockquote>
            {c.response ? (
              <p data-testid="response">
                <strong>{STATUS[c.response.status]}</strong> — {c.response.text}
                {c.response.links.length > 0 && <span className="hint"> · 수정한 곳: {c.response.links.map((l) => `${l.heading ?? '(제목 없음)'}(${CHANGE[l.change] ?? l.change})`).join(', ')}</span>}
                {c.response.holds_now === false && <span className="error" data-testid="claim-missing"> · 지금 원고에서는 의견 당시 그대로입니다</span>}
              </p>
            ) : <p className="warn" data-testid="no-response">아직 답이 없습니다</p>}
            <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? '닫기' : c.response ? '답 고치기' : '답하기'}</button>
            {open === c.id && <Answer key={`${c.id}:${headRevisionId}`} paperId={paperId} c={c} canChange={canChange && !busy} onDone={async () => { setOpen(null); await load(); }} />}
          </li>
        ))}
      </ol>
      <h3>제출판 확정</h3>
      <button type="button" disabled={busy} onClick={() => void act(async () => setChecks(await api<Checks>('POST', `/api/papers/${paperId}/submissions/check`, { document_id: documentId })))}>제출 전 검사</button>
      {checks && (
        <div data-testid="submission-checks">
          {checks.blocking.length === 0 && checks.warnings.length === 0 && <p data-testid="checks-clean">막는 문제와 경고가 없습니다.</p>}
          {checks.blocking.length > 0 && <p className="error">제출용으로 확정하기 전에 고칠 문제:</p>}
          <Items items={checks.blocking} tone="error" testId="blocking" />
          {checks.warnings.length > 0 && <p className="warn">확인이 필요한 경고:</p>}
          <Items items={checks.warnings} tone="warn" testId="warnings" />
        </div>
      )}
      <div className="toolbar">
        <label>이름<input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="submission-label" /></label>
        <label>학술지<input value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      </div>
      <label><input type="checkbox" checked={confirm} disabled={!checks || checks.warnings.length === 0} onChange={(e) => setConfirm(e.target.checked)} data-testid="confirm-warnings" /> 위 경고를 확인했고 이 버전을 제출용으로 확정합니다</label>
      <div className="toolbar">
        <button type="button" className="primary" disabled={busy || !canChange || !label.trim()} onClick={() => void freeze('submission_ready')}>제출용으로 확정</button>
        <button type="button" disabled={busy || !canChange || !label.trim()} onClick={() => void freeze('draft')}>초안으로 고정</button>
      </div>
      {busy && <p className="hint" role="status">처리 중…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="submissions">
        {subs.map((s) => (
          <li key={s.id} data-testid="frozen-submission" data-status={s.status}>
            <strong>{s.label}</strong>{s.target ? ` · ${s.target}` : ''} · {when(s.created_at)} · <span className={s.status === 'submission_ready' ? '' : 'warn'}>{s.status === 'submission_ready' ? '제출용 확정' : '초안(문제 기록됨)'}</span>
            <span className="hint"> · 버전 {s.revision_id.slice(0, 8)} · DOCX SHA-256 {s.docx_sha256.slice(0, 12)}…</span>
            {' · '}<a href={`/api/papers/${paperId}/exports/${s.archive_export_id}/file`}>원본 묶음</a>
            {' · '}<a href={`/api/papers/${paperId}/submissions/${s.id}/response-table`} data-testid="response-table">답변표</a>
            <Items items={s.checks.blocking} tone="error" testId="frozen-blocking" />
          </li>
        ))}
      </ul>
    </section>
  );
}
