# PW-020 — Mock AI·스트리밍 UI — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_020_0001_ai_requests.sql`
  - job intent에 `ask_selection`을 더한다(질문은 원고를 바꾸지 않는다).
  - `job_events`: 실행이 보고한 진행(`status`/`delta`/`answer_done`/`proposal`/`no_change`/`error`). job마다 번호(seq)를 매기고, 불변이다.
- `packages/providers/src/mock/index.ts`(새 파일)
  - `SelectionProvider` 인터페이스(`answer` 스트림, `revise`)와 결정론적 오프라인 mock.
  - 답변은 "[MOCK] … 실제 AI가 원고를 읽고 판단한 결과가 아닙니다"라고 말하고, 몇 단어씩 나눠 보낸다(`chunkDelayMs`).
  - 수정은 고정 규칙만 쓴다: 띄어쓰기, 반복 단어, 군더더기 표현. 숫자·atom·mark는 그대로 둔다. 비게 되는 text 항목은 빼고 보낸다.
  - `label: 'MOCK'`.
- `apps/api/src/events/index.ts`(새 파일)
  - `POST …/documents/:id/ai-requests`: 선택 요청을 job으로 만든다. 새 요청은 201, 같은 key의 재전송은 200, 같은 key로 다른 요청을 보내면 409.
  - `GET …/jobs/:jobId/events`: SSE.
    - 이벤트 id는 seq다. `Last-Event-ID`나 `?after=`로 이어 읽는다.
    - job 상태가 바뀌면 `job`을, 끝나면 `end{status,last_error}`를 보낸다.
    - 연결이 끊기면 이 스트림만 멈춘다. job은 취소하지 않는다.
    - 서버를 닫을 때 열린 스트림을 끝낸다.
    - 응답 헤더: `no-store`, `nosniff`.
- `apps/web/src/features/chat/`(새 폴더)
  - `stream-state.ts`: 서버 이벤트만으로 화면 상태를 만든다.
    - 상태: 대기 / 작업 중 / 답변 작성 중 / 답변 완료 / 제안 준비됨(아직 적용 안 됨) / 적용됨 / 거절 / STALE / 검사 실패 / 변경 없음 / 실패 / 취소
    - 다시 받은 번호 이벤트는 무시한다. `job`/`end`는 번호 검사를 하지 않는다.
  - `JobStream.tsx`
    - 이 원고의 AI 작업 목록: 이번 화면에서 만든 것과, 이전 방문의 최근 5개.
    - 각 작업을 EventSource로 읽는다. 끊기면 자동으로 다시 연결하고, 포기하면 "다시 연결" 버튼을 보여 준다.
    - "취소" 버튼을 둔다.
    - `MockBadge`: "MOCK · 실제 AI 아님".
- 범위 밖(RFC-007 부록)
  - `packages/domain/src/ai/index.ts`(새 파일): `requestSelectionAi`. 한 트랜잭션에서 다음을 한다.
    - (paper, key) advisory lock
    - 같은 key 재사용 판정(`request_hash`)
    - RFC-003 gate: 개요 승인 전 rewrite 403
    - selection handle 생성(서버가 저장본에서 다시 계산)
    - 편집 요청에 보이는 글자가 있는지 확인
    - job 등록
  - `packages/domain/src/jobs/index.ts`
    - `JOB_INTENTS`에 `ask_selection`
    - `appendJobEvent`: 현재 fencing token만 쓸 수 있다.
    - `appendJobEventIn`(완료 트랜잭션 안), `listJobEvents`
  - `packages/domain/src/proposals/index.ts`
    - `createProposalIn`: 호출자 트랜잭션 안에서 만든다.
    - `selectionSlice`: AI가 받는 선택 내용. text 항목과 `preserve_atom`.
    - `approvedOutline` export
  - `apps/worker/src/selection/index.ts`(새 파일): ask/revise handler.
    - 모든 보고는 fencing을 확인한다.
    - 마지막 이벤트와 proposal은 job 완료 트랜잭션 안에서 쓴다.
    - proposal origin은 `worker:provider.mock`이다.
  - `apps/worker/src/local/index.ts`(새 파일): `runOnce`, `startLocalWorker`. 한 프로세스 안에서 outbox → processDelivery를 돌리고, 주기적으로 recoverJobs를 부른다.
  - `apps/worker/src/main.ts`, `apps/worker/package.json`의 `dev` 스크립트: 개인 설치용 worker 실행.
  - `packages/providers/src/index.ts`: mock 모듈 export.
  - `apps/api/src/server.ts`: `registerAiRoutes`, `eventPollMs` 옵션.
  - `apps/web/src/editor/ManuscriptEditor.tsx`
    - 선택 요청을 `ai-requests`로 보낸다(같은 key로 한 번 재전송).
    - `JobStreams`를 둔다.
    - 제안 목록과 작업 상태를 서로 갱신한다.
  - `apps/web/src/features/diff/ProposalPanel.tsx`
    - mock 제안에 MOCK 배지를 단다. 설명 머리말을 "설명(MOCK)"으로 바꾼다.
    - `onChanged`
  - `apps/web/src/app/styles.css`
  - `tests/e2e/manual-paper/harness.ts`: `startHarness({ worker })`. mock worker를 같은 프로세스에서 돌린다.
