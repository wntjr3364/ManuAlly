# PW-022 — 선택편집 브라우저 gate — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `tests/e2e/editor/helpers.ts`(새 파일): gate 공용 단계
  - 로그인·새 원고
  - 끝에서부터 키보드로 선택(25 ms 간격, 브라우저 선택 확인)
  - 간결화 요청과 결과 대기
  - 저장된 head·AI 적용 이력 읽기
- `tests/tasks/PW-022/selection-gate.e2e.ts`(새 파일): gate 시험 8개
- 범위 밖 제품 수정(RFC-007 부록) — 이 gate가 찾은 결함
  - `apps/web/src/features/references/reference-labels.ts`: `setReferenceContext`는 내용이 바뀌었을 때만 transaction을 보낸다.
  - `apps/web/src/features/comments/comment-highlights.ts`: `setCommentRanges`도 같다.
- 브라우저 증거: `proposal-1366x768.png`, `proposal-1920x1080.png`, `versions-1366x768.png`, `versions-1920x1080.png`

## 이 gate가 찾은 결함 (고침)
- **증상:** 배경에서 다시 읽는 패널이 사용자의 선택 중 키 입력을 잃게 할 수 있었다.
- **원인:**
  - 참고문헌 패널은 창 focus와 저장마다 다시 읽고, 코멘트 패널은 저장마다 다시 읽는다.
  - 두 패널은 내용이 같아도 편집기에 transaction을 보냈다.
  - 그 transaction이 사용자가 Shift+화살표로 선택을 넓히는 중에 도착하면, 편집기가 이전 선택을 화면에 다시 써서 키 입력이 사라진다.
  - 자동 저장 직후 선택할 때 생길 수 있다.
  - 잘못된 범위로 요청이 가도 서버 검증이 막지만, 사용자가 고른 범위와 다른 범위가 요청된다.
- **조치:** 바뀐 것이 없으면 보내지 않는다.
- **회귀 시험 2개:** focus 재로딩, 자동 저장 후 재로딩. mutation 2종을 탐지했다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-022-A / TST-022A 1366×768·1920×1080에서 핵심 workflow와 키보드 조작 통과 | 두 해상도 각각에서 키보드만으로 진행한다 |
| | 단계: 입력 → Shift+화살표 선택 → Ctrl+Shift+K로 도구 모음 → Tab으로 "간결화" → Enter(지시 칸에 focus) → Enter → MOCK 제안 준비 → "적용"에 focus·Enter → 버전 탭에서 "되돌리기"에 focus·Enter → 원래 문장 |
| | 도구 모음·popup·제안 패널은 화면 너비 안에 있고, 가로 스크롤은 없다. 스크린샷 4장 |
| REQ-022-B / TST-022B 복제 문장·emoji·citation atom·멀티탭 충돌에서 잘못된 위치 변경이 1건도 승인되지 않음 | 복제 문장: "It was very clear. It was very clear."에서 두 번째만 바뀐다. DB의 AI 적용 이력 1건이 정확히 그 문단이다 |
| | emoji: 🧪·😀 뒤의 "very clear"가 정확히 그 글자 위치에서 바뀐다 |
| | citation atom: 인용 바로 앞 단어를 지워 인용이 다른 단어 뒤로 가는 제안은 CHECK_FAILED(`citation_positions`)로 적용할 수 없다. 인용을 포함하되 인용 위치가 그대로인 제안은 적용되고, 두 인용(같은 reference id)이 제자리에 남는다 |
| | 두 탭: A가 제안을 만든 뒤 B가 같은 문단을 저장하면, A의 적용은 거부된다(alert). DB는 B의 내용이고 AI 적용은 0건이다 |
| | 두 탭: A가 적용한 뒤 옛 head의 B가 입력하면, B는 "다른 곳에서 먼저 바뀐 원고"로 저장이 거부된다. DB는 A의 적용 결과 그대로다. AI 적용 이력은 정확히 1건, 기대한 문단이다 |
| | 배경 재로딩(focus·자동 저장)은 바뀐 것이 없으면 편집기에 transaction을 보내지 않는다 |

## RED → GREEN
- 첫 실행(구현 수정 전): 6개 중 3개 실패
  - 로그인 화면 대기 경쟁(시험 helper)
  - 인용 시나리오: 의도한 제안이 guard에 걸렸다. 이것이 올바른 거부여서, 거부 확인과 안전한 제안 적용으로 시험을 나눴다.
  - 두 탭 시나리오: 선택 중 키 입력이 사라졌다.
- 두 탭 시나리오 원인 조사
  - 다시 읽은 페이지 A에 focus가 돌아오지 않아(`bringToFront` 필요) ProseMirror가 DOM 선택을 쓰지 않았다. 시험 환경 문제다.
  - 배경 재로딩 transaction은 위의 제품 결함이다.
  - 그 뒤에도 키를 간격 없이 1 ms 이하로 연속 보내면 가끔 선택이 어긋났다.
    - 모든 keydown이 편집기에 도착하는 것은 로그로 확인했다.
    - 25 ms(초당 40타) 간격에서는 전체 gate 5회 반복 30/30 통과했다.
    - 사람 입력 속도에서는 재현되지 않는다. 남은 위험에 적었다.
- mutation(`mutation.log`): 제품 수정 2건을 되돌리면 각각 실패한다.
  - focus 시험은 참고문헌 쪽만 잡는다. 코멘트 쪽은 자동 저장 시험이 잡는다.
- GREEN: 전체 gate 8개 통과. 5회 반복 30/30(6개 시험 기준, 회귀 시험 2개 추가 전).
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - unit 179, integration 195, contracts 15, e2e 76, spikes 70

## 보안·과학적 실패 경로
- 이 gate는 "잘못된 위치 변경이 승인되지 않는다"를 DB 기준으로 감사한다. 시나리오마다 승인된 AI 적용 이력을 모두 읽어 기대 문단과 비교한다.
- 인용이 다른 단어 뒤로 옮겨지는 수정은 guard가 막는다. 근거 연결이 바뀌기 때문이다.

## 미실행 / 남은 위험 (manual evidence 필요)
- **실제 한글 IME·Firefox·Safari·macOS 키(Cmd).** 이 컨테이너는 Chromium만 있다. 한글 조합은 PW-015에서 CDP로만 시험했다. 사용자 PC에서 수동 확인이 필요하다.
- **기계 속도의 연속 키 입력.** 간격이 없으면 선택이 가끔 어긋난다. 사람 속도에서는 재현되지 않았다. 어긋나도 요청은 실제로 보이는 선택으로 고정되고, 서버가 저장본과 대조한다.
- **화면 배치(UX).**
  - 1366×768에서는 제안 패널이 첫 화면 아래에 있어 스크롤이 필요하다.
  - 선택 도구 모음은 선택한 줄과 떨어져 편집 영역 중간에 뜬다.
  - 기능은 정상이지만 P07 사용성 점검 대상이다.
- **다른 브라우저 탭 사이 실시간 알림 없음.** 충돌은 저장·적용 시점에 거부로 나타난다.

## 다음
P02 gate(`reports/phases/P02_GATE.md`) → P03(PW-023)
