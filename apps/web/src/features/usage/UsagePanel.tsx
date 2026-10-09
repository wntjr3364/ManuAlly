// Usage of this paper's AI runs and the account quota, kept apart (PW-029, spec 08 "웹 상태"):
// - 앱 사용량: tokens and the provider's estimated cost of this paper's runs
// - 문맥: the latest request's input against the model's window (not the cumulative count)
// - 계정 한도: the provider's quota per bucket, as observed at a given time
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../app/api.ts';
import { kst, percentText, quotaStatusText, resetText, tokens, usd, UNKNOWN, type Metric } from './format.ts';

interface Summary {
  billed: { input_tokens: Metric; output_tokens: Metric; cost_usd_estimate: Metric; anomalies: number };
  context: { window: number | null; last_input_tokens: number | null; used_percent: number | null; basis: string; observed_at: string | null };
}
interface Quota { provider: string; auth_profile_id: string; model: string | null; bucket: string; status: string; used_percent: number | null; resets_at: string | null; unknown_reason: string | null; confidence: string; observed_at: string }

export function UsagePanel({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quota, setQuota] = useState<Quota[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const [s, q] = await Promise.all([api<Summary>('GET', `/api/papers/${paperId}/usage`), api<{ observations: Quota[] }>('GET', '/api/providers/quota')]);
      setSummary(s);
      setQuota(q.observations);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [paperId]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  if (!summary || !quota) return <p className="loading">{failed ? '사용량을 읽지 못했습니다' : '사용량 불러오는 중…'}</p>;
  const b = summary.billed;
  const c = summary.context;
  return (
    <section aria-label="사용량" data-testid="usage">
      <h2>사용량</h2>
      <h3>이 논문의 AI 사용량 (앱 기록)</h3>
      <dl data-testid="usage-billed">
        <dt>입력 토큰</dt><dd data-testid="usage-input">{tokens(b.input_tokens)}</dd>
        <dt>출력 토큰</dt><dd data-testid="usage-output">{tokens(b.output_tokens)}</dd>
        <dt>비용</dt><dd data-testid="usage-cost">{usd(b.cost_usd_estimate)}</dd>
      </dl>
      {b.anomalies > 0 && <p className="warn" data-testid="usage-anomaly">누적 보고가 줄어든 기록 {b.anomalies}건 — 합계에 넣지 않았습니다.</p>}
      <p className="hint">공급자가 보고한 값과 추정 비용입니다. 실제 청구액과 다를 수 있습니다.</p>
      <h3>문맥 (마지막 요청 기준)</h3>
      <p data-testid="usage-context">
        {c.basis === 'unknown' ? `문맥 사용량 ${UNKNOWN}` : `${c.last_input_tokens!.toLocaleString('ko-KR')} / ${c.window!.toLocaleString('ko-KR')} 토큰 · ${percentText(c.used_percent)} · ${kst(c.observed_at!)} 관측`}
      </p>
      <h3>계정 한도 (공급자 관측)</h3>
      {!quota.length && <p data-testid="quota-none">관측된 계정 한도 정보가 없습니다 ({UNKNOWN}).</p>}
      <ul>
        {quota.map((q) => (
          <li key={`${q.provider}:${q.auth_profile_id}:${q.model}:${q.bucket}`} data-testid="quota">
            <strong>{q.provider}</strong> · {q.bucket}{q.model ? ` · ${q.model}` : ''} · <span data-testid="quota-status">{quotaStatusText(q.status)}</span>
            {' · 사용 '}<span data-testid="quota-used">{percentText(q.used_percent)}</span>
            {q.resets_at ? ' · 초기화 ' : ' · '}<span data-testid="quota-reset">{resetText(q.resets_at)}</span>
            <span className="hint"> · {kst(q.observed_at)} 관측</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
