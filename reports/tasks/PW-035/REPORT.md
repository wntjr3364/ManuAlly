# PW-035 — PDF parsing·highlight locator — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_035_0001_pdf_extraction_anchors.sql`
  - `jobs` intent에 `parse_source`를 추가했다(공유 schema, RFC-011 부록).
  - `pdf_extractions`: 원본 revision + sha256 + 추출기 버전마다 하나. 상태 `ok`/`no_text`/`failed`(실패면 이유가 있고 쪽은 없다).
  - `pdf_pages`: view box, `/Rotate`, 텍스트, 위치가 있는 text run, 읽기 순서 위험 flag
  - `pdf_anchors`: 원본 revision, sha256, 0부터 세는 쪽, 정규화 quadpoints, 정확한 인용, prefix/suffix, 추출기 버전, 정밀도(`run_interpolated`)
  - 모든 표는 바꿀 수 없다.
- `apps/worker/src/pdf/`
  - `extract-child.mjs`: 별도 process에서 실행한다. stdin으로 PDF를 받아 JSON 한 줄을 낸다.
    - 글꼴을 불러오지 않고 XFA도 끈다.
    - `stopAtErrors`이므로 읽지 못하는 쪽이 하나라도 있으면 문서 전체가 실패한다(부분 텍스트 없음).
  - `extract.ts`
    - child 실행 조건: 메모리 상한(`--max-old-space-size`), 시간 제한(넘으면 process group 전체 SIGKILL), 출력 상한, 빈 환경변수(비밀 상속 없음)
    - 쪽 flag: `no_text`, `page_rotated`, `rotated_text`, `hyphenation`, `possible_columns`
  - `index.ts`: `parse_source` job handler.
    - 내용 주소 저장소에서 hash를 검증하며 읽는다.
    - 같은 원본·추출기면 다시 하지 않는다.
    - 결과는 fenced 완료 트랜잭션에서 한 번에 저장한다.
- 범위 밖(RFC-011 부록)
  - `packages/domain/src/pdf/index.ts`
    - `requestExtraction`: 보관 권리가 unknown이면 거부한다(PW-034 리뷰 MINOR 3).
    - `extractionView`
    - `quadsFor`: text run의 변환 행렬을 쓴다. 회전된 글자도 처리한다. run 안의 위치는 글자 폭 가중치(Helvetica AFM)로 나눈다.
    - `createAnchor`
      - 선택한 인용이 그 쪽에 prefix/suffix와 함께 정확히 한 번 있을 때만 만든다.
      - 없음, 여럿, 텍스트 없음, 추출 실패, hash 불일치는 거부한다.
    - `resolveAnchor`: 다시 열 때 원본 hash와 그 위치의 텍스트를 확인해 ok, 아니면 stale
    - `listAnchors`
    - `candidatesInRevision`: 다른 revision에서는 확정하지 않은 후보만 보여 주고, 저장하지 않는다.
  - `apps/api/src/pdf/index.ts`(route: 추출 요청, 추출 보기, 위치 확인·목록·다시 열기·후보), `apps/api/src/server.ts`(등록)
  - `apps/worker/src/main.ts`(handler 등록, 저장 폴더 `defaultAssetDir()`)
  - `tests/e2e/manual-paper/harness.ts`(임시 저장 폴더와 handler)
  - `packages/domain/src/jobs/index.ts`(intent)
  - `apps/web/src/app/api.ts`(`apiRaw`: CSRF와 함께 원본 바이트를 올림)
  - `apps/web/src/features/paper/PaperPage.tsx`("원문" tab)
  - 의존성: `pdfjs-dist@6.4.299`(P00 결정 기록에 고정된 버전, Apache-2.0)를 worker·web에 정확한 버전으로 넣었다.
    - pdfjs의 선택 의존성인 native `@napi-rs/canvas`는 root `pnpm.overrides`(`"-"`)로 뺐다. 텍스트 추출에는 필요 없고 native 표면만 늘리기 때문이다.
- `apps/web/src/features/pdf/`(`SourceDocsTab.tsx`, `labels.ts`): "원문" tab
  - 원본 올리기(라이선스, 외부 전송 선택)와 목록(권리 표시)
  - 보관 근거 정하기, 텍스트 추출
  - 쪽 그림(pdfjs **legacy** build. modern build는 `Map.getOrInsertComputed` 같은 아주 새 내장 기능이 필요해 Playwright Chromium에서 실패했다)
  - 추출 텍스트에서 선택 → "선택을 근거 위치로 확인"
  - 확인한 위치 목록 → "다시 열기"로 쪽 위 형광 상자 표시(`/Rotate` 포함, viewport 변환)
