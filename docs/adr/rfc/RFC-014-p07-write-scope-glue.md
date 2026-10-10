# RFC-014 — P07 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-10)
Trigger task: PW-055 이후 P07 Task
Affected requirements/specs/contracts: REQ-055 … REQ-062; docs/specs/10_EXPORT_AND_REVIEW.md, docs/specs/12_OPERATIONS_AND_BACKUP.md

Problem and evidence:
- RFC-011·012·013과 같은 이유다.
- P07 Task의 write scope는 해당 기능의 domain·화면 폴더와 migration만 준다.
- 가져오기·내보내기·보관은 이미 있는 route(가져오기 route 등)와 화면(버전 탭 등)에 이어져야 동작한다. 그래서 그 등록 파일을 고쳐야 한다.

Proposed change:
- 각 Task가 범위 밖에서 고친 파일을 아래 부록에 Task별로 적는다.
- 공유 표의 CHECK·NULL 변경은 그 Task의 migration에서 하고 부록에 적는다.
- 인증·청구 모델 변경, 새 외부 의존성은 이 RFC로 덮지 않고 별도 RFC로 한다.

Alternatives considered: RFC-011과 같다.

Security/privacy/budget/provider terms impact:
- 외부에서 온 파일(.docx 등)은 모델에 보내지 않는다. 변환은 로컬에서 한다.
- 원본은 받은 그대로 보관하고 지우지 않는다.

Data migration / backward compatibility: 기존 표의 데이터는 바꾸지 않는다. 제약을 넓히는 변경만 한다.
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-055
  - `apps/api/src/imports/index.ts`
    - `format: docx`는 `createDocxImport`로 보낸다.
    - 원본 내려받기 `GET …/imports/:importId/original`(모든 형식, `attachment`, `nosniff`, SHA-256 머리글)을 더했다.
    - 요청 크기 상한을 2 MiB에서 15 MiB로 올렸다(base64로 10 MiB .docx). 텍스트의 크기 규칙(900,000바이트)은 domain이 그대로 지킨다.
  - `apps/web/src/features/versions/VersionsTab.tsx`: 텍스트 가져오기 옆에 Word 가져오기 패널(`features/import/DocxImport.tsx`)을 단다.
  - `packages/domain/src/imports/text/index.ts`: 오류 문구 하나("DOCX import comes later" → format docx 안내)
  - 공유 표 변경(migration `pw_055_0001`)
    - `import_sources.format`에 `docx`를 더했다.
    - `source_text`는 docx일 때만 NULL이고, 그때 `source_bytes`는 반드시 있다.
    - 표는 여전히 불변이다.
  - spec 10 "원본 asset을 먼저 불변 저장"과의 차이(review m3): 원본은 미리 보기와 같은 트랜잭션에 받은 그대로 저장된다. 읽을 수 없는 파일과 변경 추적 선택 전 업로드는 거부하고 저장하지 않는다. 사용자의 파일은 사용자에게 그대로 있다.
- PW-056
  - 새 route 폴더 `apps/api/src/exports/**`, `apps/api/src/server.ts`(등록)
  - 새 화면 폴더 `apps/web/src/features/exports/**`, `apps/web/src/features/versions/VersionsTab.tsx`(내보내기 패널)
  - `packages/exports/package.json`(`@pw/domain`, `@pw/editor-core` workspace 연결, `./*` export), `apps/api/package.json`(`@pw/exports`), `pnpm-lock.yaml`. workspace 내부 연결뿐이고 외부 의존성은 없다.
  - **결정(위임)**: P00의 "pandoc + citeproc 별도 프로세스" 대신 앱이 DOCX를 직접 쓴다.
    - pandoc 설치가 필요 없다(sudo 없는 서버).
    - 화면과 같은 고정 렌더러를 쓴다(번호·참고문헌 일치).
    - 결정적 바이트다.
    - 학술지 CSL 양식 적용은 citeproc 버전 고정 RFC가 있을 때까지 하지 않는다. CSL-JSON 내보내기로 대신한다.
