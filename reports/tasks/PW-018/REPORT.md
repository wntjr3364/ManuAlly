# PW-018 — 하이라이트·코멘트 anchor — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_018_0001_comments.sql`
  - `comment_threads`: 상태만 OPEN↔RESOLVED로 바뀐다. DB 시계 기록, 감사 기록, 삭제 금지
  - `comment_anchors`: 추가만 가능하다. 가장 최근 것이 현재 anchor다. thread와 같은 문서여야 한다.
  - `comment_messages`: 추가만 가능하다.
- `packages/domain/src/comments/`
  - `anchor.ts`
    - anchor는 블록 id, 위치, 인용, 앞뒤 32자로 이루어진다.
    - 현재 head에 대해 확실할 때만 ATTACHED, 아니면 ORPHANED다.
  - `index.ts`: thread 생성(서버가 선택 검증), 답글, 해결/다시 열기, 다시 연결, 목록(head 기준 위치 계산)
- `apps/api/src/comments/index.ts`
  - `GET/POST …/documents/:id/comments`
  - `POST …/comments/:id/{messages,resolve,reopen,anchor}`
- `apps/web/src/features/comments/`
  - `comment-highlights.ts`: 열린, 붙어 있는 코멘트를 강조한다. 편집을 따라 이동한다.
  - `CommentsPanel.tsx`: 목록, 위치 상태, 답글, 해결/다시 열기, "선택한 곳에 다시 연결"
- 범위 밖 연결(RFC-007 부록)
  - `apps/api/src/server.ts`
  - `apps/web/src/editor/ManuscriptEditor.tsx`
    - 코멘트 패널, 강조 extension
    - 코멘트 보내기와 다시 연결용 선택 고정
    - 개발용 `moveBlock` 시험 handle
  - `SelectionChat.tsx`: "코멘트" 동작
  - `styles.css`
  - `packages/domain/src/proposals/index.ts`: `verifySelection`을 공용으로 사용(PW-017 커밋에 포함)
- 시험(`tests/tasks/PW-018/`)
  - `anchor.test.ts` 9
  - `comments.int.test.ts` 6
  - `comments.e2e.ts` 3

## 위치 규칙 (spec 04 "편집 transaction으로 확실히 추적 가능한 경우 이동, 텍스트 삭제/애매한 재배치는 ORPHANED")
- **같은 블록 id가 없으면** ORPHANED(BLOCK_MISSING)
  - 같은 문장이 다른 문단에 있어도 옮기지 않는다.
- **블록에 인용 문장이 없으면** ORPHANED(TEXT_CHANGED)
- **인용 문장이 여러 곳에 있으면** 앞뒤 문맥이 기록과 같은 곳이 정확히 하나일 때만 그곳에 붙인다.
  - 하나도 없거나 둘 이상이면 ORPHANED(AMBIGUOUS)다.
  - 원래 위치에 있어도 같은 후보가 또 있으면 붙이지 않는다.
- **인용 문장이 한 번만 있으면** 그곳에 붙인다. 문단 이동이나 앞쪽의 작은 편집이 이 경우다.
- **기록 방식**
  - anchor는 바뀌지 않고, 매번 현재 head에 대해 계산한다.
  - 다시 연결하면 새 anchor를 추가하고 이전 anchor는 남긴다.
- **화면 강조**
  - 화면이 저장된 head와 같을 때 서버 위치로 놓는다.
  - 그 뒤 편집은 transaction mapping으로 따라간다.
  - 새 head가 저장되면 서버에서 다시 받는다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-018-A / TST-018A 문단 이동·작은 편집 뒤 확실한 위치 유지 | unit: 문단 이동, 앞쪽 편집, 앞쪽 인용 atom |
| | 통합: 이동 + 편집 뒤 ATTACHED(moved) |
| | 브라우저: 문단 이동(끌어 놓기와 같은 transaction) + 앞쪽 입력 뒤 강조와 "위치 이동됨" |
| REQ-018-B / TST-018B 삭제·동일 후보 여럿 → 엉뚱한 문장에 붙이지 않음 | unit: 변경·삭제, 블록 삭제(다른 문단의 같은 문장), 같은 후보 2개 |
| | 통합: 세 경우의 ORPHANED 이유 |
| | 브라우저: 문장 삭제 → 위치 잃음, 같은 문장 두 번 → AMBIGUOUS, 다시 연결 |
| 해결·다시 열기·답글, 제안 거절과 독립 | 통합: 감사 OPEN→RESOLVED→OPEN, 제안 거절 뒤 코멘트 유지 |
| | 브라우저: 해결하면 강조 없음, 다시 열면 강조 |
| 불변·격리 | 통합: 메시지·anchor 수정 거부, thread 상태 외 변경·삭제 거부, 다른 owner 404 |

## RED → GREEN
- RED
  - unit(구현 전): 모듈 없음(`red.log`)
  - 나머지는 mutation으로 보였다(`mutation.log`, 7개 모두 탐지)
    - 애매하면 첫 후보에 붙임(unit·브라우저)
    - 블록이 없으면 다른 문단을 검색
    - 문맥 무시
    - 바뀐 문장을 옛 위치에 붙임
    - 해결된 코멘트 강조
    - thread 상태 외 변경 허용
- GREEN: unit 9, 통합 6, 브라우저 3
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - unit 129, integration 162, contracts 15, e2e 59, spikes 70
  - typecheck·lint, evals/pack PASS

## 같은 커밋에 포함한 PW-017 재리뷰 반영
- 결론 approve, minor 1·nit 1
- minor: 결과를 모르는 적용을 다시 보냈는데 401 등 4xx로 거절되면, "적용 안 됨"으로 처리해 편집기를 풀었다.
  - 이제는 제안 상태를 직접 읽는다.
    - 적용됐고 아직 head면 그 결과를 화면에 올린다.
    - 적용되지 않았으면 잠금을 푼다.
    - 읽을 수 없으면 잠금과 key를 유지한다.
  - 브라우저 시험을 추가했다. 이전 패널 코드에서 실패한다(`reports/tasks/PW-017/rereview-red.log`).
- nit: 적용 중이거나 결과를 모르는 동안 저장 상태는 "수정 제안 적용 확인 중 — 편집 잠김"이다.

## 보안·과학적 실패 경로
- 코멘트는 원고를 바꾸지 않는다.
- 코멘트 위치가 불확실하면 비슷한 문장에 붙이지 않고, ORPHANED로 이유와 함께 보인다.
- 시작 선택은 서버가 저장된 revision에서 다시 계산해 검증한다(위조된 위치·hash 거부).
- 메시지와 anchor는 고칠 수 없다. 해결 상태 변경은 감사 기록에 남는다.

## 미실행 / 남은 위험
- PDF highlight(별도 좌표, P04 PW-035)는 이 Task 범위가 아니다.
- 코멘트 실시간 공유(다른 탭)는 없다. 저장된 head가 바뀔 때 다시 읽는다.
- 앞뒤 문맥 32자는 경험값이다. 아주 짧고 흔한 인용(예: "p < 0.05")은 자주 AMBIGUOUS가 될 수 있다. 의도된 보수적 동작이다.
- 문단을 나누거나 합치면 블록 id가 바뀔 수 있다(PW-014 규칙). 그러면 BLOCK_MISSING이 되고 다시 연결해야 한다.

## 다음
PW-019: 인용·그림 교차참조 노드
