# PW-055 — DOCX import와 손실 보고 — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
- **변환기**(`packages/domain/src/imports/docx`): 새 의존성 없이 만들었다(`node:zlib`, 작은 XML 읽기).
  - `zip.ts`: ZIP을 읽는다. ZIP64와 암호화는 거부한다. 항목은 2,000개, 풀린 크기 합은 50 MiB까지다(ZIP bomb). 항목은 선언 크기 넘게 풀지 않고, CRC를 확인한다. 디스크에 쓰지 않는다.
  - `xml.ts`: DOCTYPE와 정의되지 않은 엔티티를 거부한다. 외부 참조는 가져오지도 펼치지도 않는다.
  - `parse.ts`: WordprocessingML을 공유 편집기 문서로 바꾸고 손실 보고를 만든다.
    - 유지: 문단; 제목(styles.xml의 이름 기준이라 한국어 Word의 숫자 style id도 됨: heading 1~6, Title); 굵게, 기울임, 아래·위 첨자; 표(셀 글자)
    - 글자로 남기고 보고: 인용 필드(Zotero, Mendeley, EndNote, CSL — 문헌 관리기 연결은 끊김), 참고문헌 필드, 그 밖의 필드, 수식(글자), 링크(글자), 각주·미주(`[n]` 표시와 원고 끝 문단)
    - 넣지 않고 보고: 댓글(달린 글자는 남고, 댓글 내용은 보고에 있음), 그림·도형, 병합·중첩 표 배치, 목록 번호·기호(항목 글은 문단으로 남음), 서식 변경 추적
    - **변경 내용 추적**: 수락·거부하지 않은 삽입·삭제가 있으면 사용자가 "수락한 글" 또는 "변경 전 원문"을 고를 때까지 미리 보기를 만들지 않는다(422 `TRACKED_CHANGES_CHOICE`, 개수 포함). 고른 것은 보고에 남는다.
    - 보고의 `round_trip`은 늘 `not_supported`다.
    - 결과는 편집기 schema 검증을 통과해야 한다.
  - `index.ts`
    - `createDocxImport`: 받은 바이트를 그대로 저장한다(SHA-256 포함, 10 MiB까지). 그 뒤 변환 결과를 미리 보기와 보고로 저장한다.
    - `importOriginal`: 원본 내려받기
    - 적용은 기존 경로다(PW-021 `applyImport`): 새 원고, 또는 확인과 본 head를 갖춘 새 버전. 지금 원고는 이전 revision으로 남는다.
- **API**: `format: docx`, 원본 내려받기(`attachment`, `nosniff`)
- **화면**(`apps/web/src/features/import/DocxImport.tsx`, 버전 탭)
  - Word 파일을 고르면 변환한다. 변경 추적이 있으면 개수와 함께 어느 글을 가져올지 묻는다.
  - 미리 보기, 손실 목록(종류별 안내, 개수, 예), "왕복 변환 아님" 경고, 원본 내려받기 링크를 보인다.
  - 그 뒤에만 새 원고 또는 새 버전(확인 필요)을 만든다.

## 변경 파일
- write scope
  - `packages/domain/src/imports/docx/{zip,xml,parse,index}.ts`
  - `apps/web/src/features/import/DocxImport.tsx`
  - `db/migrations/pw_055_0001_docx_import.sql`
  - `tests/tasks/PW-055/{fixture.ts, docx.test.ts(unit 13), docx-import.int.test.ts(통합 6), docx-import.e2e.ts(브라우저 1)}`
  - `tests/tasks/PW-055/fixtures/`: LibreOffice 24.2·pandoc 3.1로 만든 실제 .docx 2개와 그 원본, 만든 방법(README)
