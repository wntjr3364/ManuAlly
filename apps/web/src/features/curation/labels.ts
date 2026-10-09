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
  writing_role_needs_full_text: '문체 참고 여부는 본문을 읽어야 판단할 수 있어 그 제안을 바꿨습니다',
  notice_record: '철회·정정 등을 알리는 고지 기록입니다 — 근거 논문이 아닙니다',
  corrected: '정정(correction/erratum)이 나온 논문입니다',
  expression_of_concern: '우려 표명(expression of concern)이 나온 논문입니다',
  updated: '출처에서 갱신(철회 외: 철회 요청·삭제 등) 표시가 있는 논문입니다',
  notice_record_used_as_scientific: '고지 기록(철회·정정 고지)을 과학 근거 용도로 넣었습니다 — 고지를 논의하는 경우인지 확인하세요',
  retracted_work_used_as_scientific: '이 논문에는 이미 과학 근거로 들어 있는 철회 논문입니다 — 참고문헌에서 용도를 확인하세요',
};
export const DECISION: Record<string, string> = { pending: '결정 전', accepted: '채택함', rejected: '채택 안 함' };
