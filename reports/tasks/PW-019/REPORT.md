# PW-019 — 인용·그림/표 교차참조 노드 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `packages/editor-core/src/references/index.ts` (새 파일, 브라우저·서버 공용)
  - 인용 라벨
    - 번호식: 처음 나온 순서. 반복은 같은 번호.
    - 저자-연도식: 같은 저자·연도는 a/b. 2인 "A & B", 3인 이상 "et al.".
    - locator(쪽 등)를 붙인다.
  - 참고문헌: 저장된 메타데이터로만 만든다. 번호식은 출현 순, 저자-연도식은 알파벳 순.
  - 그림/표 번호: 사용자가 정한 순서, 종류별.
  - 모르는 id는 번호가 없다(`[?]`, `[그림/표 없음]`). 그런 id는 따로 보고한다.
  - `referenceOccurrences`: 저장된 문서 JSON에서 출현 순서를 뽑는다.
- `db/migrations/pw_019_0001_references_figures.sql`
  - 논문의 `citation_style`
  - `figure_objects`: 안정 id, 종류, 제목, 순서. 삭제 대신 보관. 정체·종류는 불변.
- 범위 밖(RFC-007 부록)
  - `packages/domain/src/references/index.ts`
    - 문헌 생성(구조화된 필드만, 모르는 필드·자유 서지 문자열 거부, CSL-JSON 불변 revision, `source=manual`)
    - 목록, 그림/표 생성·순서 변경, 인용 형식
    - 저장된 head의 라벨·참고문헌·미해결 계산(`renderReferences`)
  - `apps/api/src/references/index.ts`
    - `GET/POST …/references`
    - `GET/POST …/figures`, `POST …/figures/order`
    - `GET/POST …/citation-style`
    - `GET …/documents/:id/references-render`
  - `apps/api/src/server.ts`
  - `packages/editor-core/src/index.ts`: references export
  - `tests/tasks/PW-012/browser-parity.int.test.ts`: editor-core 하위 폴더도 브라우저에 제공한다. references 폴더 추가 때문에 깨졌던 것을 고쳤다.
  - `apps/web/src/editor/ManuscriptEditor.tsx`: 라벨 extension, 패널
  - `styles.css`
- `apps/web/src/features/references/`
  - `reference-labels.ts`: atom에 계산된 라벨을 decoration 속성으로 표시한다. 미해결이면 빨간 물결.
  - `ReferencesPanel.tsx`: 인용 형식, 문헌 목록·추가, "인용 넣기"(쪽/위치), 그림·표 목록·순서·추가·"참조 넣기", 미해결 경고, 참고문헌 미리보기
- 시험(`tests/tasks/PW-019/`)
  - `numbering.test.ts` 8
  - `references.int.test.ts` 7
  - `references.e2e.ts` 2

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-019-A / TST-019A 그림 순서·인용 스타일 변경 후 번호 일관 재계산 | unit 8: 출현 순 번호, 스타일 전환, a/b, 그림 순서 변경, 모르는 그림 |
| | 통합: 저장된 문서에서 스타일·순서를 바꾸면 라벨·참고문헌이 같이 바뀜 |
| | 브라우저: 실제 삽입 → [1][2], Figure 2 → 저자-연도 전환 → 순서 변경 → Figure 1. 저장 JSON에는 id만 있다 |
| REQ-019-B / TST-019B LLM 서지 문자열·없는 reference id가 확정 인용으로 저장되지 않음 | 통합: 자유 서지 문자열·모르는 필드·DOI URL·문자열 저자 거부 |
| | 통합: 다른 논문의 문헌·없는 id → `[?]`, 참고문헌 제외 |
| | 통합: AI 제안이 인용을 추가하면 CHECK_FAILED |
| | 브라우저: 붙여넣은 모르는 인용 → [?]·경고·참고문헌 제외, 자유 서지 문자열 API 거부 |

- 저장 정책
  - 모르는 id의 인용은 원고에서 지우지 않는다(붙여넣기·가져오기 내용 보존).
  - 대신 "확정 인용"으로 쓰이지 않는다. 번호가 없고, 참고문헌에서 빠지고, 경고와 미해결 목록에 나온다.
  - 제출판 확정(P07)은 미해결이 있으면 막아야 한다.

