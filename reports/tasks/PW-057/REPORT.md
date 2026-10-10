# PW-057 — PDF·재현 source archive — REPORT
상태: in_review (2026-10-10) — 독립 리뷰 1차 changes requested(MAJOR 1, MINOR 3, NIT 3) → 반영 → 재리뷰 approve(NIT 1 반영)

## 무엇을 했나
- **읽기용 PDF**(`packages/exports/src/pdf`)
  - 앱의 DOCX(PW-056과 같은 경로, `headDocx`)를 서버 컴퓨터에 설치된 LibreOffice(`soffice --headless --convert-to pdf`)로 변환한다.
  - 변환 격리
    - 변환마다 임시 폴더, 자기 LibreOffice 프로필(`-env:UserInstallation`), 자기 HOME과 TMPDIR을 쓴다.
    - 환경은 PATH와 locale뿐이다. 비밀 변수는 넘기지 않는다.
    - 120초 뒤 프로세스 그룹을 통째로 끝낸다. 동시에 2개까지만 변환한다.
    - 끝나면 임시 폴더를 지운다.
  - LibreOffice 찾기: `PW_SOFFICE`(절대 경로만) → PATH의 `soffice`/`libreoffice`
  - 실패 처리
    - 없으면 409 `PDF_CONVERTER_UNAVAILABLE`(설치 안내)이고, 아무것도 저장하지 않는다.
    - 변환 실패·시간 초과·PDF가 아닌 결과는 409 `PDF_CONVERSION_FAILED`다.
  - 본문 확인: pdftotext로 PDF 글자를 다시 읽어 원고 제목들이 있는지 본다.
    - pdftotext가 없으면 `not_run`이다(통과가 아니다).
    - 빠지면 경고 `pdf_text_missing`이다.
  - 기록: DOCX 검사 보고, 변환기 버전(`renderer_version = pw-docx-export-1+libreoffice-24.2.7.2`), 본문 확인 결과, 원본 DOCX의 SHA-256
  - 레이아웃은 LibreOffice가 DOCX를 해석한 결과다. Word와 같다고 약속하지 않는다(spec 10).
- **재현 원본 묶음**(`packages/exports/src/archive`)
  - 이름 붙인 스냅샷에서만 만든다. 이후의 편집은 들어가지 않는다(시험).
  - 넣는 것
    - 문서(편집기 JSON, schema version, revision id)
    - 스토리와 아웃라인: 고정된 revision의 불변 내용. 상태(APPROVED/SUPERSEDED처럼 시간이 지나며 바뀌는 값) 대신 승인 기록이 들어간다. 노드 승인은 스냅샷 시점까지의 것이다.
    - 문헌 revision의 CSL-JSON(`pw:bibliographic_revision_id`)과 BibTeX(LaTeX 특수문자 escape, DOI·URL은 그대로)
    - 그림: 스냅샷 시점의 캡션(시험)
    - 스냅샷 시점에 승인돼 있던 글쓰기 프로필
    - AI 도움 기록: 스냅샷까지 적용된 선택 수정·문단 제안의 id, 생성기, 기준·결과 revision, 결정자·시각. 스냅샷 뒤 적용분과 미적용분은 빠진다(시험).
    - 정책이 허락하는 원본(`assets/<sha256>`)
    - 그 파일들로 다시 만든 `outputs/manuscript.docx`와 그 검사 보고
  - `manifest.json`
    - 모든 파일의 경로, SHA-256, 크기, 역할
    - 스냅샷과 버전들(묶음 형식 `pw-source-archive-1`, DOCX 렌더러, 인용 양식)
    - 문헌 revision 목록, 렌더 입력(문서, revision, 양식, 철회 문헌)
    - 넣지 않은 원본(해시, 라이선스, 이유)과 저장소에서 빠진 원본
  - 같은 입력은 같은 바이트다.
  - **TST-057B — 공유용**(`purpose: share`): 자동으로 넣는 원본은 CC BY, CC BY-SA, CC0, 퍼블릭 도메인, 자기 작업뿐이다.
    - NC·ND·출판사 TDM·권리 보유 원본은 `licence_does_not_allow_sharing`이다.
    - 미확인 원본은 `licence_unknown`이다.
    - 어느 쪽이든 해시와 이유만 적는다.
    - **보관용**(`private`)은 모든 원본을 넣는다.
  - **TST-057B — 빠진 blob**: 저장소에 없거나 해시가 다른 원본은 넣지 않는다.
    - `missing_in_store` 또는 `damaged_in_store`로 적고 묶음은 `incomplete`가 된다.
    - 기록 상태도 `incomplete`이고 파일 이름에 `-incomplete`가 붙는다. 검증기도 실패로 본다.
  - **TST-057A — 검증기**(`verifyArchive`, CLI `node packages/exports/src/archive/cli.ts <zip>`; 종료 코드 0/1/2): 묶음만으로 다음을 확인한다.
    - 목록의 모든 파일이 있고 해시와 크기가 맞는다.
    - 목록에 없는 파일이 없다.
    - 같은 이름이 두 번 나오지 않는다.
    - 위험한 경로(`..` 등)가 없다.
    - 넣지 않았다는 원본이 실제로 없다.
    - CSL-JSON이 manifest가 적은 문헌 revision과 일치한다(묶음 안의 일관성 확인이다. 스냅샷이 실제로 고정한 revision인지는 만든 DB만 안다 — 리뷰 n1).
    - 묶음의 원고·문헌·그림으로 DOCX와 검사 보고를 다시 만들면 바이트가 같다(`reproduced`). manifest까지 고쳐 출력물을 바꿔치기해도 여기서 잡힌다(시험).
    - incomplete 묶음은 통과하지 않는다.
  - 저장
    - 묶음은 클 수 있어 바이트를 content-addressed asset 저장소에 두고, 행에는 SHA-256만 둔다.
    - 내려받을 때 해시를 다시 확인한다. 없거나 손상됐으면 410이다(시험).
    - 저장 전에 자기 검증기를 돌린다. 통과하지 않으면 `draft_with_errors`다(seam 시험).