- 범위 밖(RFC-014 부록): `apps/api/src/imports/index.ts`, `apps/web/src/features/versions/VersionsTab.tsx`, `packages/domain/src/imports/text/index.ts`(문구 하나)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-055-A / TST-055A: 사용자가 변환 손실을 확인하고 새 문서/새 revision으로 가져온다 | unit: 깨끗한 논문(제목, 한국어 style id 제목, 기울임, 굵게, 아래·위 첨자, `w:i w:val=0`, 새 block id). 풍부한 논문(댓글, 인용 필드, 참고문헌 필드, 수식, 병합 셀 표, 그림, 각주, 링크, 변경 추적)은 종류마다 개수와 예, 안내가 있다. 댓글 내용은 원고에 들어가지 않는다. 중첩 필드는 보이는 결과만 남는다. 실제 생산기 파일(LibreOffice 변경 추적과 댓글, pandoc 제목·기울임·표·각주) 통합: 미리 보기와 보고가 먼저이고 문서는 0개, 적용하면 새 원고(head = 미리 보기). 기존 원고에는 확인 없이 422, 확인하면 새 버전(initial → import)이고 옛 revision이 남는다. 두 번 적용은 409. 브라우저: 손실 9종이 보이고 적용 전 문서 0개, 적용 뒤 편집기에 거부한 글, 댓글 내용은 없음 |
| REQ-055-B / TST-055B: track changes/인용 field가 소실돼도 원본을 삭제하거나 완전 round-trip 지원이라고 표시하지 않는다 | unit: 고르기 전에는 미리 보기 없음(`TRACKED_CHANGES_CHOICE`, 삽입 1·삭제 1). 수락하면 "clearly", 거부하면 "barely". 추적이 없는데 고르면 거부. 모든 보고가 `round_trip: not_supported`. 통합: 고르기 전 422이고 아무것도 저장되지 않는다. SHA-256은 받은 바이트, 적용 뒤에도 원본이 바이트 그대로 내려받아진다(`attachment`). DELETE와 UPDATE는 immutable로 거부되고, 다른 owner는 404. 텍스트 가져오기와 그 원본 내려받기도 그대로 된다. 거부 대상: 텍스트, 옛 .doc(`LEGACY_DOC`), ZIP bomb(`TOO_LARGE`), 10 MiB 초과, 암호화, DOCTYPE, 크기를 속인 항목. 브라우저: 변경 추적 질문(삽입 1곳, 삭제 1곳)이 먼저 나오고 그전에는 저장이 없다. "왕복 변환 아님" 경고가 보이고, 원본 링크가 바이트 그대로 받아진다 |

## RED → GREEN
- RED(`red.log`)
  - unit: docx 모듈 없음(처음 실행은 시험의 import 경로 오류라 다시 남김)
  - 통합: 6개 모두 실패(docx 형식 없음, 내려받기 route 없음)
- GREEN: unit 13, 통합 6(PW-021 텍스트 가져오기 시험 9와 함께 통과), 브라우저 1, typecheck·lint 통과
- 화면 증거: `1-docx-preview.png`, `2-imported.png`
- mutation(`mutation.log`): 17종 중 16종 탐지, 1종 동등(목록 손실 보고 변이 포함)
  - 동등: 풀 때 상한 제거. 직후의 선언 크기 검사가 어차피 CORRUPT로 거부한다. 상한은 그동안의 메모리만 묶는다.
  - 처음 살아남은 2종은 시험을 더한 뒤 탐지했다: 필드 명령 안의 중첩 필드, 엔티티 없는 DOCTYPE.
- 회귀(리뷰 전): `pnpm test` exit 0 — unit 457, integration 596, contracts 17, 브라우저 98 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 외부 파일은 로컬에서만 변환한다. 모델로 보내지 않고, 매크로나 외부 참조를 실행하거나 가져오지 않는다.
- 원본은 받은 그대로 보관한다(불변 표, SHA-256).
- 인용 필드의 문헌 연결이 끊긴 것은 보고에 명시한다. 인용을 문헌과 다시 잇는 것은 사용자가 문헌 탭에서 한다(자동 추측 없음).
- 수식은 글자만 남긴다. 수식 의미를 추정해 LaTeX로 바꾸지 않는다.

