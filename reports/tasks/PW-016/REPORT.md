# PW-016 — 선택 도구·짧은 채팅 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- 새 파일 (`apps/web/src/features/selection-chat/`)
  - `target.ts`: 선택이 무엇을 가리키는지 계산
    - 한 문단(또는 제목) 안의 비어 있지 않은 범위만 대상이다.
    - 빈 선택, 여러 문단, 전체 선택은 대상이 아니다.
  - `request.ts`: 선택 요청
    - 요청 종류는 질문·문법·간결화·학술적 재작성이다.
    - 저장된 revision 기준으로 editor-core `SelectionSnapshot`을 고정한다.
    - 지시 검사: 2000자 이하, 질문은 내용 필수.
    - RFC-003에 따라 개요 승인 전에는 질문·문법·간결화만 허용한다.
  - `frozen-highlight.ts`: popup에 초점이 있는 동안 고정된 범위를 표시하는 decoration. 표시만 하고 요청 내용은 바꾸지 않는다.
  - `SelectionChat.tsx`: 떠 있는 선택 도구, 지시 popup, 요청 목록
- 범위 밖 연결(RFC-007 부록)
  - `apps/web/src/editor/ManuscriptEditor.tsx`
    - extension 추가, SelectionChat 표시
    - 개발용 시험 handle `selectText` 추가
  - `ManuscriptTab.tsx`, `PaperPage.tsx`: 개요 승인 여부 전달
  - `styles.css`
- 시험
  - `tests/tasks/PW-016/selection.test.ts` 8
  - `tests/tasks/PW-016/selection.e2e.ts` 5

## 동작
- **선택 도구**
  - 한 문단 안을 선택하면 선택 위에 도구가 뜬다(질문 / 문법 / 간결화 / 학술적 재작성).
  - 여러 문단이나 전체를 선택하면 "한 문단 안에서 선택하세요"만 보인다.
  - 커서만 있으면 도구가 없다.
- **요청 가능 조건**
  - 화면이 저장된 revision과 같을 때("저장됨")만 요청할 수 있다.
  - 그 전에는 버튼이 비활성이고 "저장된 뒤 요청할 수 있습니다"를 표시한다.
  - 그래서 고정된 선택은 항상 서버가 같은 hash로 다시 계산할 수 있는 revision을 가리킨다.
- **선택 고정**
  - 요청 종류를 고르는 순간 선택을 고정한다(block id, 블록 기준 위치, block hash, slice hash, 인용 문자열, 기준 revision).
  - 그 뒤에 지시를 입력하거나, 초점을 옮기거나, 편집기에서 다른 곳을 선택하거나, 문서가 바뀌어 다시 저장되어도 요청은 고정된 그대로다.
  - 기준이 달라졌는지는 서버가 판단한다(PW-017, STALE).
- **popup**
  - "대상: 문단 N · 선택 n자 “…”"와 허용 범위를 표시한다.
    - 수정 요청: "이 선택 범위만 바꾸는 제안 / diff 확인 후 적용"
    - 질문: "원고는 바뀌지 않습니다"
  - Enter는 보낸다. Shift+Enter는 줄바꿈이다. 한글 조합을 끝내는 Enter는 보내지 않는다.
  - Esc는 닫고, 고정된 범위를 다시 편집기 선택으로 돌린다.
- **키보드**
  - 편집기 안에서 Ctrl/Cmd+Shift+K를 누르면 선택 도구로 초점이 간다. Tab으로 이동하고 Enter로 연다.
  - 선택이 없거나 여러 문단이면 이유를 표시한다.
- **보내기**
  - 이 Task에서는 요청을 화면의 "선택 요청" 목록에 "준비됨(AI 연결 전)"으로 쌓는다.
  - 서버 제안(PW-017)과 mock AI(PW-020)가 이 요청을 받는다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-016-A / TST-016A 한국어 지시 입력 중 원래 선택 handle 유지 | e2e "Korean instruction…keeps the original selection and base revision"<br>- CDP 한글 조합으로 지시 입력<br>- 조합 중 Enter는 보내지지 않음<br>- popup이 열린 사이 문서 앞에 글이 들어가고 저장됨<br>- 요청의 base revision·위치·인용이 처음 그대로이고, 서버가 그 revision에서 계산한 snapshot과 같음 |
| | unit: 고정 snapshot = 서버 `snapshotSelection` 결과, 글자 중간 경계 거부 |
| REQ-016-B / TST-016B 초점 이동으로 범위 변경 없음, 선택 없음 → 전체 원고 암묵 대상 없음 | e2e "no selection is never the whole manuscript…": 커서만, 여러 문단, Ctrl+A, 단축키 |
| | e2e "moving focus does not change the frozen range; Esc…" |
| | e2e "keyboard only" |
| | e2e "requests wait for the stored revision; academic rewrite waits for an approved outline" |
| | unit: 대상 계산 4건, 요청 검사, RFC-003 허용 표 |

## RED → GREEN
- RED
  - unit(구현 전): 모듈 없음(`red.log`)
  - 브라우저(PW-016 이전 앱 코드): 5건 모두 실패(`red-e2e.log`)
- GREEN: unit 8/8, 브라우저 5/5
- mutation(`mutation.log`): 7개 모두 탐지(대조군 1개는 동작 변화 없음)
  - 조합 중 Enter로 보냄, 고정 base 대신 현재 head 사용
  - 저장 전 요청 허용, 승인 전 재작성 허용
  - 여러 문단을 대상으로 인정, 빈 선택을 대상으로 인정
  - Esc 후 선택 미복원(처음에는 살아남음 → 편집기 선택을 옮긴 뒤 Esc 하도록 시험을 강화한 뒤 탐지)
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - unit 113, integration 139, contracts 13, e2e 46, spikes 70
  - typecheck·lint, evals/pack PASS

## 보안·과학적 실패 경로
- 선택 없음, 여러 문단, 전체 선택은 AI 요청 대상이 되지 않는다. 전체 원고는 암묵적으로 보내지 않는다.
- 요청은 저장된 revision과 그 안의 정확한 범위만 가리킨다.
  - 화면이 저장되기 전에는 요청할 수 없다.
  - 서버는 같은 계산으로 검증한다(PW-017).
- 승인 전 학술적 재작성 금지는 화면에서도 막지만, 최종 판단은 서버가 한다(PW-017/020).

## 미실행 / 남은 위험
- 요청을 서버로 보내지 않는다(PW-017 제안, PW-020 mock AI에서 연결).
- 단축키 변경 설정이 없다(spec 04 "변경 가능"). 설정 화면은 이후 Task에서 만든다.
- 1366×768·1920×1080 해상도 시험은 PW-022에서 한다.
- 실제 한글 IME와 Firefox/Safari는 사용자 PC에서 확인해야 한다(PW-022).

## 다음
PW-017: 제안·CAS·원자 적용
