# PW-007 — Monorepo와 검증 명령 scaffold — 보고서

상태: **in_review** / 일자: 2026-10-08

## 변경 파일
- 루트: `package.json`(명령 등록, 정확한 버전 고정), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.env.example`
- `apps/{api,web,worker}`: package.json, tsconfig.json, src/index.ts
  - `apps/api/src/server.ts`: Fastify, `/api/health`
  - `apps/api/src/db/migrate.ts`: SQL migration 실행기(체크섬, advisory lock, 실패 시 rollback)
- `packages/{config,contracts,editor-core,domain,providers,search,exports}`
  - `packages/config`: tsconfig.check, vitest unit/integration/contracts 설정, `test-db.ts`
  - `packages/providers`: mock 전용 provider 선택
- `db/migrations/pw_007_0001_baseline.sql`
- `infra/dev/pg-dev.sh`: 사용자 소유 PostgreSQL 클러스터. sudo 없음, TCP 없이 unix socket만, root면 postgres 사용자로 실행
- `.github/workflows/ci.yml`: pull_request·수동 실행만(push마다 실행하지 않음)
- 범위 밖 변경(RFC-006에 기록): `scripts/validate_pack.py`가 `node_modules`의 JSON을 건너뛰게 함, TASK_MANIFEST write_scope 보완, PW-006 gate 테스트를 승인 기록 인식으로 변경, PW-004 테스트의 가짜 CLI 위치 의존 제거

## 버전 결정
TypeScript는 **6.0.3**이다. typescript-eslint 8.70.1이 `typescript <6.1.0`만 지원하기 때문이다(PW-006에서 미뤘던 결정).
나머지(14일 규칙):
- eslint 10.11.0, vitest 5.0.1, pg 8.23.0, fastify 5.12.5, @types/node 22.20.4
- vite·React·Playwright는 해당 Task에서 추가한다.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-007-A 깨끗한 설치에서 정해진 명령 실행, Mock만 사용 | TST-007A ×5 (명령 등록, workspace 경계, 정확한 버전, mock 기본·실제 provider 거부, typecheck) + migration 통합 2 | pass |
| REQ-007-B secret이 없어도 유료 호출·전체 skip 없음 | TST-007B ×3 (secret env가 provider를 바꾸지 않음, 자격증명 조건 skip·passWithNoTests 금지, DB 없으면 통합 테스트가 skip이 아니라 실패하고 pw_test 외 DB 거부) | pass |

## 실행 증거
- `pnpm test` = typecheck → lint → unit(8) → integration(2) → spikes(70) → evals → pack-check: exit 0 (`pnpm-test.log`)
- **깨끗한 clone**에서 `pnpm install --frozen-lockfile && npm ci --prefix spikes/editor-export && pnpm test`: exit 0 (`clean-clone-pnpm-test.log`)
  - 첫 시도는 spike 테스트 6개가 실패했다. clone 위치(root 전용 0700 폴더)를 nobody 사용자가 읽지 못한 탓이며, 테스트를 위치와 무관하게 고쳤다.
- RED: 테스트를 먼저 작성했지만 vitest 설치 전이라 RED를 실행으로 기록하지 못했다. typecheck 테스트는 첫 실행에서 실제로 실패했고(root에 pg 없음), lint는 `preserve-caught-error`로 실패했다가 수정 후 통과했다.

## 미실행 / 제한
- `test:e2e`(Playwright)와 `test:contracts`: 명령만 등록했고 아직 테스트가 없다. 그래서 `pnpm test`에 포함하지 않았다(빈 suite 통과를 허용하지 않기 위해). PW-012(contracts)와 PW-014(e2e)에서 연결한다.
- CI workflow는 GitHub에서 아직 실행되지 않았다(PR이 없음). 로컬에서 같은 명령 순서를 실행해 확인했다.

## 다음 Task
PW-008 Owner 인증과 PaperProject.
