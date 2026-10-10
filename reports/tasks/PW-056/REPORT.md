# PW-056 — DOCX·CSL export — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
- **DOCX 렌더러**(`packages/exports/src/docx`): 앱이 직접 쓴다(외부 프로그램 없음, 새 의존성 없음).
  - 인용 표지, 참고문헌, 그림·표 번호는 편집기 화면과 같은 고정 렌더러(editor-core references, `pw-builtin-1`)로 저장된 문헌과 사용자의 그림 순서에서만 계산한다. 없는 id는 `[?]`로 쓰고 채워 넣지 않는다.
  - Word 스타일: Normal, Title, heading 1–6(탐색 창 목차), Bibliography(내어쓰기), Caption, 테두리 표
  - 굵게, 기울임, 아래·위 첨자, 표, "References" 절, "Figure and table legends" 절(최신 그림 버전의 캡션, 없으면 제목)
  - 같은 입력은 같은 바이트다(고정 시각, 고정 순서).
- **내보내기 검사**(`check.ts`)
  - 오류: 저장된 문헌이 없는 인용, 없는 그림·표 참조, 글자로 친 인용 모양(`[12]`, `[3, 5–7]`, `(Smith et al., 2019)`, `(Kim & Lee 2020a)` — 예컨대 모델이 쓴 번호), 다시 읽은 내용이 다름
  - 경고: 수식을 LaTeX 글자로 넣음, 연도·저자 없는 문헌, 제어 문자 제거
  - 상태: `clean`(아무것도 없음), `needs_attention`(경고), `draft_with_errors`(오류. 파일 머리글에 "초안 — … 제출용이 아닙니다"가 들어감)
- **되읽기 확인**: 쓴 파일을 앱의 DOCX 읽기(PW-055)로 다시 읽어 블록마다(종류, 제목 수준, 글자와 서식, 표 셀) 원래 의도와 비교한다. 다르면 오류(`readback_mismatch`)다.
- **CSL-JSON**: 인용된 문헌의 저장된 CSL-JSON 기록을 참고문헌 순서대로, 안정 id와 함께 낸다. 문헌 관리기(Zotero 등)에서 아무 학술지 CSL 양식으로 다시 꾸밀 수 있다.
- **기록**(migration `pw_056_0001`, `service.ts`)
  - 내보내기 한 건은 만든 revision(현재 head, share lock으로 읽음), 형식, 상태, 검사 보고, 렌더러·양식 버전, 파일 바이트와 SHA-256이다.
  - 바뀌거나 지워지지 않는다. 내려받기는 저장된 바이트다.
- API: `POST/GET /api/papers/:id/exports`, `GET …/exports/:exportId/file`(attachment, `nosniff`; 초안은 파일 이름에 `-draft`)
- 화면: 버전 탭의 "내보내기"(Word, CSL-JSON, 목록, 상태, 문제, 내려받기)

## 결정(위임) — RFC-014 부록
- P00 결정은 pandoc과 citeproc를 별도 프로세스로 쓰는 것이었다. 이를 **앱이 직접 쓰는 DOCX**로 바꿨다. 이유는 셋이다.
  1. 연구실 서버(sudo 없음)에 pandoc 설치가 필요 없다.
  2. 화면과 파일의 번호·참고문헌이 같은 고정 렌더러에서 나온다.
  3. 바이트가 결정적이다.
- 학술지별 CSL 양식은 DOCX 안에 적용하지 않는다. CSL 엔진(citeproc)을 버전 고정해 들이는 것은 새 의존성이라 별도 RFC 대상이다. 대신 CSL-JSON을 낸다.

## 변경 파일
- write scope
  - `packages/exports/src/docx/{zip,render,check,index,service}.ts`
  - `db/migrations/pw_056_0001_exports.sql`
  - `tests/export/docx/{golden.ts, render.test.ts(unit 10)}`
  - `tests/tasks/PW-056/{export.int.test.ts(통합 5), export.e2e.ts(브라우저 1)}`
  - `reports/tasks/PW-056/**`(LibreOffice 확인 결과 포함)
