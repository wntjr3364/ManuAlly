# PW-043 — Deterministic scientific gate — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `packages/domain/src/scientific-checks/index.ts`: `scientificGate`. 모델 없이 문단 하나를 읽는 순수 함수다(`GATE_VERSION` pw-sci-gate-1).
  - **수치**는 검증된 사실과 맞춘다.
    - 같은 값(숫자로 같음, 2.4 = 2.40)이어야 한다.
    - 같은 단위여야 한다(fold/×/x, µ/μ/u, day/d 정규화).
    - 그 사실의 그룹이어야 한다. 문장에 대조군만 있으면 `group_mismatch`다.
    - 같은 값의 사실이 여럿이면 문장이 가리키는 사실(entity·metric 낱말)을 고른다.
    - 이름 속 숫자(ABC1, H2O2), 그림·표 번호, 연도, 2A 같은 표지는 수치로 보지 않는다.
  - **p/q**: 그 문장(없으면 그 문단)에 맞춰진 사실의 통계와 맞춘다.
    - q·FDR·adjusted p를 p로 쓰거나 그 반대면 `p_q_mismatch`다.
    - 값이 다르면 `value_mismatch`다.
    - `<`·`>` 기준은 사실 값이 실제로 지켜야 통과한다(`threshold_not_met`).
  - **n**: 맞춰진 사실의 n과 같아야 한다(`n_mismatch`).
  - **인용**: 이 논문의 참고문헌이 아니면 `citation_not_found`, 서재가 철회로 알면 `citation_retracted`다.
  - **보호 span**: 원문 문단이 있으면 수식·그림 참조 atom이 같아야 한다(`protected_span_changed`).
  - **주장**: 주어진 승인 주장마다 가장 겹치는 문장(60% 이상)이 부정과 증감 방향을 지켜야 한다(`negation_changed`, `direction_changed`).
  - 결과는 finding마다 pass·fail·unknown이다. pass는 사실(근거 id·이름·locator)이나 참고문헌(locator)을 담는다.
    - **정확히 맞출 수 없으면 unknown이다**: 그 값의 사실이 없음(반올림 값 포함), 단위 없음, 그룹을 말하지 않음, 고를 수 없는 두 사실(`ambiguous`, 후보 목록), 맞춰진 사실이 없는 통계, 문단에 보이지 않는 주장.
    - 문단 상태: fail이 있으면 FAILED, unknown이 있으면 UNKNOWN, 둘 다 없으면 VERIFIED, 검사할 것이 없으면 NOT_APPLICABLE. **unknown은 VERIFIED가 아니다.**
- `packages/domain/src/scientific-checks/records.ts`
  - `gateFacts`: 검증된 근거의 검증된 사실, 통계 포함. 호출자가 준 settled id로만 고른다(PW-037 gate).
  - `gateReferences`: 논문 참고문헌과 철회 표시
  - `checkManuscriptParagraph`: 그 revision의 그 문단을 검사한다. 주장은 그 문단이 연결된 활성 개요 계획의 승인되고 settled된 주장이다. 실행은 바꿀 수 없는 기록으로 남긴다.
  - `listScientificChecks`
- `db/migrations/pw_043_0001_scientific_checks.sql`: `scientific_check_runs`(revision, block, gate version, 상태, finding). 바꿀 수 없다.
- 범위 밖(RFC-012 부록)
  - `apps/api/src/scientific-checks/index.ts`(route; settled 집합은 local MOCK 기준), `apps/api/src/server.ts`
  - `apps/worker/src/writer/index.ts`: Writer 제안마다 gate를 돌린다(계약의 사실·주장·원문). fail은 CHECK_FAILED(적용 불가)이고, unknown은 보이되 통과로 세지 않는다.
  - `apps/web/src/features/writer/WriterPanel.tsx`
    - 제안의 gate finding(✓/✗/? + 근거 이름)
    - 저장된 문단을 고르는 "과학 검사"
