# PW-048 — Context budget·compact 전환 — REPORT
상태: in_review (2026-10-10)

## 설계
- **`readContext()`**: 세션의 현재 context는 가장 최근 요청 하나의 input이다(message scope usage).
  - turn·session scope 합계는 누적 과금이라 점유율로 쓰지 않는다.
  - context window는 모델의 성질이라, 어느 scope의 보고에서든 가져온다. 없으면 설정값을 쓴다.
  - 보고가 없으면 prompt 길이로 추정하고 `estimated`로 표시한다.
  - window를 모르면 `unknown`이다. 0이나 백분율을 만들지 않는다.
- **`requestBudget()`**: window − 현재 input − 다음 prompt − 예상 도구 결과 − 출력 여유 − 안전 여유.
  - 점유율 70% 이상이면 `review`: 호출 전 checkpoint와 함께 `checkpoint_review`를 기록한다.
  - 80% 이상이거나 다음 요청이 들어가지 않으면 `switch`다.
  - 이것은 이 앱의 기준이지 공급자 한도가 아니다(spec 08).
- **`canStartTurn()`**: 다음 turn을 시작하지 않는 경우: 앞 turn이 열려 있음, 도구 호출이 열려 있음, compaction이 확인되지 않음.
- **`runJobTurns()`**: 한 작업의 단계들을 한 세션에서 실행한다. 전환은 turn 사이(안전한 경계)에서만 한다.
  1. checkpoint(PW-047, `session_change`, 남은 단계 = 다음 단계)
  2. 공급자의 `manual_compact`가 **verified**이고 세션이 compaction을 지원하면 compaction을 요청한다. 공급자의 `compacted` 사건이 와야 확인된 것이다.
     - 확인되지 않거나 다른 사건(오류)만 오면 믿지 않는다(`compact_failed`). 새 세션으로 간다.
  3. 그 밖(unsupported, unknown, documented_not_verified)은 재수화한 상태(`resumePrompt`)로 **새 세션**을 시작한다(`session_replaced`).
  4. 재검사: checkpoint 이후 바뀐 것이 있으면 다음 단계로 가지 않고 WAITING_USER다.
  5. 전환 전의 측정값은 버리고 다음 단계로 간다.
- 끝나지 않은 turn(stream이 `turn_completed` 없이 끝남, 성공 아닌 결과)은 경계가 아니다. 그 세션에 아무것도 더 시작하지 않는다.
  - `TurnIncomplete`를 던지고, queue가 checkpoint에서 다시 시도한다. 최종 결과가 아니다.
- **기록(`context_switches`, `pw_048_0001`)**: 각 단계의 종류와 그 계기가 된 측정을 남긴다.
  - 측정: 현재 input, window, 출처(provider_reported / estimated / unknown), 점유율, checkpoint.
  - 현재 fencing token을 가진 실행만 쓴다. 행은 바뀌지 않는다. 모르는 값은 NULL이다.
- 지금 registry에서 Claude의 `manual_compact`는 unknown, Codex는 documented_not_verified다. 그래서 **둘 다 새 세션 경로**를 쓴다. compaction 경로는 사용자 PC live smoke로 verified가 된 뒤에만 쓰인다.

## 변경 파일
- write scope
  - `db/migrations/pw_048_0001_context_switches.sql`
  - `apps/worker/src/context/index.ts`: `readContext`, `requestBudget`, `canStartTurn`, `runJobTurns`, `listContextSwitches`, `TurnIncomplete`
  - `tests/tasks/PW-048/context.int.test.ts`(통합 14)
- 범위 밖: 없음

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-048-A / TST-048A: 지원 provider는 compact 완료 확인 후, 미지원은 새 세션 후 같은 작업을 잇는다 | **verified**: 85%에서 checkpoint(남은 단계 draft_discussion) → compaction 요청 → 확인 → 같은 세션에서 다음 두 단계를 실행한다(기록: 요청·확인, 측정값, 85%, checkpoint id). **unsupported, unknown, documented_not_verified**: checkpoint → 새 세션 → 같은 작업의 남은 단계를 실행한다. 새 세션의 첫 글에 승인 novelty, 사실 2.4, `pending step: draft_discussion`이 있다. 확인되지 않거나 오류만 온 compaction은 새 세션으로 이어진다(요청·실패·교체). 72%는 checkpoint_review만 하고, 다음 도구 결과가 들어가지 않으면 80% 아래에서도 전환한다. 전환 뒤 바뀐 정책이 있으면 다음 단계 전에 WAITING_USER다 |
| REQ-048-B / TST-048B: 누적 과금 token을 context 점유율로 쓰거나 실행중 tool/compact 미완료를 무시하고 다음 turn을 시작하지 않는다 | message 30k, turn 900k, session 4M이면 점유율은 30k/128k다. stream에 누적 합계가 섞여도 전환하지 않는다. 보고가 없으면 추정(`estimated`), window가 없으면 UNKNOWN(백분율 없음)이다. turn 중간에 끝난 stream은 다음 단계를 시작하지 않는다(`TurnIncomplete`, 재시도 대상). 경계 gate는 열린 turn, 열린 도구 호출, 확인 안 된 compaction에서 시작을 막는다. 전환 전 측정값은 전환 뒤에 다시 전환을 일으키지 않는다. 옛 fencing token의 실행은 기록하지 못한다 |

