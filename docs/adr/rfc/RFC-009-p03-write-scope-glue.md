# RFC-009 — P03 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-09)
Trigger task: PW-023 이후 P03 Task
Affected requirements/specs/contracts: REQ-023 … REQ-030; docs/specs/07_AGENT_RUNTIME.md

Problem and evidence:
- RFC-006(P01)·RFC-007(P02)과 같은 이유다.
- P03 Task의 write scope는 provider core·contract·adapter 폴더만 준다.
- 그 기능을 앱에서 쓰려면 API route 등록, package export 같은 연결 파일을 고쳐야 한다.

Proposed change:
- 각 Task가 범위 밖에서 고친 연결 파일을 아래 부록에 Task별로 적는다.
- 공유 schema·DB·인증·청구 모델 변경은 이 RFC로 덮지 않고 별도 RFC로 한다.

Alternatives considered:
- Task마다 RFC를 따로 쓴다: 연결 파일 몇 줄마다 문서가 늘어 추적이 어렵다.

Security/privacy/budget/provider terms impact:
- 연결 파일은 기능을 노출만 한다. 권한 검사는 기존 auth hook(로그인)과 paperScoped 규칙을 그대로 따른다.

Data migration / backward compatibility: 없음
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-023
  - `apps/api/src/providers/**`(새 route 폴더: `GET /api/providers/capabilities`), `apps/api/src/server.ts`(등록)
  - `packages/providers/package.json`(`./core/index.ts` export)
