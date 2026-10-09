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
- PW-024 리뷰 반영
  - `packages/providers/src/core/admission.ts`(새 파일: Claude·Codex 공용 gate. 등록부를 직접 읽고, 만료·turn·USD 예산을 둔다)
  - `packages/providers/src/core/capabilities.ts`(`liveEvidenceOk` export), `packages/providers/src/core/index.ts`
- PW-025: 범위 밖 파일 없음(공용 gate는 PW-024 리뷰 반영에서 추가)
- PW-025 리뷰 반영: `packages/providers/src/core/admission.ts`(`checkDecision`: turn을 쓰지 않고 결정만 검사. `--version` 실행 전에 부른다), `packages/providers/src/claude/turn.ts`(PW-024 nit: 같은 검사를 먼저)
- PW-026
  - `packages/providers/src/core/admission.ts`(OuterSandbox kind에 `userns` 추가: sudo 없는 unshare backend의 검증 결과를 Codex gate가 받을 수 있게)
- PW-027: 범위 밖 파일 없음(다른 domain 모듈은 import만 함)
- PW-027 리뷰 반영: `apps/web/src/features/diff/ProposalPanel.tsx`, `apps/web/src/features/versions/VersionsTab.tsx`(MOCK 배지 규칙에 `worker:tool-gateway:mock` 추가)
- PW-028: `apps/web/src/features/paper/PaperPage.tsx`("AI 실행" 탭 연결)
- PW-029: `apps/api/src/usage/**`(새 route 폴더: `GET /api/papers/:paperId/usage`, `GET /api/providers/quota`), `apps/api/src/server.ts`(등록), `apps/web/src/features/paper/PaperPage.tsx`("AI 실행" 탭에 사용량 패널)
- PW-028 리뷰 반영: `packages/domain/src/tool-policy/index.ts`(run token을 job의 fencing token에 묶음: 발급 시 확인, 호출 때마다 RUNNING·같은 token일 때만 유효)
- PW-030 리뷰 반영: `packages/providers/src/core/capabilities.ts`, `packages/providers/src/core/admission.ts`(실제 provider 승인에 `ran_inside_sandbox: true` live 증거 필요), `apps/web/src/features/runs/run-state.ts`(취소 문구), `tests/tasks/PW-023|024|025` 고정값(live 증거에 `ran_inside_sandbox`)
