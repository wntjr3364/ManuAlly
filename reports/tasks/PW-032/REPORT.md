# PW-032 — 서지 정규화·출판본 관계 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_032_0001_literature_identity.sql`
  - `bibliographic_revisions`: 출처 `crossref`·`pubmed`를 허용하고, 그 버전을 만든 후보 id(`source_candidate_id`)를 둔다.
  - `reference_identifiers`: 소유자마다 유일한 DOI(소문자)·PMID → 작품(reference work). 바꿀 수 없다.
  - `reference_relations`: preprint ↔ 출판본, version, 철회·정정·우려 고지, PubMed 플래그. 상대 작품을 알면 그 id, 모르면 DOI를 둔다. 바꿀 수 없다.
  - `reference_duplicate_questions`: 제목이 비슷하거나 식별자가 충돌하는 쌍. 소유자가 한 번 결정한다(distinct/same). 결정 외에는 바꿀 수 없다.
- `packages/domain/src/literature/index.ts`
  - `normalizeDoi`: `https://doi.org/`·`doi:` 접두를 떼고 소문자로 만든다. 형식이 맞지 않으면 null.
  - `ingestCandidate`(PW-031 후보 → 소유자 서재). 소유자 단위 advisory lock 안에서 처리한다.
    - DOI·PMID로만 합친다. 레코드가 둘 다 가지면 서로 잇는다. 둘이 이미 서로 다른 작품을 가리키면 합치지 않고 충돌 질문을 남긴다.
    - 식별자가 없으면 새 작품이다.
    - 메타데이터가 최신 버전과 다르면 새 불변 revision을 쓴다. 같으면 쓰지 않는다.
    - 관계와 고지를 저장한다. 나중에 들어온 작품을 가리키던 DOI 관계는 그 작품 id로 다시 잇는다.
    - 새 작품의 제목이 다른 작품과 같은 키(대소문자·문장부호·공백 무시)면 질문만 남긴다.
  - `referenceIdentifiers`, `relationsOf`, `possibleDuplicates`, `resolveDuplicate`(소유자 범위)
- 시험: `tests/tasks/PW-032/normalize.int.test.ts`(통합 7)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-032-A / TST-032A 중복 후보는 확인 가능한 identifier로 정리, 출판본 관계 보존 | DOI 정규화(접두, 대소문자, 형식). 같은 DOI는 검색이 달라도, 출처가 달라도(Crossref·PubMed) 한 작품이다. PubMed PMID가 붙고, 이후 PMID만 가진 레코드도 같은 작품을 찾는다. 소유자가 다르면 다른 작품이고, 남의 후보는 not found다 |
| | preprint ↔ 출판본 관계는 양방향으로 남고 두 작품은 합치지 않는다. 철회 고지는 대상 DOI로, PubMed "Retracted Publication"은 작품 자신의 플래그로 남는다 |
| REQ-032-B / TST-032B 제목 유사성만으로 병합하지 않고, metadata 변경으로 과거 인용 snapshot을 바꾸지 않음 | 같은 제목(대소문자·마침표 차이), 다른 DOI 2개, 식별자 없는 PubMed 1개는 작품 3개로 남고, 열린 "similar_title" 질문이 된다. 소유자가 distinct로 닫는다. 다른 소유자는 닫지 못한다 |
| | DOI와 PMID가 서로 다른 작품을 가리키면 합치지 않고 `identifier_conflict` 질문을 남긴다 |
| | 제목이 바뀐 메타데이터는 새 버전이다. 앞서 만든 snapshot은 원래 버전 id를 그대로 가리킨다. 같은 메타데이터는 버전을 늘리지 않는다. revision은 바꿀 수 없다 |
| | 식별자가 없는 후보 둘은 각자 작품이다 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- GREEN: 통합 7.
- mutation(`mutation.log`): 10종 모두 탐지했다.
  - DOI 소문자화 제거, PMID 무시, 제목으로 병합
  - 충돌을 조용히 DOI 쪽으로 합침
  - 메타데이터 덮어쓰기(버전 없음)
  - 관계 누락, 철회 고지 누락, 늦게 들어온 대상 미연결, 비슷한 제목 질문 누락
  - 남의 후보 허용
- 회귀: `pnpm test` exit 0(`pnpm-test.log`).

## 보안·과학적 실패 경로
- 서로 다른 연구를 합치지 않는다. 합치는 근거는 식별자뿐이고, 애매하면 사람에게 묻는다.
- 과거 snapshot과 인용은 그때의 버전을 가리킨다. 출처의 수정·철회는 새 버전과 관계로만 들어온다.
- "same" 결정은 판단만 기록한다. 두 작품을 실제로 하나로 합치는 일은 하지 않는다. 인용 id가 바뀌면 원고 인용이 깨지기 때문이다. 필요하면 나중에 명시적 작업으로 한다.

## 미실행 / 남은 위험
- Crossref 원 논문 쪽 철회 상태(`updated-by`)는 PW-031 리뷰 반영에서 읽게 되었다. 그 결과는 이 Task의 `flagged_*` 관계로 들어온다.
- 제목 비교는 정확히 같은 키만 본다(유사도 점수 없음). 철자가 다른 같은 연구는 질문이 생기지 않는다(합치지도 않음).
- 철회된 논문을 이미 인용한 원고에 경고를 띄우는 일은 PW-036·058에서 한다.

