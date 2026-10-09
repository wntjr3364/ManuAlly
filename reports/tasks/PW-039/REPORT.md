# PW-039 — Story 대안·주장 범위 AI — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_039_0001_story_alternatives.sql`
  - job intent `propose_story` 추가
  - `story_alternative_runs`(job 하나, 바탕 story revision, generator, 입력 hash; 바꿀 수 없음)
  - `story_alternatives`
    - 검사를 마친 내용, 경고, 채택을 막는 사유를 담는다. 바꿀 수 없다.
    - 채택은 한 번만 기록된다(trigger). 막힌 안은 채택 기록을 가질 수 없다(CHECK).
- `apps/worker/src/story/index.ts`
  - generator 입력(`StoryInput`)
    - 사용자가 쓴 brief와 story
    - 논문의 **검증된 사실**(통계 포함 문장)과 **승인된 주장**만
    - 검증 전 사실, 초안 주장, 다른 논문의 자료는 들어가지 않는다.
  - `checkAlternatives`: 엄격한 검사. 아래 경우 run 전체가 실패하고 아무것도 저장되지 않는다.
    - 안이 1–5개가 아님
    - 허용되지 않은 필드(brief, 승인 등)
    - 입력에 없는 근거 id(검증 전 사실, 초안 주장, 없는 id 포함)
    - 같은 근거를 두 번 연결
  - 시스템 규칙(generator가 바꿀 수 없음)
    - 안이 말하는 수치(제목, 질문, 메시지, 제시 순서, 경쟁 설명, 한계)는 그 안이 연결한 근거나 사용자의 brief·story에 있어야 한다. 아니면 `number_not_in_evidence:<n>`로 **채택을 막는다**.
    - `numbersIn`이 수치를 읽는다.
      - "ABC1", "H2O"는 이름으로 본다. "day-3"은 3으로, "2.40"은 2.4로 읽는다.
      - 부호는 구별한다. 서수("3rd")는 수치로 보지 않는다.
    - 경고:
      - `no_supporting_evidence`: 받치는 근거 없음
      - `contradicting_evidence_linked`: 반대 근거 연결됨
      - `same_as_current_story`: 지금 스토리와 같은 메시지
    - 실제 provider generator는 논문의 외부 전송 정책을 먼저 본다(민감 논문, 허용 안 된 공급자 → WAITING_USER, 아무것도 보내지 않음).
  - `createMockStoryGenerator`: 주어진 자료만으로 만드는 결정적 MOCK 안. 표시에는 MOCK이 붙는다.
    - 지금 방향을 유지하는 안
    - 가장 직접적인 관측 하나로 좁힌 안
    - 승인된 주장을 중심으로 한 안
  - `storyHandlers`: fenced apply. 취소되거나 넘어간 run은 아무것도 남기지 않는다.
- 범위 밖(RFC-012 부록)
  - `packages/domain/src/story-ai/index.ts`
    - 요청: 바탕 revision이 이 논문 것이고 목적이 있어야 한다.
    - 보기
    - `adoptStoryAlternative`:
      - 명시 intent와 현재 parent revision이 필요하다(오래되면 409).
      - 막힌 안은 422, 이미 채택한 안은 409다.
      - **brief와 새로운 점(novelty)은 사용자가 쓴 그대로** 둔다. 질문, 메시지, 제시 순서, 경쟁 설명, 한계는 안에서 온다.
      - evidence_links에는 근거와 반대 근거만 `fact:<id>`/`claim:<id>`로 남긴다.
      - 새 DRAFT story revision을 만들고 같은 트랜잭션에서 채택을 기록한다.
  - `apps/api/src/story-ai/index.ts`, `server.ts`; `outlines`의 `createStoryRevisionIn`; `JOB_INTENTS`; worker main과 e2e harness 등록; `StoryOutlineTab.tsx`
- 화면 `apps/web/src/features/story-ai/StoryAlternatives.tsx`("구상·개요" tab, 스토리 아래)
  - "대안 요청" 버튼과 결과 대기
  - 안마다 질문, 핵심 메시지, 제시 순서, 근거(근거/반대 근거/맥락), 경쟁 설명, 한계, 부족한 근거, 주장 제안("등록되지 않음"), 경고, 막힌 사유
  - "이 안으로 새 스토리 초안" 버튼. 막힌 안, 저장하지 않은 스토리 수정이 있을 때는 비활성
  - 채택 뒤 폼은 새 초안을 보여 주고, 승인은 기존 승인 버튼으로 따로 한다.
