# RFC-006 — P01 write scope 보완: 앱 shell·route 연결·DB migration 실행기
Status: accepted (delegated)
Trigger task: PW-007
Affected requirements/specs/contracts: REQ-007, REQ-008, REQ-010, REQ-014 (write_scope만 변경, 요구사항·인수조건 변경 없음)

Problem and evidence:
pack의 P01 write scope에는 다음이 어느 Task에도 없다.
- 웹 앱 shell(`apps/web/index.html`, `vite.config.ts`, `src/main.tsx`, 공용 UI/API client)
- API 서버 조립·route 연결(`apps/api/src/server.ts`, `routes/**`)
- DB 연결과 migration 실행기
- 패키지 진입점(`packages/*/src/index.ts`)과 패키지별 tsconfig
이 파일들 없이는 PW-010(개요 UI), PW-014(수동 논문 수직경로 E2E)를 구현할 수 없다.

Proposed change:
아래 경로를 해당 Task의 write_scope에 추가한다.
- PW-007:
  - `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/app/**`
  - `apps/api/src/server.ts`, `apps/api/src/db/**`
  - `packages/*/src/index.ts`, `packages/config/**`(기존)
  - `infra/dev/**`(기존)
- PW-008:
  - `apps/api/src/routes/papers/**`, `apps/web/src/features/papers/**`, `apps/web/src/app/**`
- PW-009: `apps/api/src/routes/revisions/**`
- PW-010: `apps/api/src/routes/outlines/**`
- PW-011: `apps/api/src/routes/evidence/**`, `apps/web/src/features/evidence/**`
- PW-013: `apps/api/src/routes/jobs/**`
- PW-014: `apps/web/src/app/**`, `apps/api/src/routes/**`(연결 보정만)

Alternatives considered: 각 Task에서 RFC를 따로 발행 — 내용이 같은 조립 코드라 하나로 묶는다.

Security/privacy/budget/provider terms impact: 없음. 인증·스키마·청구 모델 변경이 아니다(인증은 원래 PW-008 범위).

Data migration / backward compatibility: 없음(구현 전).

Tests and acceptance criteria: 각 Task의 기존 인수조건 그대로. 범위 확장으로 테스트를 줄이지 않는다.

Write scope: docs/adr/rfc/**, scripts/validate_pack.py(`node_modules` 제외 한 줄: 설치된 의존성의 JSON-with-comments 파일 때문에 pack 검사가 실패함), tasks/TASK_MANIFEST.json(write_scope 필드만), tasks/PW-00[7-9].md, tasks/PW-01[0-4].md

User decision / reviewer:
- 사용자가 2026-10-08 "작업해"로 P01 진행을 승인했고, 그 전에 계획 세부 결정을 위임했다.
- 이 RFC는 파일 경로 범위만 넓히며, 요구사항·인수조건·보안 규칙은 바꾸지 않는다.