- 시험
  - `tests/tasks/PW-035/fixtures.ts`(합성 PDF)
  - `pdf.int.test.ts`(통합 13)
  - `pdf.e2e.ts`(브라우저 1)
  - 증거 화면: `anchor-reopened.png`, `rotated-page.png`

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-035-A / TST-035A 확인한 문장의 페이지/quadpoint/quote/source hash를 다시 열 수 있다 | 통합: 추출이 쪽마다 텍스트, 크기, 회전, flag를 저장한다(두 번째 요청은 같은 추출) |
| | 통합: 선택한 인용 → anchor(원본 id, sha256, 0쪽, quadpoints, exact, prefix/suffix, 추출기). 다시 열면 같은 기록이고, 남은 404, 표는 바꿀 수 없다 |
| | 통합(unit): 기하 계산 — 같은 폭, 좁은/넓은 글자, 세로 글자, 두 run에 걸친 인용 |
| | 브라우저: 올리기 → 추출 → 선택 → 확인 → reload → 다시 열기 → 상자가 그 문장 위에 있다(좌표 검사, 화면 증거). 회전된 쪽에서도 확인하고 다시 연다 |
| REQ-035-B / TST-035B 추출 실패/회전/새 PDF revision에서 근거 위치를 추측해 확정하지 않는다 | 통합: 없는 인용은 404, 여러 번 나오는 인용은 409(문맥을 주면 1개). 쪽이 없으면 404 |
| | 통합: 텍스트 없는 PDF(그림)는 `no_text`이고 위치 확정을 거부한다. 텍스트 있는 문서의 그림 쪽도 거부한다 |
| | 통합: 읽을 수 없는 PDF는 `failed`(쪽 없음, 이유 기록). 읽을 수 없는 쪽이 하나라도 있으면 전체 실패. 시간 초과도 실패다 |
| | 통합: 회전된 쪽은 원래 방향 좌표 + rotate로 저장한다. 기울어진 글자는 flag를 단다 |
| | 통합: 새 revision에는 자동 위치가 없다. 후보만 보여 준다(`confirmed: false`, 저장 안 함). anchor는 원래 revision과 hash를 그대로 가리킨다. 추출 전이면 `not_extracted`다 |
| | 통합: 보관 권리 unknown이면 추출을 거부한다. 디스크 원본이 바뀌면 job이 실패한다(integrity) |
| | 통합: 기록이 쪽 텍스트와 맞지 않으면 stale로 보인다 |

## RED → GREEN
- RED(`red.log`): 구현(migration, domain·api·worker 모듈)을 빼면 모듈이 없어 실패했다.
  - 행동 단위 RED는 mutation이 맡는다.
- GREEN: 통합 13, 브라우저 1
- mutation(`mutation.log`): 19종 중 처음 5종이 살아남았다.
  - 그림 쪽 거부 이유, stale 표시, 재추출 결과, 파서 오류 문구, stopAtErrors
  - 시험을 더한 뒤 4종을 탐지했다. 1종은 동치다(이유를 기록).
- 개발 중 발견하고 고친 것
  - pdfjs 6에서는 `destroy`가 문서가 아니라 loading task에 있다.
  - pdfjs 6에는 `isEvalSupported` 옵션이 없다. pdfjs 6 코드에는 eval 경로가 없다(확인함).
  - 처음 상자는 글자 수를 균등 폭으로 나눠 한 글자쯤 어긋났다(화면으로 확인). 글자 폭 가중치로 고쳤다.
- 회귀: `pnpm test` exit 0 — unit 278, integration 328, contracts 17, 브라우저 83(`pnpm-test.log`)

## 보안·과학적 실패 경로
- 근거 위치를 추측하지 않는다. 사용자가 고른 인용이 그 쪽 텍스트에 정확히 한 번 있을 때만 확정한다. 실패, 그림, 모호함, 다른 revision은 확정하지 않는다.
- 새 PDF revision으로 이전 좌표를 옮기지 않는다(spec 05). 후보만 보이고, 확정은 사용자가 새로 한다.
- 파서는 별도 process다. 메모리·시간·출력 상한과 빈 환경으로 돌고, 신뢰할 수 없는 입력으로 다룬다.
- 원본은 hash를 확인하고 읽는다. 보관 근거가 unknown이면 열거나 파싱하지 않는다.

## 미실행 / 남은 위험
- 파서 process의 network 차단과 파일시스템 격리는 아직 없다. PW-026 sandbox(unshare)로 감싸는 것은 RFC-010 구현과 함께 한다. 지금은 메모리·시간·출력 상한과 빈 환경만 있다.
- 위치 정밀도: run 안의 글자 위치는 표준 글꼴 폭 가중치로 근사한다(`run_interpolated`, 기록에 남김). 실제 글꼴이 다르면 상자가 조금 어긋날 수 있다. 줄과 쪽은 정확하다.
- 실제 논문 PDF(다단, 수식, 표, 스캔본)로 시험하지 않았다. 합성 fixture만 썼다. 다단 `possible_columns`와 하이픈 flag는 휴리스틱이다.
- OCR은 하지 않는다(spec: 이미지 문서는 opt-in fallback, 이후 Task).
- 누락 글꼴(`/F9`)인 쪽은 pdfjs가 오류 없이 텍스트를 비워 낼 수 있다. 그런 쪽은 `no_text`로 보이고 위치 확정을 거부한다(보수적).
- GROBID 같은 구조 추출은 쓰지 않는다(P00: 선택 서비스).
- 웹 화면은 Chromium에서만 확인했다(Firefox·Safari 미실행, P01부터 열린 항목).

