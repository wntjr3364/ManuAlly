# PW-010 — 수동 Story·Outline 승인 — REPORT
Status: in_review (독립 리뷰 대기) / Phase: P01 / Requirement: REQ-010

## 변경 파일
- `db/migrations/pw_010_0001_story_outline.sql`
  - `story_revisions`, `outline_revisions`: 내용 불변, 상태는 정해진 방향으로만 변경, 삭제·TRUNCATE 금지
    - 허용 전이: DRAFT→IN_REVIEW→APPROVED→SUPERSEDED, DRAFT→APPROVED, IN_REVIEW→DRAFT
    - trigger `pw_revision_status_guard`가 위반 시 "immutable" 또는 "illegal status transition" 오류
  - 인덱스: 논문당 APPROVED는 1개(partial unique), 부모당 자식 1개(동시 저장 직렬화의 2차 방어)
  - `outline_nodes`, `outline_node_approvals`: 완전 불변(`pw_make_immutable`)
  - 복합 FK `(paper_id, id)`: 다른 논문의 story/outline/node 연결 금지
  - `paper_projects.active_story_revision_id` / `active_outline_revision_id`
    - 복합 FK
    - trigger: APPROVED가 아닌 revision을 가리키지 못함
  - `paper_snapshots.story_revision_id` / `outline_revision_id`: snapshot이 당시 활성 story/outline을 고정
- `packages/domain/src/outlines/index.ts`
  - 저장: brief/story 필드 schema(모르는 필드 422), 최신 revision을 parent로 지정해야 저장(CAS, 논문 행 잠금)
  - 승인: `intent`, 그리고 사용자가 본 `content_hash`가 정확히 일치해야 함
    - `approved_by`/`approved_at`/`status`를 body로 보내면 422
    - 승인자는 세션에서 결정
  - 필수 필드(brief.purpose, story.question, story.main_message)가 비면 422 `{missing}`
  - outline
    - 승인된 같은 논문의 story 위에서만 생성
    - node 검증: UUID, 중복, 부모 존재·순환, role, word budget
    - node 단위 선택 승인. 모든 node가 승인되면 revision APPROVED, active로 지정
    - 증거가 필요한데 없는 node는 422 `{evidence_missing}`
  - 활성 story가 바뀌면 이전 story 기반 outline은 승인 불가 409 `{reasons:['impact_review_required']}`. node 상태도 IMPACT_REVIEW_REQUIRED로 표시
  - `checkDraftGate`: AI 초안 요청 서버 gate
    - 차단 사유: story_not_approved / outline_not_active / node_not_found / node_not_approved / evidence_missing / impact_review_required
- `apps/api/src/routes/outlines/index.ts` (모든 route가 paper-scoped)
  - `GET/POST /story`, `/story/revisions[/:id[/approve]]`
  - `GET/POST /outline`, `/outline/revisions[/:id[/approve]]`
  - `POST /ai/draft-requests`: gate만 검사, 통과 시 202. job 생성은 PW-013, provider 호출은 P03
- 범위 밖 연결 파일(RFC-006 부록 기록)
  - `apps/api/src/server.ts`: route 등록 1줄
  - `packages/domain/src/papers/index.ts`: 응답 열 2개 추가
  - `packages/domain/src/revisions/index.ts`: snapshot에 story/outline 고정

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-010-A 지정한 revision만 승인, 관련 node가 생성 허용 상태 | TST-010A ×6: hash 불일치 409 / intent 없음 422 / approved_by 위조 422 / 승인자=세션; 새 revision은 승인 전까지 기존 승인본 유지, 승인 시 SUPERSEDED; stale parent 409, 필수 필드 누락 목록; node 선택 승인 → 전체 승인 시 active; 증거 없는 node 422; 미승인·타 논문 story 위 outline 422/404 | pass |
| REQ-010-B 미승인 개요 AI draft 서버 차단, 수동 입력 허용 | TST-010B ×4: 단계별 차단 사유 → 전체 승인 후 202; 새 story 승인 시 impact_review_required, 재기반·재승인 후 통과; story/outline 없이 노트·원고 저장 201; 승인본 내용 변경·상태 역행·삭제를 직접 SQL로 시도 → immutable/transition 오류 | pass |
| 보강 | 동시 story 저장 [201,409]; 잘못된 outline 6종 422(field 명시), 자식이 먼저 와도 저장; 미승인 revision을 active로 직접 SQL 지정 불가; snapshot이 당시 story/outline id 고정 | pass |