- PW-057
  - `packages/exports/src/docx/service.ts`
    - PDF와 원본 묶음이 같은 경로를 쓰도록 `manuscriptHead`·`retractedOf`·`headDocx`로 나눴다. DOCX·CSL-JSON 동작은 같다(PW-056 시험 그대로 통과).
    - 기록에 `snapshot_id`·`purpose`를 더했다.
    - `exportFile`은 원본 묶음의 바이트를 asset 저장소에서 기록된 SHA-256으로 확인해 읽는다. 없거나 손상되면 내주지 않는다.
  - `packages/domain/src/imports/docx/zip.ts`: `openZip(buf, limits = ZIP_LIMITS)`. 원본 묶음 검증기가 자기 상한을 넘긴다. DOCX 가져오기의 상한과 동작은 같다.
  - `apps/api/src/exports/index.ts`
    - `format: pdf`와 `format: source_archive`(`snapshot_id`, `purpose`)를 받는다.
    - 파일 형식과 이름을 정한다.
    - 저장소에서 사라진 묶음에는 410을 준다.
  - `apps/api/src/server.ts`: 내보내기 route에 asset 저장소 설정을 넘긴다.
  - `apps/web/src/features/exports/ExportPanel.tsx`: PDF 버튼, 스냅샷 선택, 공유용·보관용 묶음 버튼을 단다. 넣지 않은 원본과 빠진 원본, 자체 검증 결과도 보여 준다.
  - `apps/web/src/features/versions/VersionsTab.tsx`, `apps/web/src/features/paper/SnapshotsTab.tsx`: 새 스냅샷이 내보내기 패널 목록에 바로 나타난다.
  - `tests/tasks/PW-056/export.int.test.ts:105`: "모르는 형식" 거부의 예를 `pdf`(이제 형식)에서 `odt`로 바꿨다. 거부 규칙은 그대로다.
  - 공유 표 변경(migration `pw_057_0001`)
    - `exports.format`에 `pdf`와 `source_archive`를 더했다.
    - `status`에 `incomplete`를 더했다(원본 묶음 전용).
    - `snapshot_id`·`purpose`·`in_asset_store` 열을 더했다.
    - 원본 묶음은 바이트를 asset 저장소에 두고 행에는 해시만 둔다. 모양은 `exports_archive_shape` CHECK가 강제한다.
    - 표는 여전히 불변이다.
  - **결정(위임)**
    - PDF는 서버 컴퓨터에 설치된 LibreOffice(`soffice`)로 앱의 DOCX를 변환한다.
      - 변환마다 임시 프로필과 HOME, 최소 환경, 시간 상한(120초, 프로세스 그룹 종료)을 쓴다.
      - LibreOffice가 없으면 409로 알리고 아무것도 저장하지 않는다.
      - PDF는 바이트 재현을 약속하지 않으므로 원본 묶음에 넣지 않는다. 묶음에는 다시 만들 수 있는 DOCX가 들어간다.
    - 공유용 묶음은 CC BY·CC BY-SA·CC0·퍼블릭 도메인·자기 작업 원본만 자동으로 넣는다.
      - NC·ND·출판사 TDM·권리 보유·미확인 원본은 해시와 이유만 적는다.
      - 그림 파일은 정책이 'unknown'이고 지금은 바꿀 경로가 없다(PW-036). 그래서 공유용에서는 빠지고 보관용에만 들어간다. 남은 위험으로 기록한다.
- PW-058
  - 새 route 폴더 `apps/api/src/submissions/**`, `apps/api/src/server.ts`(등록)
    - 이 파일이 domain의 제출판 확정에 세 가지를 넘긴다. domain은 exports에 의존하지 않는다(exports가 domain에 의존).
      - head DOCX 렌더(PW-056 `headDocx`)
      - 이름 붙인 스냅샷(PW-009)
      - 스냅샷의 보관용 원본 묶음(PW-057)과 그 안의 렌더 보고·DOCX 해시
  - `apps/web/src/features/versions/VersionsTab.tsx`: 리뷰어 의견·제출판 패널(`features/submission/SubmissionPanel.tsx`)을 단다.
  - 공유 표(migration `pw_058_0001`): `review_comments`, `review_responses`, `submissions`. 모두 불변이다.
    - 제출용(`submission_ready`) 행은 막는 문제 목록이 비어 있어야 한다(`submissions_ready_clean` CHECK).
  - **결정(위임)**
    - 제출용 확정을 막는 것
      - 내보내기 검사의 오류(RFC-008의 미해결 인용·그림 참조 포함)
      - 답 없는 의견
      - 지금 원고에서 사라진 "수정함" 주장
      - 같은 문단에 남은 과학 검사 실패와 미결정 과학 검토 지적
      - 원본 묶음의 빠짐이나 검증 실패
    - 경고는 사용자가 확인해야 넘어간다: 철회 문헌, 불완전 문헌, 바뀐 뒤 다시 검사하지 않은 문단, 반영하지 않음 답 등.
    - 초안으로 고정하는 것은 문제가 있어도 되며, 문제를 함께 기록한다.
    - 확정은 head에서 먼저 검사한다. 거절되면 스냅샷도 묶음도 만들지 않는다. 확정은 스냅샷 → 원본 묶음 → 묶음 자체 렌더로 다시 검사 → 저장 순서다.