## 다음
PW-031 리뷰 반영 → PW-033: AI 문헌 후보 선정

## 리뷰 반영 (2026-10-09, 리뷰: changes requested — MINOR 3, NIT 6)
- MINOR 1: 직접 입력한 참고문헌(`createReference`, PW-019)
  - DOI를 소문자로 서재 식별자에 등록한다. 소유자 lock 안에서 처리한다.
  - 같은 DOI면 같은 작품을 쓰고, 처음 보는 메타데이터일 때만 manual 버전을 더한다. 같은 논문에 두 번 넣으면 409다.
  - migration `pw_032_0002`: 이전 작품의 DOI를 backfill한다. 같은 DOI 작품이 둘이면 합치지 않고 `identifier_conflict` 질문으로 남긴다.
- MINOR 2: 버전은 그 작품이 한 번도 갖지 않은 메타데이터일 때만 더한다. 출처를 번갈아 받아도 버전이 늘지 않는다.
- MINOR 3: `noticesOf(owner, work)`가 작품 자신의 flag와, 그 작품을 가리키는 고지(철회·정정·우려·갱신)를 함께 보여 준다.
  - 순서는 상관없다. 늦게 들어온 대상은 `linkPendingRelations`가 다시 잇는다. 직접 입력한 대상도 같다.
  - `noticesForDoi`는 아직 서재에 없는 DOI에 대한 고지를 찾는다(PW-033).
- 고지 기록과 작품 자신의 flag를 구분한다.
  - PubMed "Published Erratum"·"Expression of Concern" 레코드는 고지 자체이므로 `erratum_for`·`expression_of_concern_for`로 저장한다. 그 레코드 자신에 flag를 달지 않는다.
  - 작품 자신의 상태는 PW-031 Crossref `updated-by`의 새 유형(`has_correction`, `has_expression_of_concern`, `has_update`)과 `retracted_publication`으로만 들어온다.
- nit
  - `normalizeDoi`: `doi.org/`, `www.doi.org`, `dx.doi.org`, percent-encoding을 받는다. 길이는 300까지다. 정규화할 수 없는 DOI는 CSL에서 뺀다(null 대신).
  - 식별자 없는 후보를 다시 받으면 `source_candidate_id`로 같은 작품을 쓴다.
  - flag는 고지 DOI(`notice_doi`)를 `to_doi`로 보존한다.
  - 새 버전이 생기면 제목 비교를 다시 한다. 질문 사유 이름은 호환성 때문에 `similar_title`로 두고, 비교가 정확한 키라는 것을 주석에 적었다.
  - 중복 질문 TRUNCATE를 금지한다.
  - PMID↔DOI를 잇는 곳에 주석을 달았다.
  - `ingestCandidateIn(tx)`를 PW-033 결정 트랜잭션용으로 분리했다.
- 시험: 통합 16(+9). RED는 `review-red.log`. mutation은 `mutation.log`에 16종을 추가했다. 15종은 탐지했고, 1종은 동치 대조(no-op)다.
- 회귀(리뷰 반영 후): `pnpm test` exit 0 — unit 278, integration 291, contracts 17, 브라우저 81(`reports/tasks/PW-033/pnpm-test-review.log`).

## 재리뷰 반영 (2026-10-09, 재리뷰: MAJOR 1, nit 2)
- MAJOR: 서재에 이미 있는 DOI를 다른 정보로 직접 입력해도 그 작품의 메타데이터는 바뀌지 않는다(다른 논문이 그 정보를 보여 준다).
  - 서버는 409 `doi_known_with_other_metadata`로 서재 정보를 돌려준다.
  - 소유자는 "서재 정보로 추가"(`use_library_metadata: true`)로 그 작품을 그대로 넣거나, 입력을 고친다.
  - 화면: `ReferencesPanel`(PW-019, RFC-011 부록)
  - 브라우저 시험: `tests/tasks/PW-032/known-doi.e2e.ts`, 증거 화면 `known-doi.png`
  - 논문별 local override는 아직 없다. 필요하면 spec 05의 override 모델로 따로 한다.
- nit(되돌림): 같은 출처가 이전 형태로 되돌리면(A → B → A) 그 형태를 다시 버전으로 남긴다. 기준은 같은 출처가 마지막으로 준 버전과 다를 때다. 출처를 번갈아 받는 경우에는 여전히 버전이 늘지 않는다.
- nit(migration 이름 `pw_032_0002`): 이미 push했으므로 이름을 바꾸지 않았다. 이름을 바꾸면 그 파일을 적용한 DB가 "applied migration missing"으로 거부된다. 영향은 개발 DB뿐이고 RFC-011에 기록했다.
- PW-031 재리뷰 nit 연계: withdrawal, removal, partial_retraction 고지 기록도 `retraction_of`다. corrigendum은 `correction_of`다.
- 시험: 통합 +3, 브라우저 1. RED는 `rereview-red.log`. mutation은 `mutation.log` 끝에 있고 모두 탐지했다.
- 회귀(재리뷰 반영 후): `pnpm test` exit 0 — unit 278, integration 297, contracts 17, 브라우저 82(`reports/tasks/PW-032/pnpm-test-rereview.log`).