## RED → GREEN
- RED(`red.log`): context 모듈이 없어 suite가 실패한다.
- GREEN: 통합 14
  - 처음 typecheck에서 `JobOutcomeError`가 "retry"를 받지 않음을 확인했다.
  - 끝나지 않은 turn은 최종 결과가 아니므로 별도 오류(`TurnIncomplete`)로 queue의 재시도를 받게 했다.
- mutation(`mutation.log`): 21종 모두 탐지
  - 처음 살아남은 2종을 구별하는 시험을 더한 뒤 탐지했다.
    - "확인 사건 아닌 사건도 compaction으로 믿음": compaction stream이 오류만 보내는 경우
    - "전환 전 측정값을 남김": 크기 보고 없는 turn
  - 패턴 오류로 돌지 않은 1종(전환 뒤 재검사 제거)은 다시 돌려 탐지했다.
- 회귀: `pnpm test` exit 0 — unit 406, integration 495, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- compaction은 공급자가 확인해야만 믿는다. 확인되지 않은 세션에는 turn을 시작하지 않는다.
- 새 세션은 DB에서 다시 만든 상태(PW-047)로만 시작한다. 요약을 필수로 요구하지 않는다.
- 측정값을 모르면 UNKNOWN이다. 누적 과금은 점유율이 아니다.

## 미실행 / 남은 위험
- **실제 Claude·Codex 세션에서 실행하지 않았다**(자격 없음). 대역 세션으로 시험했다.
  - 실제 adapter(`startClaudeTurn`, Codex app-server)를 `ContextSession`으로 감싸는 연결과, Codex의 compaction RPC 호출은 live smoke로 확인할 일이다.
  - 지금 Writer는 한 turn짜리라 이 경로를 쓰지 않는다. 여러 turn짜리 작업(긴 대화형 수정·검토)이 생길 때 연결한다.
- 모델별 context window 표(capability)가 없다. 공급자 보고가 없고 설정값도 없으면 UNKNOWN이다. 그때는 전환하지 않는다(긴 작업에서 한도에 닿을 수 있음, 공급자 오류로 드러남).
- 추정(문자 4개 ≈ token 1개)은 거칠다. `estimated`로 표시한다.
- 전환 기록을 보여 주는 화면이 없다(spec 08 "웹 상태").

## 다음
PW-049: 할당량 대기·재개

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 2, NIT 4)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR 1: 앞 답(output)이 다음 요청에 들어가는데 예산에서 빠짐(70k 입력 + 25k 답에서 "들어감"으로 판단) | 현재 context = 마지막 turn의 message 보고의 **입력 + 답**이다. 답 크기를 모르면 0으로 치지 않고 추정이나 UNKNOWN이다. 이름도 `current_context`로 바꿨다(기록 column `context_tokens`, `context_source`) | 70k + 25k: 현재 95k, `switch`(available −2k). 답 크기를 모르면 unknown이고, 주고받은 글이 있으면 그 추정(최소)을 쓴다 |
| MINOR 1: message 보고가 없는 공급자(Codex는 session 합계만)는 늘 UNKNOWN이라 전환하지 않음 | runner가 이 세션에서 주고받은 글(시작·재수화 prompt, 단계 prompt, 답)로 **하한을 추정**한다(`estimated`). compaction 뒤에는 그 뒤의 글만 센다. 새 세션은 재수화 prompt부터 센다 | session 합계만 보고하는 세션에서 답 세 개(약 90k) 뒤에 새 세션으로 전환한다(`context_source: estimated`). compaction 뒤 추정은 그 뒤 글만 세어 다시 전환하지 않는다 |
| MINOR 2: 재시도가 checkpoint의 남은 단계가 아니라 처음부터 다시 함 | 앞 단계의 답은 저장되지 않으므로 다시 보내는 것이 안전한 선택이다. 주석의 "checkpoint에서 재시도"를 고쳤고, 비용은 남은 위험에 적었다 | — |
| NIT 1: 단계 이름을 미리 확인하지 않음 | 시작 전에 소문자·`_`·서로 다름을 확인한다. 어기면 FAILED다(재시도 없음) | "Draft-1"과 중복 이름은 FAILED이고, 세션을 시작하지 않는다 |
| NIT 2: 앞 단계의 message 보고가 뒤 단계에도 쓰임 | 읽기는 **마지막 turn의 사건**만 본다. 보고가 없으면 추정이다 | MINOR 1 시험: 첫 단계의 10k 보고가 뒤 단계의 크기를 대신하지 않는다 |
| NIT 3: `compacted` 뒤에 오류가 와도 확인으로 봄 | `compacted`가 있고 오류나 실패 turn이 없는 깨끗한 stream만 확인이다. 일반 turn 중의 `compacted`(공급자 자동 compaction)는 확인으로 쓰지 않는다 | compacted 다음 오류: 요청·실패·교체 |
| NIT 4: 전환 기록의 checkpoint가 같은 작업 것인지 확인 안 함 | `recordSwitch`가 checkpoint의 작업을 확인한다(다르면 INVALID) | 다른 작업의 checkpoint는 INVALID다 |

