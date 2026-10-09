# PW-012 — Shared editor schema·계약 — REPORT
Status: in_review (독립 리뷰 대기) / Phase: P01 / Requirement: REQ-012

## 변경 파일
- `packages/editor-core/src/`. browser와 server가 같이 쓰며 Node 전용 API가 없다. hash는 WebCrypto, 문자 경계는 `Intl.Segmenter('en')`.
  - `schema.ts`
    - PW-003 spike의 schema를 정식화했다. `EDITOR_SCHEMA_VERSION = 1`
    - block: paragraph, heading, table
    - inline atom: citation, math_inline, figure_ref
    - mark: bold, italic, sub, sup
  - `document.ts` `validateDocument(json, schema_version)`. 거부 대상:
    - raw HTML(문자열 또는 html류 node)
    - unknown node/mark/field/attr
    - block id 누락·비UUID·중복
    - atom 속성 오류, 구조 오류, NUL·짝 없는 surrogate, 과도한 깊이
    - 다른 schema_version: MIGRATION_REQUIRED 또는 MIGRATION_NOT_AVAILABLE. `migrateDocument`라는 명시 경로로만 변환한다(현재 migration 없음)
  - `position.ts`: block 기준 ProseMirror 위치 규칙
    - 텍스트는 UTF-16 길이, atom은 1. surrogate·grapheme 분할 금지. block은 id로만 찾음
    - `snapshotSelection`: block hash, slice hash, quote, atoms
  - `replacement.ts`: 제안의 typed replacement(text, citation, preserve_atom)를 schema node로 변환하거나 거부. atom 중복 사용·범위 밖 index·unknown mark·raw HTML 항목 거부
  - `hash.ts`: canonical JSON과 sha256
- `contracts/edit_proposal.schema.json`: v2(RFC-005)
  - `selected_slice_hash` 필수
  - `preserve_atom` 추가
  - 빈 텍스트 금지, locator 길이 제한
- `contracts/ai_replacement.schema.json`(신규): 모델 출력 계약
  - 들어갈 수 있는 것: handle id, 결과(replacement / needs_evidence / no_change), replacement, 누락 목록, 설명
  - 위치·block id·hash·승인 필드는 넣을 수 없다
- `contracts/README.md`: 위치 규칙과 hash 정의 명시(RFC-005 요구)
- `examples/`
  - edit_proposal 예시를 v2로 갱신
  - ai_replacement 유효·무효 예시 추가
  - manifest 갱신
- `packages/contracts/src/index.ts`: v2와 모델 출력의 TS 타입, ajv validator(server용)
- 의존성(P00 고정값과 동일, exact pin)
  - editor-core: prosemirror-model 1.25.12, prosemirror-transform 1.12.2
  - contracts: ajv 8.20.0, ajv-formats 3.0.1(기존 root devDep과 같은 버전)

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-012-A 같은 fixture가 양쪽 schema·position engine에서 같은 결과 | `browser-parity.int.test.ts`: editor-core와 fixture runner를 같은 소스에서 transpile해 Chromium 141에서 실행한다. Node 결과와 **문자열까지 동일**함을 확인(문서 검증, block hash 10개, 경계, selection 17건, replacement 7건). `editor-core.test.ts`: 손으로 확인한 경계(emoji, ZWJ 가족, 결합문자, 분해형 한글, 국기, 인용·수식·그림 atom, mark), selection quote·atoms·오류 코드, canonical hash(키 순서 무관, 내용 변경 반영, sha256 기준값) | pass |
| REQ-012-B unknown node, raw HTML, 중복 block ID, schema-version 불일치는 거절 또는 명시 migration | `editor-core.test.ts` 14종 거부와 "HTML처럼 보이는 텍스트는 텍스트"; 버전 0/2/'1'/undefined는 읽지 않고 migration 오류, `migrateDocument` 경로가 없으면 오류; `contracts.contract.test.ts`: v1 제안, slice hash 누락, 빈 텍스트, raw HTML 항목, 음수 atom index, 승인 필드 거부; 모델 출력에 위치·id·hash·승인·mode가 있으면 거부; needs_evidence/no_change 형태 검사; editor-core가 만드는 replacement는 모두 계약상 유효 | pass |

- RED
  - 구현 코드를 시험보다 **먼저** 작성했다(TDD 순서 위반이므로 기록한다).
  - 대신 editor-core를 비운 상태로 시험을 돌려 21/21 실패를 확인했다(`red.log`).
  - browser parity는 browser 쪽 hash의 키 정렬만 일부러 깨면 실패함을 확인했다.
- GREEN(`green.log`): unit 21/21, browser parity 1/1, contracts 13/13
- Mutation 3종 모두 탐지
  - 문자 경계를 code unit으로 바꿈
  - 중복 block id 검사 제거
  - 모델 출력 계약의 additionalProperties 허용
- 회귀: `pnpm test` exit 0
  - unit 30, integration 97, contracts 13, e2e 1, spikes 70
  - evals PASS, pack-check PASS

