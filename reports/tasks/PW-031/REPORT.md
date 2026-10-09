# PW-031 — 서지 검색 adapter — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_031_0001_literature_searches.sql`
  - `literature_searches`: 검색 한 번이 한 행이다. 논문, 사용자, 출처, 정확한 검색식과 매개변수, cache key, endpoint, 출처가 보고한 API 버전, 관측 시각, 응답 SHA-256, 전체 건수, 결과(ok 또는 source_unavailable + 사유·HTTP 상태·retry-after)를 남긴다.
  - `literature_candidates`: 후보마다 검색 id를 가리킨다. 순위, 출처 레코드 id, DOI(있을 때), 제목, 저자, 연도, 저널, 유형, preprint 여부, 관계(preprint↔출판본), 출판 후 고지(철회·정정 등)를 남긴다.
  - 두 표 모두 바꿀 수 없다.
- `packages/search/src/bibliographic/`
  - `http.ts`: bounded GET.
    - 시간 제한, 크기 제한(스트림 단위), redirect 거부, 식별 가능한 User-Agent.
    - 실패를 종류로 나눈다: 401/403 `auth`, 429 `rate_limited`(Retry-After), 404/410/3xx `endpoint_changed`, 5xx `server_error`, `timeout`, `too_large`, `network`, JSON 아님 `schema_changed`.
  - `crossref.ts`: `/works` 검색(`query.bibliographic`, `rows`, `select`, `mailto`). 쓰는 필드만 엄격하게 읽는다. 모양이 다르면 응답 전체를 `schema_changed`로 처리한다(일부 레코드만 버리지 않음).
  - `pubmed.ts`: E-utilities `esearch` → `esummary`(JSON, `tool`·`email`·선택 `api_key`). esummary가 요청한 id 중 하나라도 빠지면 `schema_changed`다. 철회·정정 pubtype을 읽는다.
  - `index.ts`: `searchBibliographic`
    - endpoint는 고정된 공개 HTTPS 주소만 쓴다. 시험만 명시적으로 loopback을 허용한다.
    - limit은 1–20.
    - 출처마다 한 번에 하나, 최소 간격을 둔다(Crossref 200 ms, PubMed 350 ms, key가 있으면 110 ms).
    - 같은 논문·검색식·매개변수는 cache 시간(기본 24시간) 동안 기록에서 답한다. 실패는 cache하지 않는다.
    - 검색 기록과 후보는 한 트랜잭션으로 저장한다.
- `packages/search/src/index.ts`(export)
- 시험(`tests/tasks/PW-031/`)
  - `search.int.test.ts`: 통합 16, loopback 대역 서버와 합성 fixture
  - `fixtures/*.json`: 합성 Crossref·PubMed 응답
  - `live-contract.manual.ts`: 실제 endpoint 계약 확인. 수동, 승인 플래그 필요

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-031-A / TST-031A 실제 검색식·출처·관측일·metadata가 candidate에 연결 | Crossref 검색 요청을 확인했다: 검색식, rows, mailto, User-Agent. 기록의 출처·검색식·endpoint·API 버전·응답 hash가 맞다. 후보 3개의 metadata, preprint 관계(양방향), 철회 고지가 남는다. 후보는 검색 행에 연결되고, 바꿀 수 없다 |
| | PubMed: esearch의 검색식·retmode·tool을 확인했다. PMID, DOI(있을 때만), "Kim J" → family/given, 철회된 논문 표시 |
| | 같은 검색은 cache 시간 안에 요청 없이 기록에서 답한다. limit 500과 빈 검색식은 거부한다. 같은 출처의 연속 요청은 최소 간격을 지킨다 |
| REQ-031-B / TST-031B key/한도/endpoint 변경 시 fabricated 대신 source unavailable | 401·403 → auth, 429 → rate_limited(retry_after 120), 404 → endpoint_changed, 503 → server_error. 모양이 바뀐 응답 4종(items 없음, 잘못된 필드, JSON 아님, DOI 없는 항목) → schema_changed. 어느 경우든 후보 0개이고, 기록에 사유가 남는다 |
| | 느린 응답 → timeout, 큰 응답 → too_large. 실패는 cache되지 않아 다음 검색은 다시 요청한다 |
| | esummary가 id 하나를 빠뜨리면 짧은 목록이 아니라 unavailable이다 |
| | 다른 host, 시험 밖의 loopback, http endpoint는 요청 전에 거부한다 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- GREEN: 통합 16.
- mutation(`mutation.log`): 14번 실행했다.
  - 처음에 2종이 살아남았다(시험 공백).
    - http 거부 제거: 다른 검사 메시지에도 "https"가 들어 있었다. 시험이 정확한 메시지를 보도록 고쳤다.
    - DOI 검사 제거: DOI만 없는 표본이 없었다. 표본을 더했다.
  - 다시 돌려 둘 다 탐지했다. 최종 12종 탐지.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 278, integration 250, contracts 17, e2e 80, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- 검색 결과가 없거나 출처를 쓸 수 없으면 그렇다고 답한다. 후보를 지어내거나 일부만 저장하지 않는다.
- 검색식은 외부 서비스로 나간다. 검색식이 무엇을 담는지는 PW-033(AI 후보 선정)이 정한다. 이 Task는 사용자·AI가 준 검색식을 그대로 기록한다.
- DOI 존재나 검색 결과는 주장의 근거가 아니다(spec 05). 후보는 후보일 뿐이고, 채택은 PW-033·036에서 한다.

## 미실행 / 남은 위험
- **실제 Crossref·PubMed 호출: not_run.** 수동 계약 확인 스크립트를 두었다. 응답 형식이 바뀌면 `schema_changed`로 막힌다(안전한 쪽).
- **OpenAlex: 넣지 않았다.** spec 05는 "실제 사용조건을 확인한" 경우에만 추가하라고 한다. 이 환경에서 조건을 확인할 수 없다.
- PubMed 저자 이름의 이니셜 해석은 "성 이니셜" 형식만 나눈다. 그 밖의 형식은 이름 전체를 family로 둔다.
- 최소 간격은 프로세스 단위다. worker가 여러 개면 출처 한도를 나눠 쓴다(PW-049/050에서 다룸).
- Node `fetch`는 `HTTPS_PROXY`를 자동으로 쓰지 않는다. proxy가 필요한 기관 망에서는 설정이 필요하다(P07 배포 안내).

## 다음
PW-032: 서지 정규화·출판본 관계