- 시험(`tests/tasks/PW-020/`)
  - `mock.test.ts` 6
  - `stream-state.test.ts` 5
  - `ai-requests.int.test.ts` 12
  - `stream.e2e.ts` 4

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-020-A / TST-020A 답변 스트림·proposal 준비·적용 전 상태가 웹에서 구분된다 | 통합: ask → `status`(mock, MOCK)·`delta` 여러 개·`answer_done`. 원고 head는 그대로이고 proposal도 없다 |
| | 통합: concise → PENDING proposal(`worker:provider.mock`). head는 그대로다(준비 ≠ 적용) |
| | 통합: 고칠 것이 없으면 `no_change`. 늦은 답이면 STALE proposal |
| | 통합: SSE가 저장된 이벤트를 순서대로 보내고 `end`로 끝난다. `Last-Event-ID`로 이어 읽는다. 다른 owner는 404, 미로그인은 401 |
| | unit(stream-state): answering → answered, proposal_ready → applied/rejected/stale. 다시 받은 이벤트는 무시한다 |
| | 브라우저: "답변 작성 중…" → "답변 완료 — 원고는 바뀌지 않음". "수정 제안 준비됨 — 아직 원고에 적용되지 않음" → 적용 → "수정 제안 적용됨 — 원고에 반영" |
| REQ-020-B / TST-020B 연결 종료를 취소로 처리하지 않고, mock을 실제 응답으로 표시하지 않는다 | 통합: 답변 중 스트림을 닫아도 job은 SUCCEEDED이고, 새 스트림이 전부 읽는다 |
| | 통합: 취소하면 실행이 다음 보고에서 멈춘다(`lost_lease`). `answer_done`도 proposal도 없고, 스트림은 `end CANCELLED`로 끝난다. 다른 job은 영향이 없다 |
| | 통합: 취소된 revise는 proposal을 남기지 않는다 |
| | 통합: 이벤트는 불변이고, 이전 fencing token으로는 쓸 수 없다 |
| | unit: mock은 늘 `label: 'MOCK'`이고 답변은 "[MOCK]"으로 시작한다. status 이벤트 전에는 label이 없다(실제로도 mock으로도 가정하지 않는다) |
| | 브라우저: 답변·제안 모두 MOCK 배지가 붙는다. 답변 중 새로고침해도 SUCCEEDED이고 전체 답변이 보인다. "취소" → "취소됨 — 결과 없음", DB CANCELLED, `answer_done` 없음 |

## RED → GREEN
- RED: 구현 전에 모듈이 없어 unit·통합이 실패했다(`red.log`).
- 개발 중 브라우저 시험에서 찾은 결함 1건(고침): EventSource는 id 없는 메시지(`end`)에도 마지막 id를 붙여 준다. 그래서 화면이 `end`를 중복으로 버렸고 "취소됨"으로 바뀌지 않았다. `job`/`end`는 번호 검사를 하지 않도록 고쳤고 unit 회귀 시험을 추가했다.
- mutation(`mutation.log`): 11종 모두 탐지했다.
  - 연결 종료 시 취소
  - fencing 없는 이벤트 추가
  - 완료 전 proposal 생성
  - 개요 승인 전 rewrite
  - 다른 요청에 key 재사용
  - `end`를 중복으로 버림
  - 답변 완료를 구분하지 않음
  - 준비를 적용으로 표시
  - mock label 제거
  - 제안 패널 MOCK 배지 제거
  - 화면을 떠나면 취소
