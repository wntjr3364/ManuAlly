// WritingProfile (PW-041): choose writing references, ask for a proposed profile, see for every rule the
// reference and section it came from — and what the system removed and why (a section that was not
// read, copied wording …) — then approve the exact version (the user's act). The journal rule (text,
// where it came from, the date it was checked) is the user's statement, saved as the user's own
// version. Feedback is kept for the next proposal and changes nothing by itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface RuleSource { reference_id: string; section: string }
interface Rule { text: string; sources: RuleSource[] }
interface Content {
  article_type: string; target_audience: string; preferred_english_variant: string; concision_preference: string; claim_strength_policy: string;
  section_roles: { section: string; role: string; principles: Rule[]; counterexamples: Rule[] }[];
  rhetoric_patterns: Rule[]; anti_examples: Rule[]; accepted_examples: { text: string; source: RuleSource | null }[];
  terminology: unknown[];
  journal_rule_snapshot?: { text: string; source: string; checked_at: string; article_types: string[] };
}
interface Source { reference_id: string; title: string; read_depth: string; sections_read: string[]; withheld: string | null }
interface Revision {
  id: string; status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'; content: Content; content_hash: string; sources: Source[];
  removed: { where: string; text: string; reason: string }[]; generator: string | null; generator_label: string | null; created_at: string;
}
interface View { active: Revision | null; latest: Revision | null; revisions: { id: string; status: string; created_at: string }[]; feedback: { id: string; text: string; status: string }[] }

const DEPTH: Record<string, string> = { FULLTEXT_PARSED: '본문 읽음', ABSTRACT_ONLY: '초록만 읽음', UNSECTIONED: '본문은 있으나 섹션을 찾지 못함', METADATA_ONLY: '서지 정보만' };
const REMOVED: Record<string, string> = {
  section_not_read: '읽지 않은 섹션에서 나온 규칙',
  source_section_is_not_the_role_section: '다른 섹션을 근거로 든 규칙',
  no_source: '출처가 없는 규칙',
  copied_from_source: '원문 문구를 그대로 옮김',
};
const WITHHELD: Record<string, string> = {
  asset_keep_right_unknown: '보관 근거가 정해지지 않은 원문',
  asset_send_denied: '외부 AI로 보내지 않기로 한 원문',
  asset_send_unknown: '외부 전송 여부가 정해지지 않은 원문',
};
const withheldText = (w: string) => w.split(',').map((x) => WITHHELD[x] ?? x).join(', ');

