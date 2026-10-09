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
