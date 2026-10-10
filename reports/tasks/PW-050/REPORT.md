# PW-050 — 비용 예약·budget guard — REPORT
상태: in_review (2026-10-10)

## 설계
- **비용 종류(cost class)**: 실행마다 공급자·로그인으로 정한다.
  - `free`: MOCK
  - `subscription_included`: Claude Code 구독 로그인, Codex ChatGPT 로그인. 호출당 청구가 아니라 할당량으로 막힌다(PW-049).
  - `metered`: 호출당 청구. v1에서 허용된 로그인에는 없다. 사용자가 나중에 허락할 때를 위한 장치이며, 시험은 시험용 metered 로그인으로 한다.
  - `unknown`: 그 밖. 실행하지 않는다(WAITING_BUDGET).
- **실행 승인(`admitRun`, fenced)**은 실행 전에 한다. 거절은 재시도가 아니다(WAITING_BUDGET 또는 WAITING_USER).
  - 유료 overage, rate-limit reset credit, API key 로그인은 언제나 거절한다(WAITING_USER). 표에도 넣을 수 없다(CHECK).
  - 작업은 처음 쓴 공급자·로그인을 유지한다. 바꾸려면 사용자가 정한다(WAITING_USER).
  - 작업당 실행은 최대 5번이다(재시도, 할당량 재개 포함, "무한 재시도" 방지).
  - metered 실행은 비용 추정이 있어야 한다(없으면 `cost_unknown`). 적용되는 모든 예산 안이어야 한다: 앱, 논문(실행당 한도 포함), 공급자. 예산이 하나도 없으면 막는다(`no_budget`, 기본 차단).
  - 소유자별 advisory lock 아래에서 예약한다.
  - 예산에 들어가는 것: 그 소유자의 metered 실행. 예약 중이면 추정, 정산되면 비용, 비용을 모르면 적어도 추정.
- **정산(`settleReservation`)**: 그 실행의 보고(시작 뒤부터 같은 작업의 다음 실행 전까지, DB 시각 정밀도로 비교)에서 계산한다.
  - session 누적 보고가 있으면 그 delta, 없으면 turn, 없으면 message. 두 scope를 더하지 않는다.
  - 같은 event key는 원장이 한 줄만 둔다.
  - 보고되지 않은 비용은 UNKNOWN(`settled_unknown`)이고 0이 아니다. metered 실행에 보고가 하나도 없으면 UNKNOWN이다.
  - 한 번만 정산한다.
- `withAdmission()`은 승인한 뒤 handler를 실행하고, 실패해도 정산한다.
- 작업당 제한(`useJobLimit`): 고쳐 쓰기 1번, 검색 3번
- **예산 설정은 사용자 행위**다. `POST /api/budgets {intent: set_budget, scope: app|paper|provider, paper_id?, provider?, limit_usd, run_limit_usd?}`(남의 논문 404, 음수 422). `GET /api/papers/:paperId/budget`으로 상태를 본다.

## 변경 파일
- write scope
  - `db/migrations/pw_050_0001_budgets.sql`
  - `packages/domain/src/budget/index.ts`
  - `apps/worker/src/admission/index.ts`
  - `tests/tasks/PW-050/budget.int.test.ts`(통합 13)
