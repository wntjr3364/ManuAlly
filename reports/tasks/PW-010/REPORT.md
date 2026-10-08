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
