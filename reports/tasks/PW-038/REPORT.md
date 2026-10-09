# PW-038 — 문헌 이식성·읽기 연동 gate — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_038_0001_reference_imports.sql`
  - `reference_imports`: 가져오기 한 번(논문, 소유자, 형식, 원천 `import`/`zotero`, 읽은 내용의 sha256, 항목 수)
  - `reference_import_items`: 항목마다 결과(`created`, `linked_existing`, `kept_library_metadata`, `already_in_paper`, `invalid`, `unknown_doi`), 참고문헌 id, 경고. 가져오지 않은 항목만 id가 없다(CHECK)
  - (리뷰 반영으로 `reference_import_keys`는 `pw_038_0002`에서 `reference_import_identities`로 바뀌었다. 아래 "리뷰 반영")
  - 세 표 모두 바꿀 수 없다
- `packages/domain/src/imports/references/parse.ts`
  - BibTeX(중괄호·따옴표 값, LaTeX 악센트, `@string` 매크로는 값으로 쓰지 않고 경고), RIS, CSL-JSON, DOI 목록
  - 모두 같은 작은 CSL 모양(제목, 저자, 연도, 학술지, DOI)으로 읽는다. 없는 필드는 만들지 않는다. 원천 키는 200자로 자른다
- `packages/domain/src/imports/references/index.ts` `importReferences`
  - 2 MiB, 2000항목 상한. 형식이 틀리거나 읽을 수 없으면 전체를 거부한다(422)
  - 한 트랜잭션, 서재 잠금(`lockLibrary`). 항목마다:
    - 파일 안 같은 키 반복 → `invalid`(duplicate_key_in_file)
    - DOI(정규화)가 서재에 있으면 그 참고문헌. 내용이 같으면 `linked_existing`, 다르면 `kept_library_metadata`(서재 정보를 바꾸지 않음)
    - DOI가 없으면 같은 원천·같은 키·같은 내용일 때만 같은 문헌이다(리뷰 반영)
    - 서재에 없는 DOI에 정보가 없으면(DOI 목록) `unknown_doi`. 찾아보거나 지어내지 않는다
    - 제목 없음·해석 실패 → `invalid`
    - 새 문헌은 `bibliographic_revisions`에 원천(`import`/`zotero`)과 함께 기록, 미결 관계 연결(`linkPendingRelations`)
    - 논문에 이미 있으면 `already_in_paper`
- `packages/search/src/zotero/index.ts` `readZoteroItems`
  - Zotero Web API v3 `GET /{users|groups}/{id}/items?format=csljson`만 보낸다. 다른 method 경로가 없다
  - https만(시험용 loopback은 명시 옵션), redirect 거부, 15초 제한, 5 MiB 상한, 숫자 library id, key 형식 검사
  - 실패는 이유로 구분한다(auth, rate_limited, server_error, endpoint_changed, schema_changed, timeout, too_large, network)
  - `ZOTERO_CAPABILITIES = { read: true, write: false, sync: 'none', note }`
- 범위 밖(RFC-011 부록)
  - `apps/api/src/reference-import/index.ts`(새 route 폴더): `POST …/references/import`, `GET …/references/zotero`(capabilities), `POST …/references/zotero/import`
    - 모르는 필드는 거부한다. Zotero key는 그 요청에만 쓰고 저장하지 않는다
  - `apps/api/src/server.ts`(등록, 시험용 `zotero` 옵션), `apps/api/package.json`(`@pw/search` workspace 의존성), `pnpm-lock.yaml`
  - `apps/web/src/features/references/ImportReferences.tsx`(새 화면), `ReferencesPanel.tsx`(붙임)
  - `tests/e2e/manual-paper/harness.ts`(시험용 `zotero` 옵션 전달)
- 시험: `tests/tasks/PW-038/import.int.test.ts`(통합 11), `tests/tasks/PW-038/import.e2e.ts`(브라우저 1)

