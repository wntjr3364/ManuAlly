# RFC-011 — P04 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-09)
Trigger task: PW-033 이후 P04 Task
Affected requirements/specs/contracts: REQ-031 … REQ-038; docs/specs/05_LITERATURE_AND_EVIDENCE.md

Problem and evidence:
- RFC-006(P01)·RFC-007(P02)·RFC-009(P03)와 같은 이유다.
- P04 Task의 write scope는 worker·web 기능 폴더와 migration만 준다.
- 사용자 결정(채택·거절)을 서버가 검증하려면 domain 모듈과 API route가 필요하다. 앱에서 쓰려면 route 등록, worker handler 등록, 화면 tab 연결 같은 연결 파일도 고쳐야 한다.

Proposed change:
- 각 Task가 범위 밖에서 만든 모듈·연결 파일을 아래 부록에 Task별로 적는다.
- 공유 schema(기존 표의 변경)·인증·청구 모델 변경은 이 RFC로 덮지 않고 별도 RFC로 한다. 새 표는 그 Task의 `db/migrations/pw_0xx_*`에 둔다.

Alternatives considered:
- 모든 검증을 worker 안에 둔다: 사용자 결정은 API에서 오므로 서버 검증이 domain에 있어야 한다(CLAUDE.md: 정본 변경은 서버 검증 후 트랜잭션).

Security/privacy/budget/provider terms impact:
- route는 기존 auth hook(로그인)·CSRF·paperScoped 규칙을 그대로 따른다. 남의 논문은 404다.
- worker handler 등록은 MOCK assessor만 쓴다. 실제 provider 연결은 RFC-010 구현 뒤다.

Data migration / backward compatibility: 없음(새 표만)
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-031·PW-032: 범위 밖 파일 없음
- PW-033
  - `packages/domain/src/curation/**`(새 모듈: 화면용 조회, 사용자 결정 검증·적용, 실행 요청)
  - `apps/api/src/curation/**`(새 route 폴더), `apps/api/src/server.ts`(등록)
  - `apps/worker/src/main.ts`(`literature_search` handler 등록, MOCK assessor)
  - `apps/web/src/features/paper/PaperPage.tsx`("문헌" tab)
  - `tests/e2e/manual-paper/harness.ts`(시험용 local worker에 같은 handler 등록)