- 범위 밖(RFC-013 부록): `apps/api/src/budget/index.ts`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-050-A / TST-050A: 승인 예산 내 작업만 admitted되며 per-turn/누적 usage가 중복 없이 정산된다 | MOCK(free)과 구독 로그인은 돈 예산 없이 승인된다(overage·reset credit false). metered: 예산 없음과 추정 없음은 WAITING_BUDGET이다. 예산 1.00에서 0.4 + 0.4 예약 뒤 0.4는 거절되고, 첫 실행을 0.10으로 정산하면 다시 들어간다. 실행당 한도, 공급자 예산(다른 공급자 사용은 세지 않음), 앱 예산 0, 다른 소유자는 영향 없음을 확인했다. 정산: turn 보고 0.05 + 0.07(중복 key 1개, message 줄 무시) = 0.12, session 누적 0.10→0.25(같은 요청의 turn 보고 무시) = 0.25, 두 번 정산은 409다. 같은 작업의 다음 실행은 자기 보고만 센다(앞 실행을 늦게 정산해도 0.30). 보고되지 않은 비용은 UNKNOWN이고 예약액으로 계속 센다 |
| REQ-050-B / TST-050B: 한도 소진 시 무단 API 전환·추가 결제·reset credit 소비·무한 재시도를 하지 않는다 | paid overage, reset credit, API key는 WAITING_USER다. 비용 종류를 모르는 로그인은 WAITING_BUDGET이다. 같은 작업의 다른 공급자는 WAITING_USER다. 작업당 실행 5번 뒤에는 거절한다(예약 5개). 예산 정지는 WAITING_BUDGET이고 handler는 실행되지 않으며, 다시 배달해도 건너뛴다(자동 재개 없음). 실패한 실행도 정산된다(0.02). 고쳐 쓰기 1번, 검색 3번 제한이 있다. 예산 API: 음수 422, 남의 논문 404, intent 없음 422. 옛 fencing token은 예약하지 못한다 |

## RED → GREEN
- RED(`red.log`): budget 모듈이 없어 suite가 실패한다.
- GREEN: 통합 13
  - 처음 실패 두 가지
    - 시험끼리 소유자 수준 예산을 공유했다. 소유자 수준 예산 시험은 다른 소유자(carol)로 옮겼다.
    - **정산 버그**: JS Date(밀리초)로 "다음 실행" 경계를 비교해, 자기 예약을 다음 실행으로 보고 보고를 하나도 세지 않았다. 시각 비교를 모두 SQL 안으로 옮겼다.
  - 시험 하나는 같은 실행 안에서 turn 세션과 session 세션을 섞은 인위적인 경우였다. 기존 usage 요약(PW-029)과 같은 규칙(한 실행은 한 scope)에 맞춰, 두 공급자 형태(Claude turn, Codex session 누적)로 나눴다.
- 예산 질의는 논문 id와 공급자를 문자열로 끼워 넣던 것을 매개변수로 바꿨다(주입 위험 제거).
- mutation(`mutation.log`): 30종 모두 탐지
  - 처음 살아남은 2종은 시험을 더한 뒤 탐지했다: 공급자 예산이 모든 공급자를 셈, 다음 실행의 보고까지 셈.
- 회귀: `pnpm test` exit 0 — unit 406, integration 532, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 추가 결제, reset credit, API 전환, 공급자 교체는 사용자의 명시적 승인 없이는 일어나지 않는다. 이 앱에는 그 승인 경로가 없으므로 언제나 거절한다.
- 예산은 사용자만 정한다. 실행은 예산을 바꾸지 못한다(도구 정책의 `change_budget` 금지도 같은 뜻).
- 알 수 없는 비용은 0이 아니다. 예약액으로 계속 센다.

## 미실행 / 남은 위험
- **실제 공급자의 비용 보고는 시험하지 않았다.** Claude의 `total_cost_usd`는 구독에서 실제 청구가 아니라 API 환산값일 수 있다. 그래서 구독 실행의 정산 금액은 표시용이고 예산에서 빼지 않는다.
- 구독 로그인이 CLI 설정에 따라 추가 사용(유료)으로 넘어가지 않게 하는 것은 공급자 쪽 설정이다. live smoke에서 확인해야 한다. 이 앱은 그런 옵션을 요청하지 않는다.
- 공급자 앱 밖(웹, 다른 기기)에서 쓴 비용은 이 앱 예산에 들어오지 않는다(spec 08: 정확한 청구 상한 약속 없음).
- 예산 설정 화면이 없다(API만).
- 작업당 실행 5번과 job의 시도 3번(MAX_ATTEMPTS)이 따로 있다. 둘 중 먼저 닿는 쪽이 멈춘다.
- 검색 제한(`useJobLimit('search')`)은 아직 문헌 검색 도구에 연결하지 않았다(도구가 아직 LATER).

## 다음
PW-051: lease fencing·경합·outbox 복구

