// Words for source documents and their rights (PW-034/035). Unknown is shown as unknown.
export const LICENSE: Record<string, string> = {
  unknown: '알 수 없음', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC', 'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-nd': 'CC BY-NC-ND',
  cc0: 'CC0', 'public-domain': '퍼블릭 도메인', 'publisher-tdm': '출판사 TDM 허용', 'all-rights-reserved': '모든 권리 보유', 'own-work': '내 저작물',
};
export const KEEP: Record<string, string> = { unknown: '보관 근거 모름', user_supplied: '내가 가진 파일', open_license: '공개 라이선스' };
export const SEND: Record<string, string> = { unknown: '외부 AI 전송: 정하지 않음(보내지 않음)', allowed: '외부 AI 전송: 허용', denied: '외부 AI 전송: 금지' };
export const EXTRACTION: Record<string, string> = { ok: '텍스트 추출됨', no_text: '텍스트 없음(이미지 문서?)', failed: '추출 실패' };
export const FLAG: Record<string, string> = {
  no_text: '이 쪽에는 추출된 텍스트가 없습니다',
  page_rotated: '회전된 쪽입니다(위치는 원래 방향 기준으로 저장)',
  rotated_text: '기울어진 글자가 있습니다 — 읽는 순서가 보이는 것과 다를 수 있습니다',
  hyphenation: '줄 끝 하이픈이 있습니다 — 단어가 나뉘어 있을 수 있습니다',
  possible_columns: '여러 단(column)일 수 있습니다 — 읽는 순서를 확인하세요',
};
export const ANCHOR_ERROR: Record<string, string> = {
  quote_not_found: '선택한 문장이 이 쪽의 추출 텍스트에 없습니다',
  ambiguous: '같은 문장이 이 쪽에 여러 번 있습니다 — 더 길게 선택하세요',
  no_text: '이 쪽에는 텍스트가 없어 위치를 확정할 수 없습니다',
  failed: '추출에 실패한 PDF라 위치를 확정할 수 없습니다',
  not_extracted: '먼저 텍스트를 추출하세요',
};