## 미실행 / 남은 위험
- 원본 저장 시점: 읽을 수 없는 파일과 변경 추적 선택 전 업로드는 저장하지 않는다(review m3, 위 표).
- 변환은 API 요청 안에서 동기로 돈다. 한계 안에서 최악 몇 초 동안 다른 요청이 기다릴 수 있다(worker thread로 옮기지 않음).
- **Microsoft Word가 직접 만든 파일로는 시험하지 않았다**(이 환경에 Word 없음). LibreOffice·pandoc 파일과 손으로 만든 WordprocessingML로 시험했다. Word 고유 요소(콘텐츠 컨트롤의 복잡한 구조, SmartArt, 차트, 각주 안의 인용 등)는 사용자 실제 파일로 확인해야 한다.
- 목록 번호·기호(numbering.xml)는 옮기지 않는다(`list` 손실로 보고하고, 항목 글은 문단으로 남는다).
- 각주 안의 서식, 표 셀 안의 문단 구분(공백으로 합침)은 옮기지 않는다.
- strict OOXML(다른 namespace)은 접두사가 `w:`가 아니면 읽지 못한다(빈 결과가 아니라 "body 없음"으로 거부될 수 있음).
- 인용 필드를 문헌 항목(reference)으로 다시 잇는 기능은 없다(글자만).
- 크기 상한은 .docx 10 MiB다. 그림이 많은 원고는 그림을 빼고 다시 저장해야 할 수 있다.

## 다음
PW-056: DOCX·CSL export

## 리뷰 (17bd8b7): changes requested — MAJOR 2, MINOR 4, NIT 4
| 지적 | 처리 | 시험 |
|---|---|---|
| M1: 흔한 Word 내용이 보고 없이 사라짐 — Symbol 글꼴 `w:sym`(5 μM → "5 M"), `mc:AlternateContent` 안의 글상자·도형(Word 2010+), 문단 수준 AlternateContent | `w:sym`: Symbol 글꼴의 사용자 영역(F020–F0FF)을 Unicode로 바꾼다(그리스 문자, ±, ≤, °, × …). 다른 기호 글꼴은 □로 두고 `symbol`로 보고한다. AlternateContent는 run과 문단 수준 모두 이해하는 가지 하나만 읽는다(mc:Choice, 비었으면 mc:Fallback, 중복 없음). 글상자 글은 원고 끝 "[글상자]" 문단으로 남기고 `textbox`로 보고한다. 모르는 요소가 글자를 가지면 글자를 남기고 `other`로 보고한다 | 5 μM, 3 ± 1, p ≤ 0.05와 Wingdings □(보고). 글상자 글은 한 번만 들어가고 보고된다. 문단 수준 Choice의 글이 남는다. `w:dir`·`w:ruby` 글이 남고 보고된다 |
| M2: 150 KB 파일이 API를 36초·4 GB로 묶음(ZIP 50 MiB 안의 거대한 document.xml) | 부분마다 풀린 크기 10 MiB, XML 요소 50만, 중첩 256, 블록 5만으로 제한한다(넘으면 `TOO_LARGE`/`CORRUPT`, 422). 시험 기계 기준 최악 몇 초 | 한계마다 그 한계만으로 거부되는 파일(11 MB 한 문단, 60만 빈 run, 300단 중첩, 6만 문단). 큰 파일은 5초 안에 거부된다. mutation 4종 각각 탐지 |
| m1: 문단 표시·표 행·각주의 변경 추적이 세어지지 않고 선택도 따르지 않음 | 문단 표시(`w:pPr/w:rPr`)와 표 행(`w:trPr`)의 삽입·삭제를 세고 선택을 적용한다. 수락하면 삭제된 표시의 문단이 다음 문단과 합쳐지고 삭제된 행이 빠진다. 거부하면 삽입이 빠진다. 각주·미주도 세고, 본문과 같은 읽기(선택, 필드)로 읽는다 | 문단 표시 삭제(수락 → 한 문단, 거부 → 두 문단, 개수에 포함). 표 행 삭제(수락 1행, 거부 2행). 각주 안 변경(개수 포함, 수락 "See new", 거부 "See old") |
| m2: 각주 안 인용 필드와 Mendeley Cite(콘텐츠 컨트롤) 인용이 보고되지 않음 | 각주는 본문 읽기를 거친다(인용 필드 보고). `w:sdt`의 `w:citation`/`w:bibliography`, 또는 tag·alias의 CITATION/BIBLIOGRAPHY를 필드로 다룬다(본문 수준 참고문헌 컨트롤 포함) | 각주의 Zotero 인용, Mendeley `w:sdt` 인용 모두 `citation_field`로 보고되고 글은 남는다 |
| m3: 원본이 변환 성공 뒤에만 저장됨(spec "원본을 먼저 불변 저장") | **설계를 바꾸지 않고 문서화한다.** 원본은 미리 보기와 같은 트랜잭션에 받은 그대로 저장된다. 읽을 수 없는 파일(손상, 암호화, 옛 .doc, 너무 큼)과 변경 추적 선택이 필요한 첫 업로드는 거부하고 아무것도 저장하지 않는다. 사용자의 파일은 사용자에게 그대로 있고, 저장소에 쓸모없는 바이트를 쌓지 않는다. 코드 머리말을 고치고 RFC-014에 적었다 | 통합: 거부된 업로드 뒤 저장 0건 |
| m4: 깊은 중첩이 500, 속성 값 안의 `>`가 태그를 자름 | 태그 끝은 따옴표 밖의 `>`다. 중첩은 256까지만이다. 그래도 남는 RangeError는 `CORRUPT`(422)로 바꾼다 | 20만 단 중첩 → CORRUPT. `IF 2 > 1` 필드 명령 전체를 읽는다(필드 2개 보고) |
| n1 숨긴 글자, n2 위치 탭, n3 글상자가 각주 번호를 밀어냄, n4 포함 개체를 그림으로 부름 | 숨긴 글자는 넣지 않고 `hidden_text`로 보고한다. `w:ptab`은 공백이다. 글상자는 따로 모아 각주 번호에 영향이 없다. `w:object`는 `embedded_object`(ProgID 예)로 보고한다 | 각각 |

