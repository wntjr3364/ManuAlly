// What a curation suggestion means for the user (PW-033). The use, fit, read depth and warnings are
// spelled out; nothing here says a paper is good or verified — a suggestion is not an adoption.
export const ROLE: Record<string, string> = { scientific: '과학 근거 후보', writing: '문체 참고 후보', both: '근거·문체 둘 다 후보', exclude: '제외 제안' };
export const FIT: Record<string, string> = { high: '높음', medium: '보통', low: '낮음', unknown: '알 수 없음' };
export const STYLE: Record<string, string> = { good: '좋음', fair: '보통', poor: '낮음', unknown: '알 수 없음' };
export const DEPTH: Record<string, string> = {
  METADATA_ONLY: '서지 정보만 확인', ABSTRACT_ONLY: '초록만 읽음', FULLTEXT_PARTIAL: '본문 일부 읽음', FULLTEXT_PARSED: '본문 읽음', SOURCE_CHECKED: '원문 대조함',
};
export const WARNING: Record<string, string> = {
  style_needs_full_text: '문체는 본문을 읽어야 판단할 수 있어 "알 수 없음"으로 두었습니다(인용 수는 근거가 아님)',
  retracted: '철회된 논문입니다 — 과학적 근거로 쓰지 않습니다',
  role_overridden: 'AI 제안 용도를 시스템 규칙이 바꿨습니다',
  preprint: '출판 전 원고(preprint)입니다',
};
export const DECISION: Record<string, string> = { pending: '결정 전', accepted: '채택함', rejected: '채택 안 함' };