## 다음
PW-036: Figure/Table/Fact 출처 연결

## 리뷰 반영 (2026-10-09, 리뷰: changes requested — MINOR 2, NIT 4. PW-034 재리뷰 반영 확인)
- MINOR 1: 메모리 상한이 실제로 걸리지 않았다
  - 원인: `--max-old-space-size`는 V8 heap만 묶는다. pdf.js의 풀린 stream은 typed array라서 그 밖이다.
  - 이제 `prlimit --data`(RLIMIT_DATA, 기본 1 GiB)로 child를 실행한다. `prlimit`이 없으면 파싱하지 않는다(재시도 가능한 실패).
  - 시험: 408 KB 파일이 400 MB로 풀리는 폭탄 PDF를 상한 192 MB에서 돌린다. V8이 메모리 한도에서 SIGTRAP/SIGABRT로 끝나므로 1초 안팎에 멈춘다.
  - 이는 파일의 성질이다. "필요한 메모리가 허용보다 큼"으로 실패를 저장한다.
  - 업로드 검사에서 모든 Flate stream을 풀어 크기를 재지는 않았다. 그림이 많은 정상 논문은 수백 MB로 풀릴 수 있어 오거부가 생기고, API process 메모리도 쓰기 때문이다. 폭탄은 파서의 상한이 막는다.
- MINOR 2: 일시적 실패가 영구 결과로 남았다
  - 파일에 달린 실패(파싱 오류, 메모리, 출력 과다, 숫자 아닌 위치)만 이 추출기 버전의 결과로 저장한다.
  - 시간 초과, 시작 실패, 그 밖의 signal 종료는 job만 실패하고 아무것도 저장하지 않는다. 다시 요청할 수 있다(시험: 시간 초과 뒤 재요청이 성공).
- nit
  - 보관 권리를 쓸 때마다 다시 본다: worker가 실행할 때, 추출 텍스트 보기, 위치 확인, 다른 revision 후보.
    - 소유자가 근거를 철회하면 텍스트가 보이지 않고 새 위치도 만들 수 없다.
    - 이미 확인한 위치 목록(짧은 인용)은 소유자 기록이라 계속 보인다.
  - `pdf_anchors(extraction_id, asset_revision_id)` → `pdf_extractions(id, asset_revision_id)` 복합 FK(`pw_035_0002`)
  - child 출력 검사(`extractorPagesValid`): 숫자가 아닌 위치나 텍스트 밖의 run이 있으면 추출 실패다. 대역 child로 시험했다(`childPath`는 시험 전용 옵션).
  - child stderr의 `@napi-rs/canvas` 경고는 무시해도 된다. stderr를 모으게 되면 log에 보일 수 있다(기록만).
- 남은 위험 갱신
  - 파서의 메모리 상한은 이제 실제로 걸린다(RLIMIT_DATA).
  - network와 파일시스템 격리는 아직 RFC-010(sandbox) 몫이다.
  - 브라우저의 pdf.js 렌더링은 사용자 기기 메모리를 쓴다(소유자 자신의 파일).
- 시험: 통합 18(+5). RED는 `review-red.log`. mutation은 `mutation.log` 끝에 있고 모두 탐지했다.
- 회귀(리뷰 반영 후): `pnpm test` exit 0 — unit 278, integration 333, contracts 17, 브라우저 83(`pnpm-test-review.log`).

## 재리뷰 반영 (2026-10-09, 재리뷰: MINOR 1 고치면 approve, nit 1)
- MINOR: 파서 자체가 뜨지 못하면(모듈 누락, 설치 손상) 모든 PDF가 영구 실패로 저장되던 문제를 고쳤다.
  - child가 단계(`stage: 'load' | 'parse'`)를 알린다.
  - 바이트를 받은 뒤(`parse`)의 오류만 파일의 결과로 저장한다. 단계가 없거나 `load`면 재시도 가능한 실패다(대역 child 시험).
- nit: 메모리 부족도 재시도 가능한 실패로 바꿨다. 상한이나 host 상황이 바뀔 수 있기 때문이다.
  - job 오류에 상한(MB)을 적는다.
  - 폭탄 PDF는 다시 요청해도 1초 안팎에 같은 이유로 멈추고 저장되는 것은 없다.
- 시험: 통합 19. 되돌림 mutation 3종을 탐지했다(RED 증거 겸용).
- 회귀: PW-035 통합과 lint로 확인했다. 전체 `pnpm test`는 다음 커밋(PW-036)과 함께 돌린다.
