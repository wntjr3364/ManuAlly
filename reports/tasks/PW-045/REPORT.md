# PW-045 — 과학적 부정 fixture·rubric gate — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `evals/SCIENTIFIC_CASES.json`: SCI-001~030 합성 hard case를 **실행할 수 있게** 했다(`status: executable`).
  - 사례마다 `run`이 있다. 어느 제품 계층이 판단하는지와 그 입력(문단, 사실, 주장, 참고문헌, 원문, 답)을 담는다.
  - 결정적으로 판단할 수 없는 5개는 `not_deterministic`이다. 누가 판단하는지(검토자+사용자, 그림 교차참조 등)를 적었다.
  - 의도적으로 더 엄격한 2개에는 `known_deviation`과 그 이유를 적었다.
- `evals/human-rubric.results.json`: 사람 blind rubric 결과 파일
  - `status: not_run`이다. 이유는 권리·외부 전송이 확인된 실제 문단이 아직 없다는 것이다(최소 10개 필요, 사용자 제공).
- `tests/scientific/runner.ts`: 각 사례를 제품 자체의 계층으로 돌린다.
  - 계층: gate(PW-043), writer 답 읽기(PW-042), 제안 guard(PW-017), profile 출처 검사(PW-041), 복사 검사(PW-041), prose 신호
  - 결과는 ALLOW/WARN/NEEDS_EVIDENCE/BLOCK로 나온다. 기대와 비교해 다음 중 하나로 분류한다.
    - `match`
    - `known_deviation`: 선언된, 더 엄격한 결과
    - `stricter`: 선언 안 된 더 엄격한 결과. 검토가 필요하다.
    - `unsafe`: 기대보다 느슨함. **실패**다.
    - `not_run`
- `tests/scientific/quality.ts`
  - `validateRubric`: 사람 평가자만 받는다(`rater_kind: human`). blind, 권리 확인, tune/held_out 구분, 여섯 기준 1–5와 근거, 정해진 critical flag만 받는다. 모르는 field(AI 탐지·자기평가 점수 등)는 오류다.
  - `releaseQuality`
    - AI 탐지 점수와 자기평가는 **무시하고 이유에 적는다**.
    - `declared_pass`는 언제나 false다.
    - hard case가 깨끗하고 blind 사람 평가가 10개 이상, held-out이 있고, critical flag가 없을 때도 결과는 `ready_for_user_decision`(사용자가 수치 목표를 정함)이다.
    - critical flag는 평균으로 상쇄되지 않는다.
- `tests/scientific/report.ts`: 결과·rubric·release 판단을 JSON 증거로 쓴다(`hard-cases.json`).
- 범위 밖(RFC-012 부록): hard case가 드러낸 gate 구멍을 막았다(`pw-sci-gate-2`; `packages/domain/src/scientific-checks/index.ts`, `records.ts`).
  - 0.05 이상의 p를 "유의"라고 쓰면 실패다(SCI-002). "not significant"는 실패가 아니다.
  - p = 0이거나 1보다 크면 실패다(SCI-016).
  - "p-value was 0.02"처럼 낱말 비교어도 읽는다. 그 문장에 맞춰진 사실이 없어도, 기록된 모든 값과 p/q가 엇갈리면 실패다(SCI-003). 통과로 인정하지는 않는다.
  - "6 independent biological replicates"는 n이다. 기록된 모든 n과 다르면 실패다(SCI-025). technical replicates는 n이 아니다.
  - mol/L, mmol/L 등 몰 단위를 읽는다(SCI-007).
  - 숫자 없는 그룹 비교("B exceeded A")를 기록된 값과 비교한다(SCI-009). 짧은 그룹 이름은 대소문자를 구분한다(관사 "a"는 그룹 A가 아님).
  - 승인 주장의 종류에 견준 강도
    - 관찰 주장을 인과로 쓰면 `causal_overstatement`(SCI-004)
    - 가설·해석을 확정처럼 쓰면 `certainty_overstatement`(SCI-029)
    - 낱말 목록이 아니라 주장의 종류로 판단한다. 사용자가 인과 해석으로 승인한 주장은 그대로 통과한다.
  - "first study" 같은 우선권 주장은 unknown이다(체계적 검토 필요, SCI-005).
  - `proseSignals`: 문단을 요구한 곳의 번호 목록은 Writer 제안의 경고가 된다(SCI-018). Methods는 예외다(SCI-019).
  - 관련 연결: `apps/worker/src/writer/index.ts`(prose 경고), `apps/web/src/features/writer/WriterPanel.tsx`(문구), 기존 시험 기대값 4곳의 갱신(아래)