## 리뷰 (2bebfa4, 907d244): approve — MINOR 5, NIT 5
| 지적 | 처리 | 시험 |
|---|---|---|
| m1: Writer만 실행 승인을 거침 | worker main의 **모든 AI handler**(선택, 문헌 평가, 스토리, 프로필, Writer, 검토)를 승인으로 감쌌다(MOCK free). 실제 공급자를 붙일 때 그 로그인을 명시해야 한다(RFC-013) | main 연결(typecheck); 승인 동작은 기존 시험 |
| m2: 공급자를 부르지 않은 metered 실행(gate·정책·drift에서 멈춤)이 추정액을 영구히 씀 | 보고가 없고 그 실행의 fence로 **run token이나 run process가 없으면** 공급자에 닿지 않은 것이므로 0(known)이다. 닿았는데 보고가 없으면 UNKNOWN이다 | gate에서 멈춘 0.8 실행은 0.0000(known)이고 예산은 그대로다. run token이 있는 무보고 실행은 UNKNOWN이다 |
| m3: 충돌한 실행의 예약이 영영 정산되지 않음 | `settleOrphanReservations()`: 작업이 다른 fence로 돌거나 돌지 않는 예약을 정산한다. worker가 1분마다 돈다 | 충돌한 실행의 예약이 정산되고(0.05), 현재 실행의 예약은 그대로다 |
| m4: scope 규칙이 실행 단위라 세션을 바꾼 실행의 turn 비용이 빠짐 | **provider 세션마다** 규칙을 적용한다. 세션 id 없는 보고가 있으면 원장 요약처럼 실행 전체가 한 무리다. 정산 뒤 늦게 온 보고와 lease를 잃은 실행의 늦은 보고는 다음 실행으로 가거나 빠진다(남은 위험) | session 누적 0.10 세션 + turn만 보고한 세션 0.05 + 0.02 = 0.17 |
| m5: WAITING_BUDGET이 막다른 길, 상한 셋이 어긋남 | **남은 위험으로 기록**. 예산을 올려도 기다리는 작업이 다시 시작되지 않는다(취소하고 다시 요청, 화면 없음). 먼저 닿는 상한이 이긴다: 일시 오류 시도 3(MAX_ATTEMPTS, 재개도 claim이라 셈), 실행 5(재개 포함), 할당량 대기 6. 그래서 실제로는 실행 5가 대기 6보다 먼저 닿는다 | — |
| n1: 유료 overage를 감지할 수 없음 | 남은 위험으로 기록. 공급자 쪽 "추가 사용·크레딧"이 켜진 구독은 할당량 뒤에 청구될 수 있다. 공급자 rate-limit 사건에 overage 표시가 생기면 연결한다 | — |
| n2: 상태가 실제로 세는 것보다 적게 보임 | `counted_usd`(가드와 같은 규칙: 모르는 비용은 적어도 추정)와 앱 예산을 보여 준다 | 모르는 비용 0.6 실행: counted 0.6000 |
| n3: 예산 검증 | 실행당 한도가 예산보다 크면 422다. 앱·공급자 예산에서 `paper_id: null`, `provider: null`을 받는다 | 422 / 201 |
| n4: `useJobLimit`이 쓰이지 않음 | 남은 위험으로 기록. 고쳐 쓰기 1번은 PW-044가 자체 보장한다. 검색 한도는 문헌 검색 도구(LATER)가 생길 때 연결한다 | (기존 시험) |
| n5: 정산 실패가 실행 결과를 가림 | 정산 실패는 기록만 하고 실행의 결과(WAITING_* 등)를 그대로 둔다. 남은 예약은 sweep이 정산한다 | 정산이 먼저 되어 wrapper 정산이 실패해도 WAITING_USER |

- RED(`red-review.log`): 리뷰 시험 6개가 907d244에서 실패한다.
- GREEN: 통합 19
  - 처음 sweep 시험이 정확한 개수(1)를 기대했다. 같은 DB의 다른 시험이 남긴 미정산 예약도 정산하는 것이 맞으므로 "적어도 1"과 이 작업의 상태로 바꿨다.
- mutation(`mutation.log` 하단): 8종 모두 탐지
- 회귀: (아래 채움)
