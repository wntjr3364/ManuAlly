# RFC-012 — P05 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-09)
Trigger task: PW-039 이후 P05 Task
Affected requirements/specs/contracts: REQ-039 … REQ-046; docs/specs/03_STORY_AND_OUTLINE.md, docs/specs/06_SCIENTIFIC_WRITING.md

Problem and evidence:
- RFC-006·007·009·011과 같은 이유다.
- P05 Task의 write scope는 worker·web 기능 폴더, 일부 domain 폴더, migration만 준다.
- 사용자 결정(채택·승인)을 서버가 검증하려면 domain 모듈과 API route가 필요하다. 앱에서 쓰려면 연결 파일도 고쳐야 한다: route 등록, worker handler 등록, 화면 연결, job intent 추가.

Proposed change:
- 각 Task가 범위 밖에서 만든 모듈과 연결 파일을 아래 부록에 Task별로 적는다.
- job intent 추가(`jobs.intent` CHECK와 `JOB_INTENTS`)는 PW-035 선례대로 그 Task의 migration에서 한다.
- 인증·청구 모델 변경은 이 RFC로 덮지 않고 별도 RFC로 한다.

Alternatives considered: RFC-011과 같다.

Security/privacy/budget/provider terms impact:
- route는 기존 auth hook·CSRF·paperScoped 규칙을 따르고, 남의 논문은 404다.
- worker handler는 MOCK generator로 등록한다.
- 실제 provider 연결은 RFC-010의 run 경로(sandbox, run token, 논문별 상태)를 쓰고, 논문의 외부 전송 정책을 먼저 확인한다.

Data migration / backward compatibility: 새 표와 job intent 추가만
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-039
  - 새 domain 모듈 `packages/domain/src/story-ai/**`(요청, 보기, 채택)
  - 새 route 폴더 `apps/api/src/story-ai/**`, `apps/api/src/server.ts`(등록)
  - `packages/domain/src/outlines/index.ts`: `createStoryRevisionIn`(호출자 트랜잭션). 동작은 그대로다.
  - `packages/domain/src/jobs/index.ts`: `JOB_INTENTS`에 `propose_story`. 공유 schema 변경은 `pw_039_0001`에서 한다.
  - `apps/worker/src/main.ts`, `tests/e2e/manual-paper/harness.ts`(MOCK handler 등록)
  - `apps/web/src/features/paper/StoryOutlineTab.tsx`(대안 화면 붙임)
- PW-039 리뷰 반영: `packages/search/src/retrieval/index.ts`(`settledMaterial` 내보내기, PW-037 gate 재사용), `apps/worker/package.json`(`@pw/search` workspace 의존성; 새 외부 의존성 없음), `pnpm-lock.yaml`
- PW-040
  - `packages/domain/src/outlines/index.ts`: draft gate와 node 상태가 node의 미검토 영향을 본다(그 node만)
  - `packages/domain/src/evidence/index.ts`: `retractRecord`(승인된 주장, 검증된 근거·사실의 철회; DB가 이미 허용하던 전이)
  - `apps/api/src/routes/evidence/index.ts`(철회 route), 새 route 폴더 `apps/api/src/outline-impact/**`, `apps/api/src/server.ts`
  - `apps/web/src/features/paper/EvidenceTab.tsx`, `apps/web/src/features/evidence/TracePanel.tsx`(철회 버튼), `apps/web/src/features/paper/StoryOutlineTab.tsx`(영향 panel)