- 기존 시험의 기대값 변경(더 엄격해진 방향, 주석 포함)
  - `tests/tasks/PW-043/gate.int.test.ts`: gate version 2. 수치 없는 문장의 "q = 0.003"(기록된 p)이 unknown에서 `p_q_mismatch` 실패로 바뀌었다.
  - `tests/tasks/PW-044/review.int.test.ts`, `review.e2e.ts`: 관찰 주장 위의 인과 단정이 이제 결정적 검사에서도 실패한다. MOCK 검토자의 지적이 2개(자기 지적 + gate 실패)가 되었다.
- 시험
  - `tests/scientific/hard-cases.test.ts`(unit 33)
  - `tests/tasks/PW-045/quality.test.ts`(unit 8)
  - `tests/tasks/PW-045/gate-extensions.test.ts`(unit 7)
  - 화면 변경은 경고 문구뿐이다. 브라우저 회귀(PW-042·044)로 확인했다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-045-A / TST-045A: 최소 hard-case suite와 human rubric의 결과·미실행·회귀를 기록 | 30개 모두 결과가 있다. match 23, known_deviation 2(SCI-015 반올림 값 → NEEDS_EVIDENCE; SCI-028 철회 문헌 → BLOCK), not_run 5(SCI-010·017·020·024·027, 누가 판단하는지 포함), unsafe 0, stricter 0. 회귀가 보인다: 제품이 사례를 통과시키게 바뀌면 `unsafe`, 설명 없는 더 엄격한 결과는 `stricter`(시험으로 확인). rubric 파일이 유효하고 not_run과 이유를 기록한다. 증거: `hard-cases.json` |
| REQ-045-B / TST-045B: AI 탐지 회피 점수/자기평가만으로 release quality 통과를 선언하지 않음 | AI 탐지 점수·자기평가는 무시되고, 사람 평가가 없으면 not_ready다. rubric 파일의 점수 field는 오류다. 모델 평가자·blind 아님·권리 미확인·범위 밖 점수·근거 없음은 오류다. critical flag 하나(나머지 만점이어도)는 not_ready다. 9개뿐이거나 held-out이 없으면 not_ready다. 깨끗해도 `ready_for_user_decision`이고 `declared_pass: false`다. 지금 제품의 상태는 not_ready다(unsafe 0, 사람 평가 미실행) |

## RED → GREEN
- RED(`red.log`)
  - 1차: `proseSignals`가 없었다.
  - 2차: 기존 gate가 9개 hard case를 느슨하게 통과시켰다. SCI-002·003·004·005·007·009·016·025·029가 실패했다(실제 구멍의 증거).
- GREEN: unit 48(hard-case 33 + quality 8 + gate 확장 7), PW-043 unit 18 그대로 통과
- mutation(`mutation.log`): 25종 탐지, 1종 제거.
  - gate 규칙 15, 실행기 2, quality 8
  - "technical replicates" 조건은 죽은 코드라서(정규식이 애초에 technical을 받지 않음) 지웠다.
  - 작업자 재시작으로 mutation 하나가 파일에 남았던 것을 발견해 백업으로 되돌렸다. 이후 스크립트는 종료 시 항상 복원(trap)한다.
- 회귀: `pnpm test` exit 0 — unit 391, integration 451, contracts 17, 브라우저 93 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 품질 "통과"는 자동으로 선언되지 않는다. 결정은 사용자가 수치 목표를 정한 뒤에 한다(HUMAN_RUBRIC.md).
- 결정적으로 판단할 수 없는 사례는 통과로 세지 않고 not_run으로 남긴다.
- 문체 금칙어 목록은 만들지 않았다(spec 06). 과장·hype(SCI-020)는 검토자와 사용자의 몫이다.

