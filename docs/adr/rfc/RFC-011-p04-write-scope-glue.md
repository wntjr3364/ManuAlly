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
- PW-032 리뷰 반영
  - `packages/domain/src/references/index.ts`(PW-019 모듈): 직접 입력한 참고문헌도 DOI(소문자)를 서재 식별자로 등록한다. 같은 DOI는 같은 작품이고, 같은 논문에 두 번 넣으면 409다.
  - `db/migrations/pw_032_0002_review_fixes.sql`
    - 이전 DOI를 식별자로 backfill하고, 겹치면 질문으로 남긴다.
    - `flagged_updated` 관계를 추가한다.
    - 중복 질문 TRUNCATE를 금지한다.
    - 이 파일은 `pw_033_0001`보다 앞에 정렬된다. `pw_033_0001`을 이미 적용한 개발 DB는 migration 실행기가 거부한다(무음 재정렬 없음). 그런 DB는 다시 만든다. 배포된 DB는 아직 없다.
- PW-031 재리뷰 nit: 범위 밖 파일 없음. `tests/tasks/PW-030/gate.test.ts`(PW-030 범위)의 source 검사만 호출 형태로 좁혔다.
- PW-033 리뷰 반영
  - `db/migrations/pw_033_0002_assessment_candidate_paper.sql`: 공유 표 `literature_candidates`(PW-031)에 `UNIQUE (paper_id, id)`를 추가한다. 추가만 하며 기존 행은 이미 만족한다. 평가가 자기 논문의 후보만 가리키도록 복합 FK를 건다.
  - `packages/domain/src/literature/index.ts`(PW-032 범위): `ingestCandidateIn`(호출자 트랜잭션), `noticesForDoi`
- PW-032 재리뷰 반영
  - `apps/web/src/features/references/ReferencesPanel.tsx`(PW-019 화면): 서재에 다른 정보로 있는 DOI를 알리고 "서재 정보로 추가"를 둔다.
  - `packages/domain/src/references/index.ts`: `use_library_metadata` 필드
- PW-033 최종 확인 nit: 범위 밖 파일 없음
- PW-034
  - `apps/api/src/server.ts`(`assets` 옵션, `registerAssetRoutes` 등록)
  - `apps/api/src/index.ts`(원본 저장 폴더: `PW_ASSET_DIR`, 기본 `$XDG_DATA_HOME` 또는 `~/.local/share` 아래 `paper-workspace/assets`. 실행 사용자 자신의 폴더)
- PW-034 리뷰 반영: `apps/api/src/index.ts`(기본 저장 폴더를 `defaultAssetDir()`로). 저장 모듈은 `packages/domain/src/asset-policy/store.ts`로 옮겼다(PW-034 범위의 domain 모듈, worker도 씀).
- PW-035
  - 공유 schema: `jobs.intent`에 `parse_source` 추가(`pw_035_0001`, `packages/domain/src/jobs/index.ts`의 `JOB_INTENTS`). 선례: PW-020의 `ask_selection`
  - `packages/domain/src/pdf/**`(새 모듈), `apps/api/src/pdf/**`(새 route 폴더), `apps/api/src/server.ts`(등록), `apps/worker/src/main.ts`(handler 등록)
  - `apps/web/src/app/api.ts`(`apiRaw`), `apps/web/src/features/paper/PaperPage.tsx`("원문" tab), `tests/e2e/manual-paper/harness.ts`(임시 저장 폴더, handler)
  - 의존성: `pdfjs-dist@6.4.299`(P00 결정 기록 §4에 고정, Apache-2.0)를 `apps/worker`·`apps/web`에 정확한 버전으로 추가. root `package.json`의 `pnpm.overrides`에서 선택 native 의존성 `@napi-rs/canvas`를 제거. `pnpm-lock.yaml` 갱신
- PW-036
  - 공유 schema: `asset_sources.kind`에 `figure_file` 추가(`pw_036_0001`)
  - `apps/api/src/figure-versions/**`(새 route 폴더), `apps/api/src/server.ts`(등록)
  - `packages/domain/src/evidence/index.ts`(PW-011): 문헌 인용 locator의 선택 항목 `anchor_id`(확인한 PDF 위치와 인용 텍스트·쪽이 같아야 함)
  - `apps/web/src/features/paper/EvidenceTab.tsx`(TracePanel 붙임)
- PW-037: `packages/search/package.json`(workspace 의존성 `@pw/domain`, `./*` export 추가. 새 외부 의존성 없음), `pnpm-lock.yaml`
- PW-038
  - `apps/api/src/reference-import/**`(새 route 폴더), `apps/api/src/server.ts`(등록, 시험용 `zotero` 옵션)
  - `apps/api/package.json`(`@pw/search` workspace 의존성. 새 외부 의존성 없음), `pnpm-lock.yaml`
  - `apps/web/src/features/references/ImportReferences.tsx`(새 화면), `ReferencesPanel.tsx`(붙임)
  - `tests/e2e/manual-paper/harness.ts`(시험용 `zotero` 옵션 전달)
- PW-038 리뷰 반영: 범위 밖 새 파일 없음. `apps/api/src/reference-import/index.ts`(Zotero 범위 전달), `ImportReferences.tsx`(서재 제목, 안내문)
