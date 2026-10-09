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

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 1, minor 1, nit 4). 같은 커밋의 PW-017 재리뷰 반영분은 nit 1건 외 문제없음.
- 문제없다고 확인된 것
  - thread 상태 규칙
  - anchor와 문서의 연결(composite FK + trigger)
  - owner 격리, XSS 없음
  - 미저장 상태에서 코멘트 생성 차단
  - 강조 위치는 저장된 head일 때만 둔다
  - 문단 분할·병합·복사 시 ORPHANED 또는 새 id

| 지적 | 조치 |
|---|---|
| **MAJOR 지운 짧은 인용이 같은 문단 다른 문장의 같은 단어로 이동**<br>"effect" → "side effect"(P1). 복사본 1개면 붙고 2개면 AMBIGUOUS인 비일관성(P2) | "문단에 한 번만 있으면 붙임" 규칙을 없앴다. 문맥(앞뒤 32자)이 맞지 않으면 바로 앞 또는 뒤의 12자가 기록과 같은 후보가 정확히 하나일 때만 붙인다(한쪽만 편집된 경우). 증거가 없으면 ORPHANED. P1·P2 회귀 시험 |
| m1 인용 atom을 자리표시자로만 비교 → 다른 인용으로 바뀌어도 붙어 있음 | anchor에 인용 범위 안 atom의 정체(종류·reference id·locator)를 저장하고 비교한다. `pw_018_0002`가 `atoms` 열을 추가한다. 기존 anchor는 atom이 있으면 ORPHANED 쪽(안전)으로 판단한다. 회귀 시험 |
| nit: 문단 이동 시험이 시험용 transaction 사용 | 맞다. 편집기에 문단 이동 UI가 아직 없어, 끌어 놓기처럼 블록 id를 유지하는 transaction으로만 보였다. 문단 텍스트를 잘라 붙이면 새 블록 id가 되어 ORPHANED가 된다(남은 위험) |
| nit: 미저장 상태에서 해결·다시 열기하면 강조가 남음 | 열린 상태가 아닌 thread의 강조는 언제든 즉시 지운다. 브라우저 시험 |
| nit: thread guard가 이전 `state_changed_by`를 그대로 받아도 통과 | 바꾸지 않는다. 한 owner가 해결했다가 다시 여는 정상 흐름에서 같은 id가 된다. 누가 바꿨는지는 감사 기록의 actor(`pw.actor`)가 정확히 남긴다 |
| nit(PW-017): 첫 적용이 아직 진행 중이면 PENDING으로 읽고 풀 수 있음 | PENDING이면 1.5초 뒤 한 번 더 읽는다. 아주 느린 서버에서는 여전히 이론상 가능하다(남은 위험) |

- RED: 리뷰 전 anchor 코드에서 회귀 unit 3건 실패(`review-red.log`)
- 실행: PW-018 unit 12, 통합 6, 브라우저 3. PW-017 브라우저 7 회귀 통과. `pnpm test` exit 0(`pnpm-test-review.log`, 작업 중이던 PW-019 파일 포함): unit 140, integration 162, contracts 15, e2e 59, spikes 70

## 재리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 2, minor 1).
- P1·P2·P3와 문단 앞 단어 삽입(P7)은 의도대로 동작한다.

| 지적 | 조치 |
|---|---|
| **MAJOR-1 인용이 들어간 코멘트가 만들자마자 ORPHANED**<br>저장 후 jsonb가 키 순서를 바꿔 `JSON.stringify` 비교가 실패. unit은 DB를 거치지 않아 통과 | atom 비교를 editor-core `canonicalJson`(키 정렬)으로 바꿨다. DB를 거치는 통합 시험("인용을 포함한 코멘트가 만들자마자, 그리고 그대로 둔 뒤에도 ATTACHED")과 키 순서 unit 시험을 추가했다 |
| **MAJOR-2 평행한 문장(P4)에서 다른 문장에 붙음**<br>"In controls the number of cells … In mutants the number of cells …"에서 두 번째 문장을 지우면 첫 문장의 cells에 붙었다 | 코멘트를 만들 때 바로 앞·뒤 12자가 그 문단에서 유일했는지를 기록한다(`pw_018_0003`). 유일했던 쪽만 나중에 증거로 쓴다. P4는 ORPHANED. 유일한 쪽은 반대쪽이 편집돼도 계속 붙는다(시험) |
| m: 짧은 인용의 양쪽을 함께 고치면 ORPHANED(P5·P6) | 안전한 쪽(ORPHANED)으로 두고 남은 위험에 적는다. 사용자는 "선택한 곳에 다시 연결"로 복구한다 |
| nit: 기존 anchor는 마이그레이션 뒤 atom·near 기록이 없음 | 의도대로 안전한 쪽이다. atom이 있는 기존 anchor는 ORPHANED가 되고, near 증거 없이 전체 문맥으로만 붙는다 |

- RED: c50e55b의 코드에서 회귀 시험 3건 실패(`rereview-red.log`, unit 2·통합 1)
- 실행: PW-018 unit 14, 통합 7, 브라우저 3. 전체 `pnpm test`는 작업 중이던 PW-019 CSS 때문에 PW-016 브라우저 1건이 실패했다(`pnpm-test-rereview.log`). PW-018 변경과 무관하며 PW-019에서 고친다.
- 남은 위험(추가)
  - 짧은 인용의 앞뒤 12자 안을 모두 고치거나, 오타 수정과 문장부호 변경이 양쪽에 함께 있으면 코멘트가 ORPHANED가 된다.
  - 편집 transaction을 따라가는 화면 강조는 그대로 유지되지만, 서버 기준 상태는 ORPHANED로 보인다.