- RED(`red-review.log`): 새 시험 15개 실패
- GREEN: unit 32, 통합 6(+PW-021 9), 브라우저 1, typecheck·lint 통과(parser version `pw-docx-import-2`)
- mutation(`mutation.log` 하단): 22종 모두 탐지
  - 한계 4종은 처음에 다른 한계가 먼저 거부해 살아남았다. 한계마다 그 한계만으로 거부되는 시험을 더해 탐지했다.
- 회귀(리뷰 반영): `pnpm test` exit 0 — unit 476, integration 596, contracts 17, 브라우저 98 (`pnpm-test-review.log`)

## 재리뷰 (8b6e89c): changes requested — MAJOR 1, MINOR 2, NIT 3 (앞선 지적은 모두 해결 확인, m3은 문서화한 차이로 수용)
| 지적 | 처리 | 시험 |
|---|---|---|
| R1: 서로를 두 번씩 참조하는 각주가 지수적으로 펼쳐짐(2 KB 파일, 22단 11초, 30단이면 수십 분) | 각주·미주 안의 각주 참조는 따라가지 않는다(Word에는 각주 안 각주가 없음). `[?]`로 두고 `other`로 보고한다. 각 각주는 본문 참조에서 한 번씩만 읽힌다 | 20단 이중 참조(2^20 경로)가 2초 안에 끝나고, 블록 2개, `[1] note 0[?][?]`, 보고 있음 |
| m1': 글상자 글을 평면으로 읽어 기호·변경 추적·숨긴 글자 규칙이 빠짐 | 글상자 문단도 본문과 같은 읽기(inlines)로 읽는다 | 글상자 안 μ, 삽입(수락하면 있음, 거부하면 없음), 숨긴 글자 없음 |
| m2': 합쳐진 문단이 앞 문단의 스타일(제목)을 가짐 — Word는 뒤 문단의 것 | 합쳐진 문단은 뒤(남는) 문단의 스타일을 가진다 | 표시가 삭제된 제목 + 본문 → 본문 문단 하나 |
| n1: mc:Choice에 모르는 요소만 있으면 Fallback 글이 사라짐 | Choice는 글자나 보고하는 요소(그림, 개체, 기호, 수식)가 있을 때만 고르고, 아니면 Fallback이다 | Choice에 알 수 없는 요소만 → Fallback 글 |
| n2: 글상자 안 글상자의 글이 두 번 | 가장 바깥 글상자만 찾고, 안쪽은 바깥을 읽을 때 따로 한 번 들어간다 | "inner" 한 번 |
| n3: 모르는 요소 바로 아래 `w:t`가 "남겼다"는 보고와 달리 빠짐 | `w:t`를 바로 읽는다 | "A kept text" + `other` |

- RED(`red-rereview.log`): 새 시험 6개 실패
- GREEN: unit 38, 통합 6(+PW-021 9), 브라우저 1, typecheck·lint 통과(parser version `pw-docx-import-3`)
- mutation(`mutation.log` 하단): 6종 모두 탐지
  - 처음 m2' 변이는 값이 같은 식(`level ?? null`)이라 무효였다. 두 곳을 바꾸는 올바른 변이(앞 문단의 수준을 씀)로 다시 돌려 탐지했다.