## RED → GREEN
- RED
  - unit(구현 전): 모듈 없음(`red.log`)
  - 나머지는 mutation 7개 모두 탐지(`mutation.log`)
    - 번호식을 알파벳 순으로, 모르는 문헌에 라벨, 모르는 문헌을 참고문헌에
    - 그림 순서 무시, a/b 없음, 자유 서지 필드 허용, 라벨이 문헌·형식 무시
- GREEN: unit 8, 통합 7, 브라우저 2
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - unit 143, integration 170, contracts 15, e2e 61, spikes 70
  - typecheck·lint, evals/pack PASS
- 회귀 발견 2건(고침)
  - editor-core 하위 폴더를 브라우저 parity 시험이 제공하지 않아 실패했다.
  - 라벨 CSS(`font-size: 0`)가 인용 atom 높이를 0으로 만들어 클릭할 수 없었다(PW-016 시험). `display: inline-block`으로 고쳤다.

## 보안·과학적 실패 경로
- 참고문헌 문자열은 저장하지 않는다. 언제나 구조화된 메타데이터(불변 CSL-JSON revision)로 계산한다.
- AI 작업에는 문헌을 만드는 경로가 없다(owner 세션 API만).
- 다른 owner는 문헌·그림 API에 접근할 수 없다(404).

## 미실행 / 남은 위험
- **CSL/citeproc 미사용.** spec 10의 "고정된 citeproc/CSL 버전"은 PW-056(export)에서 버전을 고정해 도입한다. 지금은 내장 결정론적 형식(`pw-builtin-1`)이며, 학술지 형식과 다를 수 있다.
- 문헌 검색·DOI 조회·가져오기는 P04(PW-031~033)에서 한다. 지금은 수동 입력만 된다.
- 연속 인용 묶기([1, 2], [1–3])는 하지 않는다.
- 그림 파일·캡션·패널은 P04(PW-036)에서 한다.
- 문헌을 논문에서 빼는 UI는 없다. DB는 `removed_at`으로 지원한다.

## 다음
PW-020: Mock AI·스트리밍 UI

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: approve with follow-ups(minor 2, nit 다수).
- 문제없다고 확인된 것
  - 번호·a/b 계산이 결정론적이다.
  - 모르는 id에는 번호가 없고 참고문헌에서 빠진다.
  - 서지 문자열은 저장하지 않는다.
  - owner 격리가 지켜진다.

| 지적 | 조치 |
|---|---|
| **minor-1 snapshot이 인용 형식·그림 순서를 고정하지 않음**<br>나중에 형식이나 순서를 바꾸면 옛 snapshot의 번호가 달라진다 | `pw_019_0002`가 다음을 추가한다: `paper_snapshots.citation_style`·`style_version`, 불변 `snapshot_figures`(봉인 후 추가 불가). `createSnapshot`이 둘을 함께 기록하고, `getSnapshot`이 `figures`를 돌려준다. 통합 회귀 시험: 형식·순서를 바꿔도 snapshot은 그대로이고, 수정·추가는 거부된다 |
| **minor-2 미해결 인용이 원고에 남음**<br>제출판·AI 작성에서 막는 조건이 없다 | RFC-008(accepted, 위임)로 요구사항을 추가했다. PW-058: 미해결 인용·그림 참조가 있으면 제출판 확정을 거부한다. PW-042: AI 문단은 이 논문의 문헌 id만 인용할 수 있다. 두 Task 문서에 조건을 적었다 |
| nit: 같은 저자의 연도 없는 문헌이 `n.d.a`로 표시됨 | `n.d.-a`(APA). 참고문헌 연도 정규식도 고쳤다. unit 시험과 mutation(하이픈 제거)으로 탐지를 확인했다 |
| nit: BMP 밖 이름의 머리글자가 반쪽 surrogate가 됨 | 코드 포인트 단위로 자른다. unit 시험 |
| nit: 라벨이 `font-size: 0`이라 화면 읽기 프로그램이 읽지 못함 | decoration에 `aria-label`을 단다 |
| nit: 다른 곳에서 문헌을 바꾸면 패널이 갱신되지 않음 | head가 바뀌거나 창에 focus가 오면 다시 읽고, "새로고침" 버튼을 둔다 |

- 실행
  - PW-019: unit 10, 통합 8
  - `pnpm test` exit 0(`pnpm-test-review.log`)
    - unit 145, integration 171, contracts 15, e2e 61, spikes 70
  - 작업 중인 PW-020 파일은 이 실행에서 제외했다.
