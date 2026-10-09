// Where a claim's support comes from, and what a figure/table change asks the owner to review
// (PW-036). A claim is traced to its evidence, the figure/table version and panel it was read from
// (with unit and groups), the confirmed PDF location and the fact values. A new figure version never
// changes the manuscript: the paragraphs, claims and facts that rely on it are listed for review, and
// only the owner closes each item.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiRaw, errorText } from '../../app/api.ts';
import { TARGET, reasonText } from './labels.ts';

interface Flag { id: string; figure_id: string; target_kind: string; block_id: string | null; claim_id: string | null; fact_id: string | null; reasons: string[]; from_version_no: number; to_version_no: number }
interface Claim { id: string; text: string; approval_state: string; content_hash: string }
interface Figure { id: string; kind: string; title: string; position: number }
interface Version { id: string; version_no: number; caption: string; panels: { panel: string; unit: string; groups: string[] }[] }
interface Trace {
  claim: Claim;
  links: {
    relation: string;
    evidence: { id: string; kind: string; label: string; state: string };
    figure: { kind: string; number: number | null; title: string; version_no: number; current_version_no: number; outdated: boolean; panel: string; unit: string | null; groups: string[] } | null;
    source_location: { page_index: number; exact: string; sha256: string } | null;
    facts: { id: string; entity: string; metric: string; value_text: string; unit: string; group_label: string; verification_state: string; unit_matches_panel: boolean | null }[];
  }[];
  open_flags: { id: string; reasons: string[] }[];
}

// "A: fold; WT, abc1" per line → panels
export function parsePanelLines(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [head, groups] = l.split(';');
    const [panel, unit] = (head ?? '').split(':').map((x) => x.trim());
    return { panel: panel ?? '', unit: unit ?? '', groups: (groups ?? '').split(',').map((g) => g.trim()).filter(Boolean) };
  });
}