## 화면
"인용과 그림/표" 아래 "문헌 가져오기":
- 형식 선택, 파일 선택(.bib/.ris/.json/.txt는 형식을 맞춰 줌), 붙여넣기 칸
- 결과: 원천, 항목 수, 결과별 개수, 항목마다 결과·사유·경고
- "Zotero에서 읽기(읽기 전용)": capabilities 문구, "Zotero에 쓰기: 하지 않음", "동기화: 없음", 라이브러리 종류·번호, API 키(선택, password 칸, 가져온 뒤 비움)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-038-A / TST-038A 지원 형식을 가져와 안정된 reference ID와 출처 metadata로 인용 | 파서 시험(BibTeX 악센트·매크로, RIS, CSL-JSON). 가져오기는 원천을 기록하고, 다시 가져오면 같은 id다(다른 논문에서도). 가져온 문헌은 id로 인용되고 참고문헌 목록에 나온다. 서재가 아는 DOI는 서재 정보를 유지한다. DOI 목록은 정보를 지어내지 않는다. 잘못된 입력은 전체 거부 또는 항목별 사유. 크기 상한. 긴 원천 키. 브라우저: BibTeX 붙여넣기 → 2개 추가, 반복 키 거부, 인용 `[1]`, 참고문헌 목록, 다시 가져오기 → "이미 이 논문에 있음", RIS 파일 → 형식 자동, 모르는 DOI → 추가 안 됨 |
| REQ-038-B / TST-038B 외부 Zotero를 수정하지 않고, 없는 양방향 sync를 표시하지 않음 | capabilities(read, write false, sync none). Zotero 대역은 GET만 받는다. 원천 `zotero`. 바뀐 항목을 다시 읽어도 서재를 덮어쓰지 않는다. 비공개 라이브러리·잘못된 id는 이유와 함께 실패, 아무것도 가져오지 않는다. https만. 브라우저: 읽기 전용 문구, 쓰기 없음, 동기화 없음, 동기화·Zotero 저장 버튼 없음, GET만, key는 요청 header에만 있고 DB 어느 표에도 없으며 입력칸이 비워진다 |

## RED → GREEN
- RED
  - `red.log`: `importReferences`를 빈 구현으로 바꾸면 통합 5개가 실패한다. 파서·capabilities·비공개 라이브러리 3개는 domain 가져오기와 무관해 통과한다. 이 셋의 RED는 mutation이 맡는다.
  - `red-e2e.log`: 화면이 없을 때 "가져올 형식"을 찾지 못해 실패한다.
- GREEN: 통합 11, 브라우저 1
- mutation(`mutation.log`): 처음 18종 중 3종이 살아남았다(크기 상한, https만, 결과 문구). 시험을 더한 뒤 모두 탐지했다. 자체 검토에서 찾은 긴 RIS ID(DB 오류 500)도 고친 뒤 시험이 탐지한다. 최종 19종 모두 탐지.
- 회귀
  - 첫 실행(`pnpm-test-first-run.log`): PW-021 브라우저 시험이 실패했다. 이 Task의 결함이다. 새 화면의 파일 칸 이름 "가져올 파일"이 PW-021 버전 탭의 칸과 같아서 시험의 파일이 내 칸으로 들어갔다.
  - 화면의 이름을 고유하게 바꿨다("참고문헌 파일", "참고문헌 파일 형식", "참고문헌 붙여넣기", 양식 "참고문헌 파일에서 가져오기"). PW-019·021·038 브라우저 시험이 통과했다.
  - 다시 전체 실행: `pnpm test` exit 0 — unit 278, integration 369, contracts 17, 브라우저 85 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 가져오기는 정보를 지어내지 않는다. 서재에 없는 DOI만 있으면 가져오지 않고 그렇게 알린다. 외부 조회는 하지 않는다.
- 서재의 정보는 가져오기로 바뀌지 않는다(다른 논문도 그 정보를 쓴다). 다르면 `kept_library_metadata`로 알린다.
- Zotero에는 GET만 보낸다. key는 그 요청 header에만 쓰고 DB·로그·응답에 남기지 않는다(시험이 DB 표를 확인). 비공개·실패는 이유로 구분해 알린다.
- 논문 범위: route는 paperScoped다. 다른 사용자는 404다.

## 결정 (위임)
- Zotero는 가져오기 원천이고 외부 정본으로 다루지 않는다. 서재(DB)가 정본이다(CLAUDE.md). spec 05의 "Zotero가 외부 정본이면 local override와 source revision을 별도 기록"은 Zotero를 정본으로 쓸 때의 조건이다. v1은 그 방식을 쓰지 않는다.