- 범위 밖(RFC-014 부록)
  - `apps/api/src/exports/index.ts`, `apps/api/src/server.ts`
  - `apps/web/src/features/exports/ExportPanel.tsx`, `apps/web/src/features/versions/VersionsTab.tsx`
  - `packages/exports/package.json`, `apps/api/package.json`, `pnpm-lock.yaml`(workspace 내부 연결만; 외부 의존성 없음)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-056-A / TST-056A: golden fixture의 의미/인용/표/글자 formatting이 내보낸 문서에서 확인된다 | unit: golden 논문을 내보내고 다시 읽으면 블록 11개가 그대로다(제목 1·2, 기울임 종명, H₂O, 10³, 굵게, `[1, p. 4]`, `[2]`, "Figure 1", "Table 1", 이스케이프된 `& <safe> "quotes"`, 표 2×2, References 2건 = 고정 렌더러의 참고문헌과 같은 글, 인용 안 한 문헌 없음, 범례 2). styles.xml에 heading/Title/Bibliography/Caption이 있고, 상태 clean, 되읽기 일치. author-year 양식의 표지·목록. 같은 입력은 같은 SHA-256. 수식은 LaTeX 글자와 경고. 통합: 저장된 문헌·그림 캡션이 있는 논문 → 현재 head revision으로 clean, 내려받은 바이트 SHA = 기록, 파일 안 글이 계산된 표지·목록·범례와 같다. CSL-JSON은 저장된 기록(id, DOI). 뒤에 고쳐도 내보낸 파일은 그대로이고, UPDATE·DELETE는 immutable로 거부. 브라우저: 내려받기 SHA = 기록, `PK` 파일. **LibreOffice 24.2**로 연 golden 파일의 글과 쪽 그림(`libreoffice-golden.txt`, `libreoffice-golden-page1.png`) |
| REQ-056-B / TST-056B: LLM이 인용번호를 만들거나 누락된 reference를 채운 뒤 정상 export로 표시하지 않는다 | unit: 없는 문헌 인용 → `[?]`, 오류, `draft_with_errors`, 파일 머리글 "초안". 글자로 친 `[12]`, `[3, 5–7]`, `(Smith et al., 2019)`, `(Kim & Lee 2020a)`는 모두 오류다. 보통 괄호(`(n = 3)`, `[at 60 °C]`, 연도)는 clean. 없는 그림 참조는 오류, 연도 없는 문헌은 경고. 블록을 빠뜨리는 writer는 되읽기 오류와 초안 머리글. 통합: 원고의 `[7]` → draft_with_errors(예 `[7]`). 브라우저: `[7]`을 친 원고 → "초안 — 고칠 문제 있음"과 이유, 지우면 "검사 통과" |

## RED → GREEN
- RED(`red.log`): unit은 모듈 없음, 통합 5개 모두 실패(route 없음).
- GREEN: unit 10, 통합 5, 브라우저 1, typecheck·lint 통과. 화면 증거 `1-draft-export.png`, `2-clean-export.png`
- mutation(`mutation.log`): 16종 모두 탐지
  - "되읽기 무시" 변이는 처음에 살아남았다(writer가 늘 일치). writer를 바꿔 끼울 수 있게 하고 블록을 빠뜨리는 writer 시험을 더해 탐지했다.
  - "locator 삭제" 변이는 패턴 오류로 한 번 적용되지 않아 다시 돌렸다.
- 회귀: `pnpm test` (`pnpm-test.log`, 아래)

## 보안·과학적 실패 경로
- 번호와 참고문헌은 저장된 문헌에서만 계산한다. 모델이 쓴 번호 글자, 없는 문헌, 없는 그림은 검사가 오류로 잡는다. 그런 파일은 "검사 통과"로 보이지 않고, 파일 자체가 초안이라고 말한다.
- 내보낸 파일은 기록(revision, 해시, 보고)과 함께 바뀌지 않는다.
- 제출 확정이나 자동 투고는 없다(사용자 행위, PW-058).

## 미실행 / 남은 위험
- **Microsoft Word로 열어 보지 않았다**(이 환경에 없음). LibreOffice 24.2로 열고 PDF로 그려 확인했다.
- 학술지별 CSL 양식, Word 수식(OMML), 그림 파일 삽입, 각주는 DOCX에 넣지 않는다. 수식은 LaTeX 글자(경고)이고, 그림은 범례만 있다.
- 인용 모양 글자 검사는 정규식이다. 흔한 형식(`[n]`, `(저자 연도)`)만 잡는다. 위첨자 숫자 인용이나 다른 언어 형식은 놓칠 수 있다.
- 내보내기는 요청 안에서 동기로 만든다. 원고 크기에 비례한다(큰 원고는 몇 초).
- 내보낸 파일은 DB에 바이트로 쌓인다. 보존·정리 정책은 없다(PW-060 백업 대상).

## 다음
PW-057: PDF·재현 source archive
