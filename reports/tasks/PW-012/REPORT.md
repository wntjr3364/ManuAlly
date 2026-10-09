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
