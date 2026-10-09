// How usage and quota numbers are shown (PW-029). Unknown is said as such, never shown as 0; reset
// times are shown in Asia/Seoul with the time they were observed; a missing reset time is
// "초기화 시각 확인 불가", not a guess.
export interface Metric { value: number | null; unknown: boolean }
export const UNKNOWN = '알 수 없음';

export function tokens(m: Metric): string {
  if (m.value === null) return UNKNOWN;
  const n = m.value.toLocaleString('ko-KR');
  return m.unknown ? `${n} 이상 (일부 보고 없음)` : n;
}
export function usd(m: Metric): string {
  if (m.value === null) return UNKNOWN;
  if (m.unknown && m.value === 0) return UNKNOWN;
  const n = `$${m.value.toFixed(4)} (추정)`;
  return m.unknown ? `${n} 이상 (일부 보고 없음)` : n;
}
const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
export const kst = (iso: string) => `${KST.format(new Date(iso))} (서울)`;
export const resetText = (resetsAt: string | null) => (resetsAt ? kst(resetsAt) : '초기화 시각 확인 불가');
export const percentText = (p: number | null) => (p === null ? UNKNOWN : `${p}%`);

const STATUS: Record<string, string> = { allowed: '사용 가능', warning: '한도 가까움', rejected: '한도 도달', unknown: UNKNOWN };
export const quotaStatusText = (s: string) => STATUS[s] ?? s;