- 시험: `tests/tasks/PW-039/story-ai.int.test.ts`(통합 11), `numbers.test.ts`(unit 2), `story-ai.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-039-A / TST-039A 후보별 main message·증거·한계가 보이고 사용자가 채택 | run → 안마다 메시지, 근거(검증된 사실 문장과 역할), 한계. 채택 전에는 스토리가 그대로다. 채택 → parent가 지금 버전인 새 DRAFT. brief와 novelty는 그대로, 근거 연결이 기록되고 맥락은 빠진다. 한 번만 채택된다. 승인된 스토리는 바뀌지 않는다. intent 없음 422, 남의 논문 404, 오래된 parent 409. 브라우저: 요청 → MOCK 표시, 메시지, 근거 → 채택 → 폼에 새 초안 → 승인 버튼은 따로 |
| REQ-039-B / TST-039B AI가 주장을 확정하거나 데이터에 맞지 않는 결과를 story에 넣지 않음 | generator에는 검증된 사실과 승인된 주장만 간다. 모르는 근거(검증 전 사실, 초안 주장, 없는 id)는 run 실패이고 저장되는 것이 없다. brief를 바꾸거나 승인 필드를 넣거나 개수가 맞지 않는 답은 실패한다. 근거에 없는 수치(3.1)나 연결 없이 말한 수치는 채택이 막히고 사유가 보인다(422, 화면 비활성). 사용자가 쓴 수치는 다시 말해도 된다. 주장 제안은 글로만 남는다(주장 표의 변화 없음). 저장된 안은 수정할 수 없다. 전송이 허용되지 않은 논문에서 실제 provider는 아무것도 받지 않는다 |

## RED → GREEN
- RED
  - `red.log`: 구현 전에는 모듈이 없다.
  - `red-e2e.log`: 화면이 없으면 "대안 요청"을 찾지 못한다.
- GREEN: 통합 11, unit 2, 브라우저 1
- mutation(`mutation.log`): 19종 모두 탐지.
  - worker: 모르는 근거, 수치 차단, 연결된 근거의 수치만, 사용자 수치 허용, 검증된 사실만, 승인된 주장만, 필드·최상위 키·개수 검사, 전송 정책, 근거 없음 경고
  - domain: 막힌 안 채택, brief 유지, novelty 유지, 맥락 제외, intent, 한 번만 채택
  - 화면: 막힌 안 버튼, 근거 역할 표시
- 회귀: `pnpm test` exit 0 — unit 280, integration 394, contracts 17, 브라우저 88 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- AI는 제안만 만든다. 채택은 사용자 행위다. 채택해도 DRAFT일 뿐이고, 승인은 PW-010의 내용 hash 승인을 거친다.
- 논문의 목적, 독자, 피할 주장(brief)과 novelty는 AI가 바꾸지 못한다. 답에 넣으면 실패하고, 채택은 사용자의 것을 그대로 쓴다.
- 데이터에 없는 수치를 메시지에 넣은 안은 채택할 수 없다. 이 규칙이 문장의 의미까지 판정하지는 않는다. 예를 들어 "증가"를 "감소"로 말하는 의미 반전은 수치 검사로 잡히지 않는다. 이것은 PW-043(결정적 과학 검사)과 PW-044(검토)의 범위다.

## 미실행 / 남은 위험
- 실제 provider generator는 없다(MOCK만). provider 연결은 RFC-010 run 경로로 PW-042와 함께 한다. 그때 외부 자료는 지시가 아닌 데이터로 넘긴다(RFC-010 추가 요구).
- 수치 검사는 숫자 일치만 본다. 단위, 그룹, 방향의 불일치는 PW-043에서 다룬다.
- 대안 결과는 polling으로 기다린다(최대 약 30초 뒤 안내).

## 다음
PW-040: Detailed outline·영향 추적

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 3, NIT 2)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 흔한 수치 표기가 근거 검사를 빠져나감("9x", "tenfold", "50mM", "24h", "2-9", "10⁻⁶", "2,4", "1,200") | `numbersIn`을 다시 썼다. 아래를 수치로 읽는다. 결과는 검사에서 "근거에 없음"으로 막힌다(안전한 쪽). <br>• 단위가 붙은 수: `50mM`, `24h`, `9x`, `10µg` <br>• 곱셈 기호: `x`/`×` <br>• 범위: `2-9`, `2–3`은 두 수 <br>• 천 단위 구분(`1,200`)과 소수점 쉼표(`2,4`), 가운뎃점(`2·4`) <br>• 과학 표기: `1e-3`, `10^-6`, `10⁻⁶`, `3 × 10⁵` <br>• 백분율 <br>• 분수 `½` <br>• 수 낱말: two…hundred, `tenfold`/`two-fold`, `twice`/`double`/`half`. "one"은 일반 낱말과 구별할 수 없어 뺐다. <br>수치가 아닌 것으로 보는 것: 이름(ABC1, H2O), 서수(3rd), 한 글자 표지(2D, 5A), 그림·표 번호(Figure 2) | unit: 리뷰어 probe 문자열 전부. 통합: "9x", "tenfold", "50mM…72h", "2-9", "10⁻⁶"이 각각 막힌다 |
| MINOR 1: 맥락 연결의 수치가 허용됐지만, 채택 때는 그 연결이 빠짐 | 허용 수치는 story에 남을 연결(근거, 반대 근거)과 사용자의 글에서만 가져온다 | 맥락으로만 연결된 0.8 → 막힘 |
| MINOR 2: 채택이 run 바탕 revision의 brief·novelty를 되살림 | 바탕 revision이 지금 parent와 다르면 409("이전 스토리 버전에서 만든 안 — 다시 요청"). 화면은 그 안의 채택 버튼을 끄고 다시 요청하라고 안내한다 | 통합: rev2 저장 뒤 채택 409, 최신은 rev2 그대로. 브라우저: 저장 뒤 버튼 비활성과 안내 |
| MINOR 3: story 입력이 PW-037의 gate를 거치지 않음 | `settledMaterial`(PW-037 `candidatePool`의 내보내기)로 거른다. 거르는 것: 제거·철회된 원천, 전송 불가 원천, 이전 그림 버전, 열린 검토 표시. 그런 기록에 연결한 답은 모르는 근거로 run이 실패한다. MOCK에도 같은 provider 기준을 적용한다(보수적: 문헌 인용에서 읽은 사실은 MOCK에 빠질 수 있다) | 이전 그림 버전의 사실은 입력에 없고, 그것을 연결한 답은 실패한다 |
| NIT: 주장 제안·부족한 근거의 수치 | 근거에 없는 수치는 경고 `suggestion_number_not_in_evidence:<n>`로 표시한다(채택하지 않는 글이므로 막지는 않음) | 50-fold 제안 → 경고 |
| NIT: 허용 수치에 id 숫자가 섞임 | brief·story의 글 값만 읽는다. `evidence_links`의 id는 뺀다 | UUID 안의 4567 → 막힘 |

- 범위 밖 추가: `packages/search/src/retrieval/index.ts`의 `settledMaterial`(PW-037 모듈), `apps/worker/package.json`의 `@pw/search` workspace 의존성, `pnpm-lock.yaml`. RFC-012 부록에 적었다.
- RED(`red-review.log`): 208f6fa 구현으로 unit 2, 통합 5가 실패하고, 이전 화면으로 브라우저 시험이 실패한다.
- GREEN: 통합 16, unit 3, 브라우저 1.
- mutation(`mutation.log` 하단): 12종 모두 탐지.
- 회귀: `pnpm test` exit 0 — unit 281, integration 399, contracts 17, 브라우저 88 (`pnpm-test-review.log`)
- 남은 위험(갱신): 수치 읽기는 넓게 막는 쪽이다. 사용자가 쓰지 않은 표지성 숫자(예: "Experiment 2")는 근거에 없으면 막힌다. 그런 안은 사용자가 직접 고쳐 쓰면 된다.

## 재리뷰 (14b7d08): 작은 MINOR 하나를 닫으면 approve
- MINOR: 숫자 뒤에 붙은 대문자를 모두 표지로 보아 단위를 놓쳤다("5M NaCl", "37C", "10K"). 이제 "2D"·"3D"만 표지로 본다. 패널 글자는 앞의 "Fig."/"panel" 문맥으로 이미 거른다. 나머지 대문자는 단위이고 수치로 센다.
- nit 반영
  - 앞에 붙은 곱셈 기호("x2", "×3")
  - "million", "billion"
  - "twenty-five", "twenty-one" 같은 합성어
- 시험: unit 4(새 시험 1). mutation 3종 탐지(대문자 단위, 앞 곱셈, 합성어).
- 회귀: unit 282, integration 399(작업 중인 PW-040 제외). 브라우저는 PW-039 1개를 돌렸다. 바뀐 것은 수치 읽기 함수뿐이다.