export function TracePanel({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [figures, setFigures] = useState<Figure[]>([]);
  const [versions, setVersions] = useState<Record<string, Version[]>>({});
  const [trace, setTrace] = useState<Trace | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ figure: string; caption: string; panels: string }>({ figure: '', caption: '', panels: '' });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [f, c, g] = await Promise.all([
        api<{ flags: Flag[] }>('GET', `/api/papers/${paperId}/review-flags`),
        api<Claim[]>('GET', `/api/papers/${paperId}/claims`),
        api<Figure[]>('GET', `/api/papers/${paperId}/figures`),
      ]);
      setFlags(f.flags);
      setClaims(c);
      setFigures(g);
      const vs: Record<string, Version[]> = {};
      for (const fig of g) vs[fig.id] = (await api<{ versions: Version[] }>('GET', `/api/papers/${paperId}/figures/${fig.id}/versions`)).versions;
      setVersions(vs);
      setError('');
    } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);

  const label = (id: string) => {
    const f = figures.find((x) => x.id === id);
    if (!f) return '(보관된 그림)';
    const n = figures.filter((x) => x.kind === f.kind).sort((a, b) => a.position - b.position).findIndex((x) => x.id === id) + 1;
    return `${f.kind === 'figure' ? 'Figure' : 'Table'} ${n} (${f.title})`;
  };
  // PW-040: withdrawing an approved claim; outline nodes that rely on it show an impact to review
  const retractClaim = async (c: Claim) => {
    if (!window.confirm('이 주장을 철회할까요? 이 주장을 쓰는 개요 문단에 영향 검토가 표시됩니다.')) return;
    try { await api('POST', `/api/papers/${paperId}/claims/${c.id}/retract`, { intent: 'retract_claim', content_hash: c.content_hash }); await load(); } catch (e) { setError(errorText(e)); }
  };
  const target = (f: Flag) => (f.target_kind === 'claim' ? `“${claims.find((c) => c.id === f.claim_id)?.text ?? f.claim_id}”` : f.target_kind === 'paragraph' ? `문단 ${f.block_id?.slice(0, 8)}…` : `사실 ${f.fact_id?.slice(0, 8)}…`);

  const resolve = async (f: Flag) => {
    try {
      await api('POST', `/api/papers/${paperId}/review-flags/${f.id}/resolve`, { note: notes[f.id] ?? '' });
      await load();
    } catch (e) { setError(errorText(e)); }
  };
  const showTrace = async (c: Claim) => {
    try { setTrace(await api<Trace>('GET', `/api/papers/${paperId}/claims/${c.id}/trace`)); } catch (e) { setError(errorText(e)); }
  };
  const addVersion = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.figure) return;
    try {
      let assetId: string | undefined;
      if (file) assetId = (await apiRaw<{ asset_id: string }>(`/api/papers/${paperId}/figures/${form.figure}/files?name=${encodeURIComponent(file.name)}`, file, file.type || 'application/octet-stream')).asset_id;
      const prev = versions[form.figure]?.at(-1);
      const r = await api<{ version: Version; changes: string[]; flags: unknown[] }>('POST', `/api/papers/${paperId}/figures/${form.figure}/versions`, {
        caption: form.caption, panels: parsePanelLines(form.panels), asset_id: assetId ?? (prev ? (prev as unknown as { asset_revision_id: string | null }).asset_revision_id : null),
      });
      setNote(r.flags.length ? `새 버전 ${r.version.version_no}: 검토할 곳 ${r.flags.length}개가 생겼습니다(원고는 바뀌지 않았습니다).` : `버전 ${r.version.version_no}을 만들었습니다.`);
      setFile(null);
      await load();
    } catch (err) { setError(errorText(err)); }
  };

  return (
    <section className="card" aria-label="출처 추적">
      <h2>그림·표 변경 검토</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status" className="hint">{note}</p>}
      {flags.length === 0 ? <p className="hint" data-testid="no-flags">검토할 곳이 없습니다.</p> : (
        <ul className="plain" data-testid="flag-list">
          {flags.map((f) => (
            <li key={f.id} data-testid="flag" data-target={f.target_kind}>
              <strong>{TARGET[f.target_kind]}</strong> {target(f)} — {label(f.figure_id)} 버전 {f.from_version_no} → {f.to_version_no}: {f.reasons.map(reasonText).join(', ')}
              {' '}<input aria-label="검토 메모" placeholder="검토 메모" value={notes[f.id] ?? ''} onChange={(e) => setNotes({ ...notes, [f.id]: e.target.value })} />
              {' '}<button type="button" onClick={() => void resolve(f)}>검토함</button>
            </li>
          ))}
        </ul>
      )}
      <h3>그림·표 버전</h3>
      <ul className="plain" data-testid="figure-versions">
        {figures.map((f) => (
          <li key={f.id}>{label(f.id)}: {(versions[f.id] ?? []).map((v) => `v${v.version_no} [${v.panels.map((p) => `${p.panel}${p.unit ? ` ${p.unit}` : ''}`).join(', ')}]`).join(' · ') || '버전 없음'}</li>
        ))}
      </ul>
      <form onSubmit={(e) => void addVersion(e)} aria-label="새 그림 버전" className="stack">
        <label>그림·표 <select value={form.figure} onChange={(e) => setForm({ ...form, figure: e.target.value })}><option value="">선택</option>{figures.map((f) => <option key={f.id} value={f.id}>{label(f.id)}</option>)}</select></label>
        <label>캡션 <input value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} /></label>
        <label>패널 목록 <textarea aria-label="패널 목록" aria-describedby="panel-format" value={form.panels} onChange={(e) => setForm({ ...form, panels: e.target.value })} rows={3} /></label>
        <span id="panel-format" className="hint">줄마다 패널 하나: 이름, 콜론, 측정 단위, 세미콜론, 그룹들(쉼표) — 예: A: fold; WT, abc1</span>
        <label>파일(PNG, JPEG, CSV — 바꿀 때만) <input type="file" accept="image/png,image/jpeg,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <button type="submit">새 버전 만들기</button>
      </form>
      <h3>주장의 출처</h3>
      <ul className="plain">
        {claims.map((c) => (
          <li key={c.id} data-testid="claim-row">“{c.text}” <span className="status">{c.approval_state}</span> <button type="button" onClick={() => void showTrace(c)}>출처 추적</button>
            {c.approval_state === 'APPROVED' && <> <button type="button" onClick={() => void retractClaim(c)}>주장 철회</button></>}
          </li>
        ))}
      </ul>
      {trace && (
        <div data-testid="trace">
          <p><strong>“{trace.claim.text}”</strong> {trace.open_flags.length > 0 && <span className="warn" data-testid="trace-flags">검토 필요 {trace.open_flags.length}건</span>}</p>
          <ul className="plain">
            {trace.links.map((l) => (
              <li key={l.evidence.id} data-testid="trace-link">
                {l.relation} · 근거 “{l.evidence.label || l.evidence.kind}” ({l.evidence.state})
                {l.figure && <span data-testid="trace-figure"> · {l.figure.kind === 'figure' ? 'Figure' : 'Table'} {l.figure.number}{l.figure.panel} (버전 {l.figure.version_no}{l.figure.outdated ? `, 최신 ${l.figure.current_version_no} — 이전 버전에서 읽음` : ''}) 단위 {l.figure.unit || '—'} · 그룹 {l.figure.groups.join(', ') || '—'}</span>}
                {l.source_location && <span data-testid="trace-source"> · PDF {l.source_location.page_index + 1}쪽 “{l.source_location.exact}” (sha256 {l.source_location.sha256.slice(0, 12)}…)</span>}
                <ul>
                  {l.facts.map((f) => <li key={f.id} data-testid="trace-fact">{f.entity} · {f.metric}: {f.value_text} {f.unit} ({f.group_label}) [{f.verification_state}]{f.unit_matches_panel === false && <span className="warn"> 단위가 그림과 다름</span>}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
