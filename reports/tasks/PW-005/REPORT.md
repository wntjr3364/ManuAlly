# PW-005 — 집필 품질 baseline fixture — 보고서

상태: **in_review**
일자: 2026-10-08

## 변경 파일
- `spikes/writing-baseline/fixtures/paper-bio.json` — 합성 research article. brief, 승인된 story, IMRaD outline 6노드(문단 목표·주장·근거·허용 해석·금지·word budget), claim 5, evidence 4, FactRecord 4(단위·n·통계·불확실성·출처), reference 3(full text / abstract only / metadata only + 철회됨).
- `spikes/writing-baseline/fixtures/paper-software.json` — 합성 software/resource 논문. **IMRaD가 아닌 구조**(Design and Implementation / Benchmarks / Availability).
- `spikes/writing-baseline/fixtures/paragraph-cases.json` — 문단 사례 18개, 7개 범주: numbers, negation, citation, verbosity(장문), report_style(보고서식), claim_strength, invented_detail. 범주마다 ALLOW와 실패 사례(BLOCK/WARN/NEEDS_EVIDENCE)가 모두 있고, 각 사례에 이유가 있다.
- `spikes/writing-baseline/fixtures/sci-map.json` — 기존 설계 SCI-001~030을 범주에 매핑.
- `spikes/writing-baseline/validate.mjs` — gold 무결성 검증기.
- `spikes/writing-baseline/COLLECTION_PROCEDURE.md` — 권리 확인된 실제 문단 수집 절차(동의, 외부 전송 허용, tune/held-out 분리, blind pairwise, 저장소 비커밋).
- `tests/tasks/PW-005/baseline.test.mjs` — 9개 테스트.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-005-A 수치·부정어·인용·장문·보고서식 기대 결과가 있는 fixture와 rubric | TST-005A ×4 | pass |
| REQ-005-B 본문 안 읽은 reference에 style verified 금지, 없는 결과를 gold로 등록 금지 | TST-005B ×5 | pass |

RED: `ERR_MODULE_NOT_FOUND`. GREEN: 9/9.
Mutation check(`mutation-check.log`): 실패 사례를 ALLOW로 바꾸면 검증기가 지어낸 수치(4.2, 22, 16, 8)와 라이브러리에 없는 인용을 정확히 지목한다.

## 검증기 규칙
- ALLOW(gold) 문단의 결과 수치는 **선언된 verified FactRecord 안에 있어야** 한다. Figure/Table 라벨과 `ABC1`·`S1` 같은 식별자 안의 숫자는 제외한다.
- gold의 인용 키는 프로젝트 라이브러리에 있어야 한다. 사실은 `verified` 상태여야 한다.
- `fulltext_style_verified`는 `FULLTEXT_PARSED`/`SOURCE_CHECKED` 깊이에서만 허용한다. 문체를 주장한 section은 실제로 읽은 section이어야 한다.
- 모든 fixture는 `synthetic: true`이고, article type은 2종 이상이어야 한다.

## 이 baseline이 판정하지 못하는 것 (의도된 한계)
- B-NUM-03(그룹 뒤바뀜), B-NEG-02(부정 반전), B-CLM-02(과장)는 숫자는 맞지만 의미가 틀린 사례다. 결정적 숫자 검사로는 통과하므로 **PW-043(group-aware fact 매칭)과 PW-044(과학적 검토)**의 대상이다. 이 사례들이 그 단계의 회귀 테스트가 된다.
- 문체 품질 점수는 없다. 실제 평가는 COLLECTION_PROCEDURE에 따라 수집한 실제 문단으로 PW-045에서 한다.

## 미실행 / blocked
- 모델 생성 결과 평가: not_run(provider 미승인, 이 Task 범위 밖).
- 실제 문단 gold set: 사용자 제공 필요(최소 tune 10 + held-out 10).

## 다음 Task
PW-006 P00 검토·ADR·버전 고정안.