- **migration `pw_057_0001`**
  - `exports.format`에 pdf와 source_archive를, `status`에 incomplete를 더했다.
  - `snapshot_id`(FK)·`purpose`·`in_asset_store` 열을 더했다.
  - 행의 모양은 `exports_archive_shape` CHECK가 강제한다(시험). 표는 불변 그대로다.
- **API·화면**
  - `POST /exports`에 `format: pdf` 또는 `format: source_archive`(`snapshot_id`, `purpose`)를 보낸다. 파일은 `application/pdf`, `application/zip`이다.
  - 내보내기 패널
    - PDF 버튼과 스냅샷 선택, 공유용·보관용 묶음 버튼
    - 넣지 않은 원본과 빠진 원본, 자체 검증·재현 결과, LibreOffice 버전과 본문 확인
  - 스냅샷을 만들면 목록이 바로 갱신된다. 시각은 다른 목록과 같은 Asia/Seoul로 맞췄다.

## 결정(위임) — RFC-014 부록
- PDF는 로컬 LibreOffice로 만든다. 새 npm 의존성은 없다.
  - LibreOffice는 시스템 프로그램이고, 사용자가 sudo 없이 설치할 수 있다(AppImage, 사용자 폴더).
  - 없으면 PDF만 안 되고 나머지는 된다.
- PDF는 바이트 재현이 안 되므로 묶음에 넣지 않는다. 묶음에는 재현되는 DOCX를 넣는다.
- 묶음 바이트는 asset 저장소에 둔다. DB 행은 해시뿐이다. 백업은 DB와 asset 저장소를 함께 다뤄야 한다(PW-060).
- 공유용 자동 포함 라이선스는 위 다섯 가지뿐이다. ND와 NC도 일부 재배포를 허락하지만 조건(비상업, 변경 금지)을 앱이 보장할 수 없어 보수적으로 뺀다. 필요하면 보관용으로 만든다.

## 변경 파일
- write scope
  - `packages/exports/src/pdf/{index,service}.ts`
  - `packages/exports/src/archive/{index,service,cli}.ts`
  - `db/migrations/pw_057_0001_pdf_archive.sql`
  - `tests/tasks/PW-057/{archive.test.ts(unit 20), pdf.test.ts(unit 5), archive.int.test.ts(통합 10), archive.e2e.ts(브라우저 1)}`
  - `reports/tasks/PW-057/**`