- 시험
  - `tests/tasks/PW-043/gate.test.ts`(unit 14)
  - `gate.int.test.ts`(통합 5)
  - `gate.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-043-A / TST-043A: 정확히 매칭된 fact와 citation은 근거 locator를 포함한 check 결과를 가진다 | unit: 값·단위·그룹·n·p·인용이 모두 맞으면 VERIFIED이고, finding마다 fact·evidence·locator·근거 이름이나 참고문헌 locator("p. 4")가 있다. 기준(p < 0.01)은 통과한다. 문장의 entity로 같은 값의 두 사실 중 하나를 고른다. 같은 극성의 주장은 claim id와 함께 통과한다. 통합: 원고 문단 검사가 VERIFIED이고, 사실의 근거 이름·locator와 인용 locator가 있으며, 실행이 기록으로 남는다(수정 불가). 브라우저: "근거와 일치", "2.4-fold — roots qPCR" |
| REQ-043-B / TST-043B: p↔q·단위·negation·group 변경/존재하지 않는 citation을 통과시키거나 모호한 매칭을 verified로 표시하지 않는다 | unit: q를 p로, p를 q로, FDR, 기준 미달 → fail. 같은 값 다른 단위 → fail. 대조군에 붙인 값 → fail. 부정·반대 방향의 주장 → fail. 없는 참고문헌·철회 문헌 → fail. 다른 n → fail. 고를 수 없는 두 사실(그룹 미언급, 또는 완전히 같은 두 사실) → UNKNOWN과 후보. 사실 없는 수(24 h), 반올림 값(2.43), 단위 없음, 그룹 없음, 맞춰진 사실 없는 p → unknown. 보호 atom 변경 → fail. 이름·그림 번호·연도는 수치가 아니다. 통합: 계획에 연결된 문단의 부정된 주장 → FAILED. 철회된 사실은 쓰지 않는다(unknown). 철회 문헌 → fail. 없는 block 422, 다른 revision 404, 남의 논문 404. Writer: 단위 변경·그룹 바꿈·부정 → CHECK_FAILED, 그룹 없음 → unknown(PENDING). 브라우저: "불일치", "단위가 다름", 24 h는 확인 안 됨, 통과 0 |

## RED → GREEN
- RED(`red.log`)
  - unit: 모듈이 없어 실패했다. 이어서 stub으로 13개가 모두 실패했다.
  - 통합: route가 없어 5개가 모두 실패했다.
- GREEN: unit 14, 통합 5, 브라우저 1
- mutation(`mutation.log`): 20종 모두 탐지.
  - 단위, 단위 없음, 그룹 바꿈, 그룹 없음, 모호함
  - p/q, 기준, n
  - 없는·철회 인용, 보호 span, 부정·방향 주장
  - unknown이 verified로 세어짐
  - 연도·그림 번호, 통계 종류, 사실 없는 수
  - Writer의 gate 누락, gate 실패가 막지 않음
  - "모호함" 변이는 처음에 살아남았다(시험이 soft 경로만 탔음). 완전히 같은 두 사실 시험을 더한 뒤 탐지했다.
- 회귀: `pnpm test` exit 0 — unit 340, integration 438, contracts 17, 브라우저 92 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 결정적 검사는 확신할 수 있는 것만 pass로 한다. 맞출 수 없으면 unknown이고, 화면도 "확인 안 됨"으로 통과와 구별한다.
- Writer 제안의 gate 실패는 적용을 막는다. 사용자가 손으로 쓴 문단은 검사 결과만 보여 주고 막지 않는다(spec 06: 수동 문장 검열 금지).
- 사실은 settled된 것만 쓴다. 철회된 사실이나 PW-037 gate가 보류한 사실로 통과시키지 않는다.

## 미실행 / 남은 위험(휴리스틱의 한계)
- 영어 중심이다. 한국어 등 다른 언어의 단위·그룹·부정은 잘 못 읽는다(대개 unknown 쪽).
- 그룹은 사실의 group·comparison 이름이 문장에 그대로 나올 때만 판단한다. 동의어("water-deficit" = drought)는 unknown이다.
- 단위 변환(1000 µM = 1 mM)은 하지 않는다. 다른 표기는 불일치로 본다(안전한 쪽).
- 주장 극성은 낱말 겹침 60%로 문장을 고른다. 다르게 말한 주장은 "보이지 않음(unknown)"이다. 의미 판단은 PW-044 scientific reviewer와 사용자의 몫이다.
- 통계는 그 문장(또는 문단)에서 맞춰진 사실에서만 찾는다. 수치 없이 p만 쓴 문장은 unknown이다.
- 수동 문단 검사 화면은 결과만 보여 준다. 기록 목록 화면은 아직 없다(API로 조회).

## 다음
PW-044: 문체·과학 검토와 human review

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 2, NIT 2)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 다른 대상, 바뀐 그룹 순서, 바뀐 부호, 다른 문장의 p가 VERIFIED | **대상**: 사실 entity의 식별자(글자+숫자, 예: ABC1)가 그 문장에 있어야 한다. 그룹 이름 속 식별자는 세지 않고, log2 같은 것은 식별자가 아니다. 다른 식별자만 있으면 `entity_mismatch`(fail), 없으면 `entity_not_stated`(unknown)다. 식별자가 없는 이름(proline)은 그 낱말이 문단에 있어야 한다. **그룹**: 그룹과 대조군이 둘 다 나오면 비교어(than, compared with/to, relative to, vs, versus, over)가 그 사이에 있고 그룹이 앞이어야 한다. 반대면 `group_mismatch`(fail), 비교어가 없으면 `comparison_order_unclear`(unknown)다. **부호**: 앞의 −/-를 부호로 읽는다(day-3, 2-3의 하이픈은 아님). 반대 부호의 사실은 `sign_mismatch`(fail)다. **p·q·n·±**: 그 문장에서 맞춰진 사실에서만 읽는다(문단 대체 없음) | 리뷰어 probe 4개: ABC2 → entity_mismatch, 대상 없음 → unknown, wild type than mutant → group_mismatch, 올바른 순서 → pass, 비교어 없음 → unknown, −1.5 대 +1.5 → sign_mismatch, 1.5 → pass, -1.5 대 -1.5 → pass, 다른 문장의 p → unknown(no_matched_fact) |
| MINOR 1: "2,400"을 2로 읽음 | `\d{1,3}(,\d{3})+`는 한 수다. "2,4" 같은 소수점 쉼표나 띄어쓰기 없는 목록은 `ambiguous_number`(unknown)다 | 2,400 대 사실 2 → unknown(no_matching_fact, text "2,400"), 대 2400 → pass, 2,4-fold → unknown |
| MINOR 2: "~2.4"가 정확값처럼 통과 | ~, ≈, about, approximately, nearly, roughly, around, circa, ca., almost가 앞에 있으면 pass에 `approximate: true`를 붙이고 화면에 "근사 표기 — 값은 기록과 같음"으로 보인다 | 세 표기 모두 approximate |
| NIT: gate가 mock의 전송 허가로 settled를 정함 | PW-037 source gate에 `LOCAL` 모드를 더했다. 아무것도 보내지 않는 검사는 제거·철회만 gate로 보고 전송 허가는 보지 않는다. 그림 이전 버전, 열린 검토, 근거 없는 주장 등 과학적 gate는 그대로다. route 입력으로는 고를 수 없다(gate API만 씀) | 확인된 PDF 없는 문헌 근거의 사실이 gate에서 pass(근거 이름 포함) |
| NIT: ±·범위 | 범위나 ± 뒤의 단위를 첫 수에도 붙인다. ± 뒤의 수는 그 문장 사실의 SD·SE와 맞춘다(같으면 pass, 다르면 `value_mismatch`, 기록 없으면 `dispersion_not_recorded`) | 2.4 ± 0.3-fold → 수치 pass와 sd pass, ± 0.5 → fail, 2.4–3-fold → pass(단위 fold) |

- RED(`red-review.log`): d58e906 구현으로 새 unit 시험 4개가 실패한다.
- GREEN: unit 18, 통합 6, 브라우저 1.
- mutation(`mutation.log` 하단): 13종 모두 탐지(local gate 포함).
- 회귀: `pnpm test` exit 0 — unit 344, integration 439, contracts 17, 브라우저 92 (`pnpm-test-review.log`).
- 남은 위험(추가)
  - 식별자 없는 대상 이름의 동의어는 unknown이다.
  - 비교 구문이 "in A, unlike B" 같은 다른 꼴이면 unknown(comparison_order_unclear)이다.
  - 범위의 위쪽 수는 별도 수치로 보고 사실이 없으면 unknown이다.

## 재리뷰 (1e6f242): approve
- 확인: MAJOR, MINOR 2개, NIT 2개 모두 닫힘. 리뷰어 실행: unit 18/18, 통합 PW-037·042·043 30/30.
- 리뷰어 probe 10개(다른 대상, 그룹 바꿈, 부호, 다른 문장의 p, 천 단위, 올바른 문장, 그룹 이름 속 대상, 비교어 없음, 식별자 없는 대상 이름 있음/다름)가 기대대로 나왔다. 식별자 없는 다른 대상 이름은 fail이 아니라 unknown이다(반박할 식별자가 없음; 안전한 쪽).
