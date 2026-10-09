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