- 범위 밖(RFC-014 부록 PW-057)
  - `packages/exports/src/docx/service.ts`(공통 경로 분리, 기록 열, 저장소 읽기)
  - `packages/domain/src/imports/docx/zip.ts`(`openZip` 상한 인자)
  - `apps/api/src/exports/index.ts`, `apps/api/src/server.ts`
  - `apps/web/src/features/exports/ExportPanel.tsx`, `apps/web/src/features/versions/VersionsTab.tsx`, `apps/web/src/features/paper/SnapshotsTab.tsx`

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-057-A / TST-057A | `archive.test.ts`(목록=ZIP, 해시, 문헌 revision, 결정적 바이트, 변경·삭제·추가·출력물 바꿔치기, 이중 이름, 위험 경로, manifest 없음, revision 불일치, CLI 0/1/2) | 통과 |
| | `archive.int.test.ts`(스냅샷 이후 편집 미반영, 캡션 시점, AI 도움 기록 시점, 내려받기 SHA, 자체 검증 `reproduced`) | 통과 |
| | `archive.e2e.ts`(화면에서 스냅샷→공유용 묶음→내려받기→`verifyArchive` 통과) | 통과 |
| REQ-057-B / TST-057B | unit: 공유 불가·미확인 라이선스 제외와 이유, 보관용 전체, 빠진·손상 blob → incomplete, 목록을 고쳐 complete로 위조해도 실패 | 통과 |
| | 통합: cc-by-nc PDF·그림 파일(unknown) 제외, cc-by 포함, 저장소에서 지운 blob → incomplete·`-incomplete`·검증 실패, 손상 → damaged_in_store, 묶음 자체가 사라짐 → 410, 행 모양 CHECK | 통과 |
| PDF | `pdf.test.ts`(실제 LibreOffice 변환과 본문 확인, 없음 → PdfUnavailable, 빈 결과·PDF 아님·멈춤 → PdfFailed(10초 안), 환경 격리), 통합(201·`%PDF-`·SHA, 없음 → 409·저장 없음), 브라우저 | 통과 |

## RED → GREEN
- RED: `reports/tasks/PW-057/red.log` — 모듈이 없어 archive 시험 실패(`Cannot find module …/archive/index.ts`)
- PDF 시험은 모듈 초안과 함께 썼다. 그래서 RED 대신 mutation(아래 PDF 6종 탐지)이 시험이 무는 것을 보인다.
- GREEN: unit 25, 통합 10, 브라우저 1

## Mutation(`mutation.log`)
- 첫 회차 26종 중 24종을 잡았다.
- 살아남은 2종
  - "공유용인데 공유 불가 원본도 읽음": 동치다. `buildArchive`가 바이트를 보기 전에 제외하므로 읽는 시간과 크기 상한만 다르다.
  - "자체 검증 무시": 검증기 seam을 더하고 시험을 추가해 잡았다.
- "캡션 시점 무시"는 첫 회차에서 SQL 매개변수 오류로 잡혀 의미 있는 탐지가 아니었다. 매개변수를 쓰는 변형으로 바꾸고 시점 시험을 더해 잡았다.

## 회귀
- typecheck, lint 통과
- `pnpm test` 1회차 실패(`test-run1-failed.log`): PW-007의 "조건부 skip 금지" 규칙(TST-007B)이 PDF 시험의 `test.skipIf(!soffice)`를 잡았다.
  - LibreOffice가 없을 때 조용히 건너뛰는 대신 이유를 밝히고 실패하도록 바꿨다(브라우저 시험의 분기도 같다).
  - 규칙의 예외 표시(`allowed-skip:`)는 쓰지 않았다.
- `pnpm test` 2회차 실패(`test-run2-failed.log`): PW-056 거부 시험이 "모르는 형식"의 예로 `pdf`를 썼는데, 이번 Task에서 `pdf`가 실제 형식이 됐다.
  - 예를 아직 없는 형식(`odt`)으로 바꿨다(`tests/tasks/PW-056/export.int.test.ts:105`, RFC-014 부록).
  - 거부 규칙 자체는 그대로다.
- 리뷰 요청 뒤 스스로 고친 것: 같은 바이트가 공유 가능 라이선스와 불가 라이선스로 두 번 기록된 경우, 공유용 묶음에서 그 바이트를 빼고 `licence_conflict`로 적는다(unit 시험 추가).
- `pnpm test` 3회차 exit 0(`test-run3-prereview.log`, 리뷰 반영 전 코드)
- `pnpm test` 4회차 exit 0(`test.log`, 리뷰 반영 후): unit 535, 통합 612, 계약 17, 브라우저 100
- 리뷰 반영 확인 mutation 6종 모두 탐지(`mutation.log` 끝)

## 보안·과학적 실패 경로
- 권리 없는 원문이 공유 묶음에 들어감: 허용 목록 방식이다. 미확인은 제외한다. 검증기가 "넣지 않았다는 원본이 있음"을 잡는다.
- 빠진 원본을 숨긴 성공 표시
  - 빌드는 incomplete로 만들고, 기록 상태와 파일 이름도 incomplete다.
  - manifest를 complete로 고쳐도 파일이 없어 검증이 실패한다.
