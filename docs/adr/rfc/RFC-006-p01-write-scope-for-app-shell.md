# RFC-006 — P01 write scope 보완: 앱 shell·route 연결·DB migration 실행기
Status: accepted (delegated) — P01 gate에서 사용자 확인 요청
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
  - `eslint.config.js`(루트 lint 설정), `tests/contracts/**`, `tests/e2e/**`(명령마다 실제로 도는 smoke 테스트, PW-007 리뷰 M3)
  - `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/app/**`
  - `apps/api/src/server.ts`, `apps/api/src/db/**`
  - `packages/*/src/index.ts`, `packages/config/**`(기존)
  - `infra/dev/**`(기존)
- PW-008:
  - `packages/domain/src/shared/**` (도메인 공용 query 인터페이스·오류 타입)
  - `apps/api/src/routes/papers/**`, `apps/web/src/features/papers/**`, `apps/web/src/app/**`
- PW-009: `apps/api/src/routes/revisions/**`
- PW-010: `apps/api/src/routes/outlines/**`
- PW-011: `apps/api/src/routes/evidence/**`, `apps/web/src/features/evidence/**`
- PW-013: `apps/api/src/routes/jobs/**`
- PW-014: `apps/web/src/app/**`, `apps/api/src/routes/**`(연결 보정만)

PW-007 리뷰(M5) 후 추가 기록:
- `tests/tasks/PW-004/isolation.test.mjs`: 가짜 CLI를 테스트 임시 폴더로 복사하는 수정. 깨끗한 clone 위치에서 실패하던 테스트 결함이다(PW-004 범위, 동작 변경 없음).
- `tests/tasks/PW-006/gate.test.mjs`(39f0ddb): scaffold 금지 검사를 "승인 기록이 있으면 허용"으로 변경.
- migration 파일 이름은 `pw_NNN_NNNN_name.sql` 하나로 통일한다. 매니페스트의 `p01_*` 패턴은 쓰지 않으며, 실행기가 거부한다(PW-007 리뷰 M2: 사전순 정렬 시 의존 순서가 뒤집힘).

Alternatives considered: 각 Task에서 RFC를 따로 발행 — 내용이 같은 조립 코드라 하나로 묶는다.

Security/privacy/budget/provider terms impact: 없음. 인증·스키마·청구 모델 변경이 아니다(인증은 원래 PW-008 범위).

Data migration / backward compatibility: 없음(구현 전).

Tests and acceptance criteria: 각 Task의 기존 인수조건 그대로. 범위 확장으로 테스트를 줄이지 않는다.

Write scope: docs/adr/rfc/**, scripts/validate_pack.py(`node_modules` 제외 한 줄: 설치된 의존성의 JSON-with-comments 파일 때문에 pack 검사가 실패함), tasks/TASK_MANIFEST.json(write_scope 필드만), tasks/PW-00[7-9].md, tasks/PW-01[0-4].md

User decision / reviewer:
- 사용자가 2026-10-08 "작업해"로 P01 진행을 승인했고, 그 전에 계획 세부 결정을 위임했다.
- 이 RFC는 파일 경로 범위만 넓히며, 요구사항·인수조건·보안 규칙은 바꾸지 않는다.

PW-010 및 PW-009 리뷰 반영 시 추가 기록(2026-10-08):
- PW-010이 범위 밖에서 고친 연결 지점(동작 추가만, 기존 계약 유지):
  - `apps/api/src/server.ts`: outline route 등록
  - `packages/domain/src/papers/index.ts`: 응답에 active_story/outline_revision_id
  - `packages/domain/src/revisions/index.ts`: snapshot이 활성 story/outline 고정
- PW-009 리뷰 수정:
  - `db/migrations/pw_009_0002_*`(PW-009 범위의 새 migration)
  - `tests/tasks/PW-009/review-fixes.int.test.ts`
- PW-008 재리뷰 minor: `apps/api/src/auth/sessions.ts`, `apps/api/src/server.ts`(오류 종류)
- `packages/config/src/test-db.ts`(PW-007 범위): 임시 DB drop 전에 접속이 닫히기를 기다린다. 끊기는 중인 client를 FORCE가 종료해 57P01이 unhandled로 한 번 보고된 시험 인프라 결함이다.
- PW-011 연결 지점:
  - `apps/api/src/server.ts`: evidence route 등록
  - `packages/domain/src/shared/db.ts`: DomainError `details`(missing/reasons 등 기계 판독 정보)
  - `apps/api/src/auth/plugin.ts`: 응답에 details 포함
  - `packages/domain/src/outlines/index.ts`: OutlineError가 공용 details 사용(동작 동일)
- PW-012
  - RFC-005에 따라 `contracts/**`와 `examples/**`(edit_proposal v2, ai_replacement v1, manifest)를 갱신했다.
  - `tests/tasks/PW-007/...`가 아닌 PW-012 시험 폴더 안에 Chromium parity 시험을 `*.int.test.ts`로 두었다(integration 명령이 실행).
  - 저장 경로(`packages/domain/src/revisions`)에 문서 검증을 연결하는 일은 PW-014로 제안한다.
- PW-013
  - `apps/api/src/server.ts`: jobs route 등록
  - `apps/worker/package.json`: pg-boss 12.34.0, pg 8.23.0, @pw/domain
  - root `package.json`: `pnpm.overrides`로 pg-boss의 하위 의존성 두 개(rrule-temporal 2.2.6, serialize-error 13.0.1)를 14일 이상 지난 버전으로 고정(CLAUDE.md 버전 규칙). 새 직접 의존성은 ADR-008이 승인한 pg-boss뿐이다.
- PW-014
  - 웹 앱 shell: `apps/web/index.html`, `vite.config.ts`, `src/main.tsx`, `src/app/**`, `src/vite-env.d.ts`
  - `apps/api/src/routes/revisions`: 저장 시 editor-core 검증
  - `apps/api/package.json`: @pw/editor-core
  - `packages/domain/src/shared/db.ts`: DomainError parameter property 제거(dev runtime 결함 수정)
  - `packages/editor-core/src/schema.ts`: `doc: block*`
  - `tests/tasks/PW-009/revisions.int.test.ts`: fixture block id를 UUID로
  - root `package.json`: vite devDep, 하위 의존성 overrides(14일 규칙)
- PW-014 리뷰 반영
  - `packages/domain/src/revisions/index.ts`와 `packages/domain/package.json`: 원고 검증을 domain 저장 함수로 옮김
  - `packages/editor-core/package.json`: prosemirror-transform 1.12.1(14일 규칙)
  - root `package.json` overrides: lockfile 전체 감사 결과 14일 미만 29개를 고정