- RED: route 없음으로 9/10 실패(`red.log`)
- GREEN: 14/14(`green.log`)
- Mutation 3종 모두 탐지(각 1건 실패)
  - story hash 검사 제거
  - gate의 node 승인 검사 제거
  - story guard를 DELETE에만 적용
- 회귀: `pnpm test` exit 0
  - typecheck/lint 통과
  - unit 9, integration 52, contracts 6, e2e 1, spikes 70
  - evals PASS, pack-check PASS

## 보안·과학적 실패 경로
- 승인 위조: 클라이언트가 승인자·상태를 보낼 수 없다. hash가 다르면 승인하지 않는다(사용자가 본 내용과 다른 revision 승인 방지).
- 채팅의 모호한 "좋다"로는 승인되지 않는다. 승인은 explicit intent를 가진 전용 endpoint에서만 일어난다.
- AI gate는 서버에서 매 요청 DB 상태로 판정한다. 클라이언트 상태를 믿지 않는다.
- story가 바뀐 뒤 옛 outline으로 생성하는 경로를 차단한다(impact review).
- 수동 편집·메모는 gate를 거치지 않는다(constitution: 사용자 입력은 막지 않음).

## 미실행 / 남은 위험
- **웹 UI(`apps/web/src/features/outline/**`) 미구현.** 웹 앱 shell(Vite/React)이 아직 없다.
  - shell과 함께 PW-014(수동 수직경로 E2E)에서 outline 화면과 브라우저 증거를 만든다.
  - 이 Task의 인수조건은 API/DB 수준에서 검증했다.
- READY_FOR_APPROVAL node 상태는 쓰지 않는다. 승인 전 node는 DRAFT 또는 EVIDENCE_MISSING이다.
- claim 변경에 따른 impact review(DependencyLink)는 PW-011 이후다. 현재는 story 변경만 반영한다.
- revision 순서를 `created_at`(clock_timestamp)으로 정한다. 논문 행 잠금 아래에서 순차 생성되지만, 시계가 뒤로 가면 순서가 틀릴 수 있다. PW-009 리뷰 minor 5와 같은 문제로, seq 열 도입 시 함께 수정한다.
- evidence_ids/claim_ids는 아직 문자열 참조다. 실제 Evidence 존재 검사는 PW-011이다.

## 다음 Task
PW-011 Claim·Fact·Evidence 최소 모델(자동 시작하지 않음).

## 독립 리뷰 결과 반영 (2026-10-08)
- 결론
  - A(PW-010): changes requested. major 3, minor 5.
  - B(PW-009 수정 재확인): approve. minor 4.
- 수정 위치
  - 새 migration `pw_010_0002_review_fixes.sql`
  - `outlines/index.ts`, `shared/db.ts`
- 회귀 시험: `tests/tasks/PW-010/review-fixes.int.test.ts` 8건
  - 수정 전 6건 실패(`review-red.log`). 2건은 이미 맞게 동작하던 경로의 보강 시험이다.
  - xid 위조 시험은 처음에 SQL 타입 오류로 실패했다. 시험을 고친 뒤 fix migration 없이 다시 돌려 의도한 이유(위조값 저장)로 실패함을 확인했다.