- mutation이 드러낸 추가 수정: **window는 모델의 성질**이라 전환 뒤에도 유지한다. 한 번만 보고하는 공급자는 전에는 전환 뒤 window를 잃었다. 시험을 더했다.
- RED(`red-review.log`): 3067fd0 구현에서 리뷰 시험 7개가 실패한다(이름 바꾼 기존 시험 2개 포함).
- GREEN: 통합 21
- mutation(`mutation.log` 하단): 13종 모두 탐지
  - 처음 살아남은 2종(compaction 뒤 추정 미초기화, window를 대체값에서만 읽음)은 시험을 더한 뒤 탐지했다. 그중 하나가 위의 window 유지 수정을 드러냈다.
  - 패턴 오류 1종은 다른 형태로 다시 돌려 탐지했다.
- 회귀: `pnpm test` exit 0 — unit 406, integration 502, contracts 17, 브라우저 95 (`pnpm-test-review.log`)
- 남은 위험(추가)
  - 재시도는 첫 단계부터 다시 보낸다(비용·할당량).
  - 추정은 하한이다(system prompt, 도구 정의, 도구 결과는 세지 않음). 공급자 보고가 있으면 그것을 쓴다.

## 재리뷰 (4b76314, 0bd6df3): approve
- 확인한 것
  - MAJOR 1, MINOR 1·2, NIT 1–4가 닫혔다.
  - 누적 합계는 context가 될 수 없다. 확인 안 된 compaction에서는 같은 세션이 이어지지 않는다.
  - compaction stream이 예외를 던지면 `requested`로 남아 gate가 turn을 막고, 작업은 새 실행에서 다시 시도된다.
  - 리뷰어 실행: 통합 46/46.
- NIT 처리
  - N1 고침: 확인된 compaction 뒤에는 추정 기준을 0이 아니라 **UNKNOWN**으로 둔다(요약 크기는 관측되지 않음). 다음 message 보고가 올 때까지 그 세션은 크기를 모른다.
  - N4 고침: `TurnIncomplete` 주석을 "첫 단계부터 다시 시도"로 바꿨다.
  - N2·N3은 남은 위험에 적는다.
    - 문자 추정은 낮은 하한이다. 공급자 자체 system prompt와 도구 정의(Claude Code는 큼), 도구 입력·결과는 세지 않는다. 문자 4개당 1 token은 한국어를 적게 센다. 그래서 Codex의 80% 전환이 늦게 올 수 있다. 고정 기본값을 더하는 일은 live smoke로 실제 크기를 본 뒤 정한다.
    - 전환 뒤에도 window를 유지하는 것은 새 세션이 같은 모델일 때만 맞다. 지금 factory는 같은 공급자·버전으로만 세션을 연다.
  - N1 mutation(0으로 되돌림)은 처음 살아남았다. 압축 뒤 0 기준이면 75%로 읽혀 review가 생기는 시험을 더한 뒤 탐지했다.
  - 바꾼 것은 runner의 추정 기준 처리와 주석뿐이다. 통합 22와 typecheck·lint로 확인했고, 전체 회귀는 리뷰 반영본(0bd6df3)의 것이다.