- PW-059
  - `apps/worker/src/provider-runs/index.ts`(보안 감사 F-01, high)
    - `prepareStateDir`가 로그인 프로필에 `assertSafeProfileDir`를 적용한다. 개발자 CLI 상태(`~/.claude`, `~/.codex`, `~/.config/claude`), 그 안, 홈 자체, symlink, 남이 쓸 수 있는 폴더는 거부한다.
    - `homes`를 넘길 수 있다(실행 설정의 homes).
    - RFC-010의 "별도 runtime 로그인 프로필"을 코드로 강제하는 것이다. 동작 변화는 잘못된 설정의 거부뿐이다.
  - (리뷰 반영) `apps/worker/src/provider-runs/index.ts` 추가 변경
    - 보안 감사 F-03(high): `runProviderTurn`이 시작할 때 논문의 전송 정책을 확인한다(민감 자료, 전송 차단, 허용 공급자 목록). token·폴더·프로세스가 생기기 전이다.
    - 리뷰 n2: 로그인 프로필이 옮겨 둔 개발자 CLI 상태(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME/claude`) 안이면 거부한다.
  - `tests/rfc/RFC-010/provider-runs.int.test.ts`: 시험 논문이 두 공급자를 허용하도록 설정한다. F-03 확인이 생겨서 필요해졌다.
  - `infra/sandbox/sandbox.ts`(F-04, low): sandbox 가용성 확인(bwrap·prlimit·unshare·python3)이 worker 환경 대신 PATH만 받는다.
  - (재리뷰 M1') `packages/domain/src/outlines/index.ts`(보안 감사 F-05, medium): 개요 저장 시 `claim_ids`·`evidence_ids`의 UUID 형태 id는 이 논문의 주장·근거여야 한다. 자유 계획 이름표(PW-010)는 그대로 허용한다. 동작 변화는 다른 논문·없는 기록 id의 거부(422 `not_in_paper`)뿐이다.
  - `tests/e2e/manual-paper/manual-paper.e2e.ts`(회귀 수정, 시험만): 스냅샷 이름을 `exact`로 찾는다. PW-057의 묶음 내보내기 스냅샷 선택에도 같은 이름이 option으로 나온다. 목록 갱신이 확인보다 먼저 끝나면 두 요소가 잡혀 실패했다(경합). 제품 동작은 바뀌지 않는다.
- PW-060
  - `tests/security/static.test.ts`(PW-059 정적 점검의 검토 목록): `infra/backup/backup.ts`를 자식 프로세스 허용 모듈에 넣는다. pg_dump·pg_restore를 만든 환경(PATH와 PG* 연결 변수)으로만 실행한다. 비밀번호는 환경에만 있고 명령줄에는 없다. 정적 점검이 새 모듈을 잡은 것이 의도된 동작이다.
- PW-061
  - `apps/worker/src/ai-pause/index.ts`(새 파일), `apps/worker/src/main.ts`: AI 작업 handler를 가장 바깥에서 `withAiPause`로 감싼다(spec 12 "비상 중단"). 운영자가 AI를 멈추면 새 AI 작업은 시도 횟수를 쓰지 않고 기다린다. 멈춘 동안 끝난 호출의 결과는 적용하지 않는다. PDF 해석과 수동 편집은 그대로다.
  - `tests/security/static.test.ts`(PW-059 검토 목록): `infra/deploy/pwctl.ts`를 자식 프로세스 모듈(supervisor, 만든 환경)과 네트워크 모듈(loopback health 확인)에 넣는다.