| 지적 | 조치 |
|---|---|
| A-M1 active pointer가 가리키는 revision을 직접 SQL로 SUPERSEDED로 바꿔도 gate 통과 | deferred constraint trigger 3개(paper_projects, story_revisions, outline_revisions): commit 시점에 active pointer가 APPROVED만 가리켜야 함. gate도 status를 join해 확인 |
| A-M2 승인된 outline에 node·approval 직접 삽입 → gate 통과 | `outline_revisions.created_xid`(BEFORE INSERT로 강제). node는 생성 트랜잭션에서만 삽입. approval은 FK `(outline_revision_id, content_hash)`로 해당 revision hash만 허용. DRAFT/IN_REVIEW일 때만 허용. 증거 필요 node는 DB에서도 승인 거부 |
| A-M3 story/brief의 짝 없는 surrogate → 500, outline text는 무음 치환 | `storable()`을 shared로 옮겨 story·brief·node 모든 text/list에 적용 → 422 |
| A-m1 상태 guard 느슨함 | CHECK: 승인 열 쌍, superseded 쌍. INSERT는 DRAFT만. DRAFT↔IN_REVIEW에서 승인 열 변경 금지 |
| A-m2 gate TOCTOU | gate를 한 트랜잭션에서 paper 행 `FOR SHARE`로 수행. PW-013은 enqueue 트랜잭션 안에서 gate를 다시 실행하고, 고정한 story/outline/node를 저장해야 함(이월) |
| A-m3 대문자 parent id → 409 | parent id를 소문자화 |
| A-m4 spec 차이 | 아래 "결정 필요" |
| A-m5 시험 공백 | 이전 revision 승인 거부(story·outline), 재승인 멱등, 다른 논문 outline gate, surrogate, 노드 추가, 위조 승인을 시험에 추가 |
| B-m1 snapshot `created_xid` 위조 | BEFORE INSERT trigger로 현재 트랜잭션 값 강제 |
| B-m2 교차 owner 행이 있으면 pw_009_0002 적용 실패 | 기록만 한다. 아직 이 테이블을 쓰는 API가 없어 운영 데이터가 없다. 적용 실패 시 해당 행을 정리한 뒤 migration을 실행한다 |
| B-m3 owner_id를 호출자가 지정 | 이월: P04 참조 API는 owner_id를 paper에서 가져와야 함 |
| B-m4 removed_at 되돌리기·use_role 변경 이력 없음 | 의도된 동작(재추가 허용). 변경 이력은 PW-013 audit에서 기록 |

### 결정 필요 (P01 gate에서 사용자 확인)
spec 03은 "범위별 승인 → 문단 생성"과 "논문은 active_outline_revision을 별도 선택"을 말한다. 현재 구현은 보수적이다.
- outline은 **모든** node가 승인되어야 active가 되고, 그때 AI 초안이 허용된다. 일부 node만 승인된 상태로는 초안을 만들 수 없다.
- 전체 승인이 곧 활성화다. 별도의 "활성화" 동작은 없다. 승인 자체가 사용자 행위이고, 이전 승인본은 SUPERSEDED로 남는다.

대안: 승인된 node만 초안 허용 + 별도 activate endpoint. 사용자가 원하면 PW-011 전에 바꾼다.

### 실행 결과
- PW-010 통합: 22/22(`green.log`)
- `pnpm test`: exit 0
  - unit 9, integration 60, contracts 6, e2e 1, spikes 70
  - evals PASS, pack-check PASS

## 재리뷰 결과 반영 (2026-10-08)
- 결론: approve. 이전 지적은 재발하지 않았고, 기존 데이터 위 migration 적용도 확인했다. minor 4건은 모두 수정했다.
- 수정 위치: `pw_010_0003_rereview_fixes.sql`, `outlines/index.ts`, `shared/db.ts`
- 회귀 시험 4건 추가. 수정 전 4건 모두 의도한 이유로 실패(`rereview-red.log`)

| 지적 | 조치 |
|---|---|
| m1 두 SQL 세션 동시 실행 시 pointer가 SUPERSEDED를 가리킬 수 있음 | deferred trigger가 대상 revision 행(또는 참조하는 paper 행)을 `FOR SHARE`로 잠근다. 늦게 commit하는 쪽이 대기 후 commit된 상태로 재검사해 거부한다 |
| m2 기존 잘못된 pointer가 있으면 이후 갱신이 500 | migration이 그런 행이 있으면 이름을 밝히고 중단한다(무음 정리 없음). commit 시점 23001은 CONFLICT(409)로 변환 |
| m3 승인 뒤에서 대기한 gate가 방금 승인된 outline을 거부(fail closed) | 잠금을 별도 statement로 먼저 잡고, commit된 상태를 다시 읽는다 |
| m4 빈 evidence/claim id가 증거로 취급됨(과학적 실패 경로) | API 422. DB CHECK `pw_no_blank` 추가 |

- 기록만 한 사항
  - `SET CONSTRAINTS ALL IMMEDIATE` 상태에서는 승인 순서(먼저 supersede, 그다음 pointer 이동)가 실패한다. 앱은 이 명령을 쓰지 않는다.
  - superuser 접속은 trigger 우회가 가능하다. runtime role 분리를 이월한다(PW-009 기록과 동일).
- 실행
  - PW-010 통합 26/26, 3회 반복 안정(`green.log`)
  - `pnpm test` exit 0: unit 9, integration 64, contracts 6, e2e 1, spikes 70, evals/pack PASS