export function WritingProfilePanel({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [refs, setRefs] = useState<{ id: string; title: string }[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [rule, setRule] = useState({ text: '', source: '', checked_at: '' });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const waiting = useRef<number | null>(null);
  const load = useCallback(async () => {
    const v = await api<View>('GET', `/api/papers/${paperId}/writing-profile`);
    setView(v);
    return v;
  }, [paperId]);
  useEffect(() => {
    if (!visible) return;
    load().catch((e) => setError(errorText(e)));
    api<{ id: string; title: string }[]>('GET', `/api/papers/${paperId}/references`).then(setRefs).catch((e) => setError(errorText(e)));
  }, [load, paperId, visible]);
  useEffect(() => () => { if (waiting.current) clearInterval(waiting.current); }, []);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError('');
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const request = async () => {
    setError('');
    try {
      const before = view?.latest?.id ?? null;
      await api('POST', `/api/papers/${paperId}/writing-profile/runs`, { reference_ids: [...chosen], idempotency_key: crypto.randomUUID() });
      setNote('프로필 제안을 요청했습니다. 준비되면 아래에 나타납니다.');
      let n = 0;
      if (waiting.current) clearInterval(waiting.current);
      waiting.current = window.setInterval(() => {
        n++;
        void load().then((v) => {
          const now = v.latest?.id ?? null;
          if (now !== before || n > 40) { clearInterval(waiting.current!); waiting.current = null; setNote(now !== before ? '' : '아직 결과가 없습니다 — AI 실행 탭에서 상태를 확인하세요'); }
        }).catch(() => {});
      }, 750);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const latest = view?.latest ?? null;
  const titleOf = (id: string) => latest?.sources.find((s) => s.reference_id === id)?.title || refs.find((r) => r.id === id)?.title || id.slice(0, 8);
  const sourcesText = (r: Rule) => (r.sources.length ? r.sources.map((s) => `${titleOf(s.reference_id)} · ${s.section}`).join('; ') : '사용자 선호');

  return (
    <section className="card" aria-label="글쓰기 프로필" data-testid="writing-profile">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>글쓰기 프로필</h2>
        {view?.active ? <span className="status" data-testid="profile-active">승인된 프로필 있음</span> : <span className="status" data-testid="profile-active">승인된 프로필 없음</span>}
      </div>
      <p className="hint">고른 참고 논문에서 실제로 읽은 섹션만 근거로 씁니다. 읽지 않은 섹션에서 나온 규칙과 원문 문구를 옮긴 규칙은 저장되지 않고 아래에 이유와 함께 남습니다. 승인은 사용자가 정확한 버전에 대해 합니다.</p>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert" className="error">{error}</p>}

      <fieldset>
        <legend>참고할 논문</legend>
        {!refs.length && <p className="hint">먼저 참고문헌을 추가하고 원문 PDF를 올려 읽히세요.</p>}
        {refs.map((r) => (
          <label key={r.id} style={{ display: 'block' }}>
            <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} /> {r.title}
          </label>
        ))}
        <button type="button" onClick={() => void request()} disabled={!chosen.size}>프로필 제안 요청</button>
      </fieldset>

      {latest && (
        <article data-testid="profile-latest" data-status={latest.status}>
          <h3>
            최근 버전 <span className="status" data-testid="profile-status">{latest.status}</span>
            {latest.generator_label && <span className="status" data-testid="profile-label">{latest.generator_label}</span>}
          </h3>
          <h4>읽은 자료</h4>
          <ul>
            {latest.sources.map((s) => (
              <li key={s.reference_id} data-testid="profile-source">
                {s.title || s.reference_id.slice(0, 8)} — {DEPTH[s.read_depth] ?? s.read_depth}
                {s.sections_read.length > 0 && <> ({s.sections_read.join(', ')})</>}
                {s.withheld && <> · {withheldText(s.withheld)}</>}
              </li>
            ))}
          </ul>
          <h4>섹션별 역할</h4>
          {!latest.content.section_roles.length && <p className="hint">읽은 본문 섹션이 없어 섹션 규칙이 없습니다.</p>}
          {latest.content.section_roles.map((r, i) => (
            <div key={i} data-testid="profile-role">
              <strong>{r.section}</strong>: {r.role}
              <ul>
                {r.principles.map((p, j) => <li key={`p${j}`} data-testid="profile-principle">{p.text} <span className="hint">[{sourcesText(p)}]</span></li>)}
                {r.counterexamples.map((p, j) => <li key={`c${j}`} data-testid="profile-counterexample">피할 것: {p.text} <span className="hint">[{sourcesText(p)}]</span></li>)}
              </ul>
            </div>
          ))}
          {latest.content.journal_rule_snapshot && (
            <p data-testid="profile-journal-rule">저널 규정: {latest.content.journal_rule_snapshot.text} <span className="hint">({latest.content.journal_rule_snapshot.source}, {latest.content.journal_rule_snapshot.checked_at} 확인)</span></p>
          )}
          {latest.removed.length > 0 && (
            <>
              <h4>저장하지 않은 것</h4>
              <ul>
                {latest.removed.map((r, i) => <li key={i} data-testid="profile-removed">{r.text} — {REMOVED[r.reason] ?? r.reason}</li>)}
              </ul>
            </>
          )}
          {latest.status === 'DRAFT' && (
            <button type="button" onClick={() => void act(() => api('POST', `/api/papers/${paperId}/writing-profile/revisions/${latest.id}/approve`, { intent: 'approve_profile', content_hash: latest.content_hash }), '이 버전을 승인했습니다.')}>이 버전 승인</button>
          )}

          <fieldset>
            <legend>저널 규정 (직접 확인한 내용)</legend>
            <label>규정 내용 <textarea value={rule.text} onChange={(e) => setRule({ ...rule, text: e.target.value })} /></label>
            <label>출처(주소 또는 문서) <input value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value })} /></label>
            <label>확인한 날짜 <input type="date" value={rule.checked_at} onChange={(e) => setRule({ ...rule, checked_at: e.target.value })} /></label>
            <button type="button" disabled={!rule.text.trim() || !rule.source.trim() || !rule.checked_at} onClick={() => void act(
              () => api('POST', `/api/papers/${paperId}/writing-profile/revisions`, { parent_revision_id: latest.id, content: { ...latest.content, journal_rule_snapshot: { text: rule.text, source: rule.source, checked_at: rule.checked_at, article_types: [latest.content.article_type] } } }),
              '저널 규정을 넣은 새 초안을 만들었습니다. 확인하고 승인하세요.')}>저널 규정 넣은 새 초안</button>
          </fieldset>
        </article>
      )}

      <fieldset>
        <legend>다음 제안에 반영할 의견</legend>
        <label>의견 <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} /></label>
        <button type="button" disabled={!feedback.trim()} onClick={() => void act(async () => { await api('POST', `/api/papers/${paperId}/writing-profile/feedback`, { text: feedback }); setFeedback(''); }, '의견을 남겼습니다. 다음 제안 때 참고하며, 지금 프로필은 바뀌지 않습니다.')}>의견 남기기</button>
        <ul>{view?.feedback.map((f) => <li key={f.id} data-testid="profile-feedback">{f.text}</li>)}</ul>
      </fieldset>
    </section>
  );
}
