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