## 미실행 / 남은 위험
- **사람 blind rubric은 실행하지 않았다.** 권리 확인된 실제 문단이 없다. 사용자 제공이 필요하다.
- hard case 5개는 결정적 계층 밖이다(그림 번호 글, 누락된 한계, hype, 종 이름, 출처와의 모순). 실제 검토자(PW-044)와 사용자가 판단한다. live 검토자 평가는 자격 문제로 not_run이다.
- 새 gate 규칙의 한계
  - "significant"의 유의 수준은 0.05로 가정한다(논문별 alpha 기록 없음).
  - 매칭 실패 시 n·p/q 대조는 기록된 모든 값과 비교한다. 기록 안 된 다른 실험의 값이면 거짓 실패가 날 수 있다(안전한 쪽).
  - 그룹 비교는 같은 entity·metric·단위의 두 그룹 이름이 문장에 나올 때만 본다.
- 합성 사례 30개는 최소 suite다. 실제 논문 분포를 대표하지 않는다.

## 다음
PW-046: 개요→집필 연구자 workflow(P05 마지막)

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 1, NIT 3)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 새 규칙이 맞는 과학 문장을 실패시켜 AI 제안·고쳐 쓰기를 막음 | **유의성**: p는 자기 절(쉼표, 세미콜론, but/whereas/while/although/though로 나눔)의 "significant"에만 묶는다. "not (statistically) significant", "no significant", "non-significant", "did not reach", "failed to reach", "n.s.", "biologically/clinically significant"는 통계적 유의 주장이 아니다. **n**: 생물 수는 "per group/condition…"일 때만 n이다(replicates는 그대로). 맞춰진 사실이 없을 때의 n 대조는 그 문장이 기록된 사실의 대상을 말할 때만 실패하고, 아니면 unknown이다 | 리뷰어 probe 7문장과 "ABC1 was measured after 20 plants were transferred"는 실패가 없다. 여전히 잡는 것: 유의라 쓴 0.08, 대상을 말한 6 replicates, 수치와 함께인 n=5, "12 plants per group" |
| MINOR: "led to", "results in"이 관찰 주장 위에서 실패 | 단정적 인과(causes/caused, is responsible for, demonstrates that, proves that)만 실패다. "led to", "results in", "drives"는 `causal_wording` unknown으로 보여 준다(실험 조작이면 정당) | led to·results in → 실패 아님, causes → 실패 |
| NIT: 실행기가 gate UNKNOWN을 NEEDS_EVIDENCE로 봄 | 사례마다 `applicable_as_ai_proposal`와 `stopped_by`를 기록한다. AI 후보는 gate와 Writer 수치 검사를 함께 거친다(더 엄격한 쪽). UNKNOWN만 있는 후보는 "적용 가능"으로 정직하게 남긴다(SCI-005). SCI-025 실행 문장은 측정 대상을 말하게 했다(이유를 `note`에 적음) | SCI-002 gate가 멈춤, SCI-001 Writer 수치 검사가 멈춤, SCI-005 적용 가능. 연도(2019)는 gate가 읽지 않아도 Writer 검사가 멈춤 |
| NIT: release 요약이 빈약 | `for_user`: hard-case 요약, 미실행 사례와 판단 주체, 기대보다 약하게 막히는 AI 후보 목록, rubric 평가자 수·held-out·critical과 **기준별 평균(baseline 대 candidate)**. 결과는 여전히 `declared_pass: false`다 | 기준별 평균, 미실행 목록 |
| NIT: 중복 평가 | 같은 문단·평가자·후보의 두 번째 평가는 오류다 | 중복 → 오류 |

- RED(`red-review.log`): a576c5b 구현으로 리뷰 시험 8개가 실패한다(probe 7문장과 led to/results in).
- GREEN: unit(PW-045·scientific) 63, PW-043 unit 18 그대로 통과.
- mutation(`mutation.log` 하단): 8종 모두 탐지.
  - 처음 살아남은 2종(생물 수를 n으로 봄, 실행기가 Writer 수치 검사를 무시)은 구별하는 시험을 더한 뒤 탐지했다.
- 회귀: `pnpm test` exit 0 — unit 406, integration 451, contracts 17, 브라우저 93 (`pnpm-test-review.log`)
- 작업자 재시작으로 전체 회귀 실행이 한 번 끊겼다. 파일에는 남은 mutation이 없음을 확인하고 다시 돌렸다.