- 남은 위험(재리뷰 확인): 한계 안 최악(각 부분 50만 요소 가까이) 3.7초·733 MB로 요청 스레드에서 돈다.
- 회귀(재리뷰 반영): `pnpm test` exit 0 — unit 482, integration 596, contracts 17, 브라우저 98 (`pnpm-test-rereview.log`)

## 3차 리뷰 (f8dd667): changes requested — MAJOR 1(R1'), NIT 1 (나머지는 모두 해결 확인)
| 지적 | 처리 | 시험 |
|---|---|---|
| R1': 같은 각주를 가리키는 본문 참조마다 각주 전체를 다시 읽음(2 KB 파일로 수 시간·수십 GB 가능) | 각 각주·미주는 한 번만 읽는다. 같은 각주의 두 번째 참조부터는 처음 번호(`[1]`)를 보이고 `other`("repeated note reference")로 보고한다. 이로써 읽는 글의 양은 각 부분 크기(10 MiB) 합을 넘지 않는다 | 큰 각주 하나에 참조 1만 개 → 2초 안, 블록 2개, `[1]`×1만, 각주 보고 1, 반복 보고 9,999(RED: 13초) |
| n1: 한계 안 최악은 여전히 요청 스레드에서 몇 초 | 남은 위험으로 기록(위) | — |

- RED(`red-third.log`): 13초로 시간 한계 실패
- GREEN: unit 39, 통합 6(+PW-021 9), 브라우저 1(parser version `pw-docx-import-4`)
- mutation: 1종 탐지
- 회귀(3차 반영): `pnpm test` exit 0 — unit 483, integration 596, contracts 17, 브라우저 98 (`pnpm-test-third.log`)

## 4차 리뷰 (426c6a5): changes requested — MAJOR 1(R2), MINOR 2 (R1' 해결 확인; 표·스타일·AlternateContent·글상자·각주는 증폭 없음 확인)
| 지적 | 처리 | 시험 |
|---|---|---|
| R2: 글 조각마다 열린 댓글 범위·열린 필드 모두에 덧붙임(1만×1만: 17–34초, 3.4 GB) | 댓글 범위는 보고 예로 보일 앞 5개 댓글만 추적한다. 예로 쓰는 글(댓글 범위, 필드 결과)은 200자까지만 모은다(글 자체는 모두 원고에 남음). 필드 중첩은 64까지만이고 넘으면 `CORRUPT`다. 명령 부분 필드 수는 셈으로 관리한다 | 열린 범위 5만 × run 5만 → 3초 안, 댓글 5만 개 보고(예 ≤120자). 끝나지 않은 필드 1만 중첩 → 3초 안 `CORRUPT`. 5,000자 인용 결과는 글은 그대로, 예는 ≤120자 |
| m1: 모르는 요소가 중첩될 때마다 글 전체를 다시 훑음 | 가장 바깥 모르는 요소에서만 글을 한 번 보고 보고한다. 안쪽은 그냥 읽는다 | 모르는 요소 250겹 × 5만 run → 3초 안, 글 50만 자, `other` 1 |
| m2: 결과 구분(separate) 없이 끝나지 않은 필드 뒤의 글이 보고 없이 사라짐 | 명령 부분에서 만난 글은 가장 안쪽 필드가 들고 있다. separate에서 버리고(중첩 필드 결과처럼 명령의 일부), 결과를 보이지 않고 끝나면 그 자리에 되돌리고 `field`("a field without a shown result")로 보고한다 | "Before important result 2.4-fold"와 보고. 중첩 필드 시험(명령 안 결과는 버림)도 그대로 통과 |

- RED(`red-fourth.log`): 새 시험 4개 실패(최대 57초)
- GREEN: unit 44, 통합 6(+PW-021 9), 브라우저 1(parser version `pw-docx-import-5`)
- mutation(`mutation.log` 하단): 5종 모두 탐지
  - "모든 댓글 추적" 변이는 1만 규모 시험에서 살아남았다(200자 제한만으로 3초 안). 5만 규모로 시험을 키운 뒤 탐지했다.