## 보안·과학적 실패 경로
- 저장 형식에서 raw HTML을 실행 경로로 쓸 수 없다. 텍스트 속 `<script>`는 텍스트일 뿐이다.
- 모델은 위치를 정할 수 없다. 범위·hash는 서버가 저장한 handle에서만 온다(RFC-005).
- browser와 server가 문자 경계를 다르게 계산하면 STALE·잘못된 위치 적용이 생긴다. 이 위험은 Chromium 실측으로 검증했다(ICU 차이는 현재 fixture에서 없음).

## 미실행 / 남은 위험 / 이월
- **저장 경로 연결 안 함.** PW-009의 문서 저장은 아직 "type=doc 객체"만 검사한다.
  - `validateDocument`를 붙이면 기존 PW-009 시험 fixture(block id `b-1`, 비UUID)가 거부된다.
  - 그래서 연결은 PW-014(수직 경로)에서 시험 fixture 갱신과 함께 하자고 제안한다(RFC-006 부록 기록).
- **Firefox/Safari는 미검증.** 실측은 Chromium만 했다. 사용자 브라우저가 다르면 별도로 확인해야 한다.
- **IME 조합 중 동작은 미검증.** 브라우저 편집기가 생기면 PW-015/022에서 시험한다.
- **apply 엔진은 PW-017로 이월.** handle 저장, 1회 적용, conservative guard(spike)를 아직 editor-core로 옮기지 않았다.
- **migration은 아직 하나도 없다.** MIGRATION_REQUIRED 경로는 등록된 migration이 생길 때 시험이 필요하다.
- **`MANIFEST_SHA256.json`(원 pack 무결성 목록)은 갱신하지 않았다.** pack validator가 이 hash를 검사하지 않으며, 이미 PROGRESS.md 등과 다르다. 원본 pack 기준선으로 남긴다.

## 다음 Task
PW-013 DB job/outbox/audit(리뷰 후).

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 2, minor 11). 모두 수정했다.
- 회귀 시험: `tests/tasks/PW-012/review-fixes.test.ts` 20건
  - 수정 전 17건 실패(`review-red.log`)
  - 3건은 이미 맞게 동작하던 경로의 보강이다.
  - 처음 작성한 대문자 UUID 시험은 숫자만 있는 UUID를 써서 의미가 없었다. 문자가 섞인 UUID로 고쳤다.

| 지적 | 조치 |
|---|---|
| **M1** attrs가 없는 citation/math/figure_ref가 null 속성으로 통과 | atom은 attrs가 없으면 빈 객체로 검사한다 → INVALID_ATTR |
| **M2** buildReplacement가 validateDocument가 거부할 노드를 만듦 | 결과를 paragraph 내용으로 `.check()`하고 문서와 같은 텍스트 규칙을 적용한다. 막는 항목: 아래첨자와 위첨자 동시 적용, NUL·짝 없는 surrogate·공백뿐인 locator, U+FFFC, 100,000자 초과. 계약 schema도 아래첨자+위첨자 동시 적용을 거부. 성공한 replacement가 모두 문서 검증을 통과하는지 시험 |
| 1 `--experimental-strip-types`에서 로드 실패 | parameter property를 명시 필드로 바꿨다. node로 직접 로드하는 시험 추가 |
| 2 atom 옆 결합문자가 경계를 흡수 | atom을 경계로 고정하고, atom 사이 텍스트 묶음(서식이 달라도 이어서)을 따로 분할 |
| 3 텍스트 속 U+FFFC가 quote에서 사라짐 | 텍스트에서 U+FFFC 거부(문서·replacement) |
| 4/5 doc·block·atom에 mark, text에 content | mark는 텍스트에만 허용, text·atom의 content 거부 |
| 6 계약의 UUID가 editor-core보다 느슨 | 모든 uuid 필드에 소문자 정규 pattern |
| 7 `missing` 규칙 | 1개 이상, 빈 문자열 금지, needs_evidence일 때만 허용. 빈 replacement는 양쪽 모두 "선택 삭제"로 허용하고 README에 명시 |
| 8 `findBlock(null)`이 id 없는 block을 찾음 | UUID가 아니면 BLOCK_ID_INVALID |
| 9 migrateDocument가 결과를 검증하지 않음 | 현재 버전으로 변환한 결과는 검증 후 반환 |
| 10 배열 속 undefined로 잘못된 JSON 생성 | null로 직렬화 |
| 11 table block hash가 browser 비교에서 빠짐, 보고서의 "10개" 부정확 | table을 비교 대상에 넣었다. 이제 block hash 10개와 문서 hash를 비교한다 |

- 실행
  - PW-012: unit 41/41, Chromium parity 1/1, contracts 13/13(`green.log`)
  - `pnpm test` exit 0: unit 50, integration 112, contracts 13, e2e 1, spikes 70, evals/pack PASS
  - 이 수치에는 작업 중인 PW-013(미커밋)이 포함되어 있다.
- 남은 위험: `crypto.subtle`은 브라우저에서 secure context(https 또는 localhost)가 필요하다. 연구실 서버를 http로 원격 접속하면 hash가 동작하지 않는다. 배포 때 https 또는 SSH 터널을 써야 한다(PW-061/P07에 기록).