- "연결 종료 시 취소" mutation의 처음 두 버전은 살아남았다. 시험이 약해서가 아니라 mutation이 동작하지 않았기 때문이다.
  - 첫 번째: `req.raw` 'close'는 handler 전에 이미 발생한다.
  - 두 번째: 직접 UPDATE가 jobs 제약에 막혀 조용히 실패했다.
  - 실제 `cancelJob`으로 바꾸자 탐지됐다.
  - 이 과정에서 쓸모없던 `req.raw` 'close' listener를 지웠다. 끊김 감지는 `res` 'close'로 하며, 실제로 동작함을 확인했다.
- GREEN: unit 11, 통합 12, 브라우저 4.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`).
  - unit 156, integration 183, contracts 15, e2e 65, spikes 70
  - typecheck·lint, evals/pack PASS
  - 기존 PW-016/017 브라우저 시험은 worker 없는 harness에서 그대로 통과한다. 요청은 job으로 등록되고 QUEUED로 남는다.

## 보안·과학적 실패 경로
- AI는 정본을 바꾸지 못한다.
  - 답변은 이벤트로만 남는다.
  - 수정은 PW-017의 proposal(전체 문단 검사, STALE, 사용자 적용)로만 남는다.
  - proposal은 job 완료 트랜잭션 안에서 fencing token을 확인한 뒤에만 생긴다. 취소되거나 다른 worker에 넘어간 실행은 아무것도 남기지 못한다.
- 브라우저 연결은 job 상태에 영향이 없다. 취소는 owner의 명시적 API(`cancel`)뿐이다.
- MOCK 표시
  - provider label은 서버 실행이 기록한 이벤트(`status`, `answer_done`, `proposal`)에서 오고, proposal origin(`worker:provider.mock`)에서도 확인된다.
  - 화면은 label이 MOCK이면 배지를 단다. label을 모르면 어떤 출처도 주장하지 않는다.
  - mock 답변 본문도 스스로 mock이라고 말한다.
- 실제 provider는 연결되지 않았다(RFC-004 admission 전). `selectProvider`는 mock 외에는 거부한다.
- SSE는 owner 범위의 paperScoped route이고, 이벤트 데이터는 64 KB 이하의 JSON만 허용한다.

## 미실행 / 남은 위험
- 실제 Claude Code/Codex provider 응답: blocked/not_run(admission·사용자 승인 전, P03).
- SSE는 DB를 250 ms마다 조회한다. 동시에 여는 스트림이 많으면 부하가 생긴다. 개인 설치 기준으로는 충분하다. LISTEN/NOTIFY는 필요할 때 도입한다.
- 연결 수: HTTP/1.1에서 같은 출처의 연결은 6개로 제한된다. 진행 중인 작업 스트림이 많으면 다른 요청이 막힐 수 있다. 끝난 작업은 스트림을 닫는다.
- 프록시 버퍼링: 배포에서 reverse proxy를 쓰면 버퍼링을 꺼야 한다(`x-accel-buffering: no` 헤더를 보낸다). P07에서 확인한다.
- 화면을 떠난 뒤 다른 탭의 실시간 알림은 없다. 다시 열면 최근 작업 5개를 다시 읽는다.
- worker 상시 실행: `apps/worker` `dev` 스크립트로 따로 띄운다. 통합 실행 스크립트·서비스 등록은 P07에서 한다.

## 다음
PW-021: 버전 비교·Undo·기본 가져오기

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 1, minor 1, nit 4).
- 문제없다고 확인된 것
  - 취소·lease 상실·중복 실행은 정본에 영향을 남기지 않는다.
  - SSE 순서·종료 경쟁·재개·owner 범위·자원 정리가 맞다.
  - 요청 멱등성이 지켜진다.
  - mock이 실제 응답처럼 보이는 경로가 없다.
  - PW-013/017·RFC-003 보장이 약해지지 않았다.

| 지적 | 조치 |
|---|---|
| **MAJOR 재시도된 답변이 실패한 실행의 조각 + 새 답변 전체를 이어 붙여 "답변 완료"로 표시**<br>실패 실행의 delta가 남고, 다음 실행이 같은 job에 이어 쓴다 | 각 실행의 `status` 이벤트에 `run`(시도 번호)을 기록한다. 화면은 새 run이 시작되면 답변을 비우고 다시 시작한다. 두 실행은 끼어들 수 없다: 이전 토큰은 append가 거부된다. 통합(첫 실행이 2조각 뒤 실패 → 재시도 → run 1·2, 두 번째 답변에 [MOCK] 머리말 1회)과 unit(이어 붙이지 않음) 회귀 시험 |
| minor 취소·실패한 답변의 조각이 "취소됨 — 결과 없음" 아래 결과처럼 보임 | 끝나지 않은 실행의 텍스트는 접힌 "중단된 부분 응답(결과 아님)"으로만 보인다(`partialAnswer`). unit 시험 |
| nit WAITING_*에서 스트림이 끝나 다시 이어지지 않음 | WAITING_*에서는 스트림을 열어 둔다. 화면은 "대기 중(외부 조건)"을 보이고 취소할 수 있다. 통합 시험: 스트림은 `end` 없이 rotate로만 닫힌다 |
| nit 열린 스트림이 세션을 다시 확인하지 않음 | 60초(설정 `eventStreamMaxMs`)마다 `rotate`를 보내고 닫는다. 브라우저는 Last-Event-ID로 다시 연결하고, 이때 인증을 다시 거친다. 로그아웃 뒤 재연결은 401이다. 화면은 rotate 뒤 재연결을 "끊김"으로 표시하지 않는다. 통합 시험 |
| nit 스트림마다 초당 4회 DB 조회 | 개인 설치 기준으로 유지한다. 남은 위험에 적었다(LISTEN/NOTIFY는 필요할 때 도입) |
| nit 재시도 대기 중에도 "답변 작성 중…" | `job` 이벤트의 QUEUED(실행 뒤)는 "대기 중: 다시 시도 대기"로 표시하고, 조각은 부분 응답으로만 보인다. unit 시험 |

- mutation(`mutation-review.log`): 5종 모두 탐지했다.
  - 재시도 이어 붙이기, 조각을 결과로 표시, run 번호 없음, WAITING에서 종료, rotate 없음
  - "WAITING에서 종료"는 처음에 살아남았다. 시험이 첫 `job` 이벤트에서 읽기를 멈췄기 때문이다. 닫힐 때까지 읽도록 고친 뒤 탐지했다.
- 실행
  - PW-020: unit 15, 통합 15, 브라우저 4
  - `pnpm test` exit 0(`pnpm-test-review.log`)
    - unit 160, integration 186, contracts 15, e2e 65, spikes 70

## 재리뷰 결과 (2026-10-09)
- 결론: approve. 모든 지적이 고쳐졌고 회귀는 없다. 리뷰어가 probe R1·R2를 다시 실행해 확인했다.
- nit 2건 반영
  - **run 번호 없는(이전에 저장된) status 이벤트**
    - 문제: 재시도해도 답변이 초기화되지 않았다.
    - 조치: 실행마다 status는 정확히 하나이고 맨 먼저 오므로, 모든 status에서 답변을 비운다. unit 시험을 추가했다.
  - **로그아웃 뒤 "연결 끊김 · 다시 연결"만 보임**
    - 문제: 실제 원인이 가려졌다.
    - 조치: 브라우저가 재연결을 포기하면 세션을 확인한다. 401이면 "로그인이 필요합니다 — 다시 로그인하면 진행을 이어서 볼 수 있습니다(작업은 계속됨)"를 보인다.
- 실행
  - PW-020 unit 16, 브라우저 4
  - typecheck·lint 통과
  - 웹 파일만 바뀌어 전체 `pnpm test`는 다음 Task 커밋에서 함께 실행한다.