- 출력물 위조: 해시를 맞춘 manifest라도 다시 렌더하면 잡힌다.
- 압축 해제 경로 공격: 위험한 경로는 검증 실패다. 앱은 묶음을 디스크에 풀지 않는다.
- 변환기: HOME과 프로필이 격리되고, 비밀 환경 변수는 넘기지 않으며, 시간 상한이 있다(시험). 사용자의 LibreOffice 설정을 건드리지 않는다.
- 연구 기록: 묶음의 스토리·아웃라인·프로필·AI 기록은 스냅샷 시점 기준이다. 나중 상태로 덮이지 않는다(캡션·AI 기록 시험).

## 미검증·남은 위험
- Microsoft Word·Acrobat에서 열어 보지 않았다(LibreOffice·pdftotext만).
- PDF의 배치·글꼴은 설치된 글꼴에 따른다. 한글 글꼴이 없는 서버에서는 한글 제목이 빠져 `pdf_text_missing` 경고가 날 수 있다.
- 그림 파일의 라이선스를 바꿀 경로가 아직 없다(PW-036의 정책 변경은 원문 PDF만 받는다). 그래서 자기 그림도 공유용 묶음에서 빠진다(`licence_unknown`). 보관용에는 들어간다. 그림 정책 결정 경로는 후속 RFC 대상이다.
- 묶음은 메모리에서 만들고 검증하며, 내려받기도 한 번에 읽는다. 원본 합계 상한은 256 MiB다(리뷰 m3). 이보다 큰 보관용 묶음은 거부된다. 스트리밍 생성은 후속 과제다.
- 저장 트랜잭션이 실패하면 asset 저장소에 묶음 blob이 남을 수 있다(content-addressed라 해는 없고, 정리 작업은 없다).
- 공유용 판단은 내보낼 때의 최신 라이선스 결정을 쓴다(스냅샷 시점 아님). 권리 판단은 현재 지식이 맞다는 판단이다.
- 학술지 CSL 양식은 여전히 적용하지 않는다(PW-056 결정).

## 독립 리뷰(1차: changes requested) — 반영
- **M1**: manifest에서 `render`를 지우면 다시 렌더를 건너뛰어 바꿔치기한 DOCX가 complete로 통과했다.
  - 원고 문서나 `outputs/`가 있으면 `render`가 반드시 있어야 하고, `render.document_id`는 묶음의 manuscript 문서여야 한다.
  - 리뷰 probe를 시험으로 옮겼다(출력물 제거, 다른 문서 지정 포함).
- **m1**: 보관용 묶음의 `purpose`를 share로 고치면 통과했다.
  - share 묶음의 모든 `assets/*`는 공유 가능 라이선스여야 한다.
  - 원본은 자기 해시 이름으로만 있어야 한다(시험).
- **m2**: pdftotext가 없어 본문을 확인하지 못한 PDF가 clean이었다.
  - 이제 경고 `pdf_text_not_checked`가 붙고 `needs_attention`이다(통합 시험).
- **m3**: 묶음을 메모리에서 만든다. 원본 합계 상한을 1 GiB에서 256 MiB로 낮췄다. 스트리밍 생성은 남은 위험이다.
- **n1**: 검증 문구를 "manifest와 일치"로 바꿨다(코드 메시지·이 보고서).
- **n2**: 철회 표시는 스냅샷 시점이 아니라 내보낼 때의 철회 공지다. 라이선스와 같이 현재 지식을 쓴다. 그래서 같은 스냅샷이라도 나중에 철회 공지가 생기면 묶음의 DOCX 검사 보고가 달라진다. `manifest.render.retracted`에 기록된다.
- **n3**: 기록 저장 실패 시 저장소에 묶음 blob이 남는다(위 남은 위험). PW-060 백업·정리에서 다룬다.

## 재리뷰(approve)
- M1·m1은 리뷰어의 원래 probe로 막힌 것을 확인했고, m2·m3는 코드와 시험으로 확인했다.
- 서명 없는 검증의 본질적 한계는 남는다. 원고를 고쳐 위조 DOCX와 같은 렌더가 나오게 하거나 라이선스 문자열을 위조하는 것은 막지 못한다. 그래서 보고서와 CLI 문구는 "manifest와의 일관성"이라고 쓴다.
- NIT n1(상한 초과 메시지가 공유용을 권함): 원본 자체는 asset 저장소와 백업(PW-060)에 있고, 공유용은 실을 수 없는 원본을 뺀다는 안내로 바꿨다. PW-057 시험을 다시 돌렸다.

## 다음
PW-058(Reviewer·제출판 freeze)