## 미실행 / 남은 위험
- 실제 Zotero 서버로는 시험하지 않았다(대역만). 실제 응답 header·형식이 다르면 `schema_changed`, `endpoint_changed`로 실패한다. 성공으로 보이지는 않는다.
- 바뀐 Zotero 항목을 다시 읽으면 `kept_library_metadata`로 알리기만 한다. 그 새 정보를 기록하거나 채택하는 화면은 없다. 고치려면 사용자가 직접 수정한다.
- Zotero는 한 번에 최대 100개(기본 50)만 읽는다. 다음 쪽 이동 화면은 없다. 결과에 전체 개수를 보여 준다.
- BibTeX의 `@string` 매크로는 풀지 않는다(경고 후 그 필드는 비움). `crossref` 상속 등 고급 기능도 없다.
- 브라우저 일회성 실패 항목(PROGRESS Open items)은 여전히 열려 있다.

## 다음
P04 gate 보고(`reports/phases/P04_GATE.md`), 그다음 RFC-010 구현(P05 전).

## 리뷰 반영 (1차, changes requested — MAJOR 1, NIT 4)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: DOI 없는 항목이 원천 키만 같으면 다른 문헌에 붙음(ID 없는 RIS·CSL의 `#1`, 다른 파일의 같은 citekey) | `pw_038_0002_import_identities.sql`: 키 표를 `reference_import_identities`(소유자, 범위, 원천 키, 내용 hash)로 바꿨다. DOI 없는 항목은 같은 범위(파일 형식, 또는 Zotero 라이브러리 하나), 같은 원천 키, 같은 내용일 때만 같은 문헌이다. 위치(`#n`)는 키가 아니다(파서가 `ownKey: false`로 표시). 같은 키가 다른 내용으로 오면 새 문헌을 만들고 `source_key_seen_with_other_metadata` 경고를 준다 | `MAJOR: two RIS files without IDs`, `MAJOR: a citekey reused`(리뷰어의 두 probe), 위치가 달라도 같은 내용이면 같은 문헌 |
| NIT: 결과가 파일의 제목만 보여 줌 | 이미 있던 문헌이면 `library_title`을 함께 돌려주고, 다르면 화면에 "이 논문에 들어간 서재 문헌: …"으로 보여 준다 | 통합 `nit: the result shows the library's title`, 브라우저(잘못 친 DOI 항목) |
| NIT: 형식별 안정 id | 의도한 안전 방향(잘못 합치지 않음). 화면 안내문과 이 보고에 적었다: 다른 형식으로 가져오면 새 문헌이 된다 | 브라우저 안내문 |
| NIT: Zotero와 손으로 만든 CSL-JSON이 같은 키 공간 | 범위로 나눴다(`file:csl-json`, `zotero:user:12345`). 범위는 `reference_imports.scope`에도 기록한다 | 통합 `nit: Zotero items and hand-made CSL-JSON` |
| NIT: 바뀐 Zotero 항목을 채택할 수 없음 | 그대로 남은 위험으로 둔다. P04 gate 보고에도 적었다 | — |

- RED(`red-review.log`): 리뷰 시험 4개가 이전 구현에서 실패(두 probe는 `kept_library_metadata`로 잘못 연결, 범위 공유, `library_title` 없음).
- GREEN: 통합 15, 브라우저 1.
- mutation(`mutation.log` 하단): 7종 모두 탐지(키만으로 찾기, 위치를 키로 쓰기, Zotero 범위 빼기, 경고 빼기, `library_title` 빼기, 화면의 서재 제목, 화면의 경고 문구).
- 회귀: `pnpm test` exit 0 — unit 278, integration 373, contracts 17, 브라우저 85 (`pnpm-test-review.log`).
- 남은 위험: DOI 없는 항목을 고쳐서(오타 수정) 다시 가져오면 새 문헌이 된다. 잘못 합치는 것보다 안전한 쪽이다. 같은 문헌 둘은 PW-032의 서재 화면에서 사용자가 정리한다.

## 재리뷰
- approve (4118c2e).
- 남은 NIT(기록만): Zotero에서 고친 항목은 키가 같아도 내용이 달라 다시 가져올 때마다 새 문헌이 된다(경고와 함께). 잘못 붙이거나 덮어쓰지 않는 안전한 방향이다. 자주 다시 가져오면 중복이 쌓인다. 이후 "바뀐 Zotero 판 채택" 화면에서 한 문헌의 버전으로 잇는다.
