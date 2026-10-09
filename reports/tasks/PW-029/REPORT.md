# PW-029 — Usage·quota 관측 기본 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_029_0001_usage_quota.sql`
  - `usage_events`
    - run의 사용량 보고를 범위(message·turn·session)별로 남긴다. 원래 값과, session 누적 보고의 증가분(delta)을 함께 둔다.
    - `(provider, event_key)`는 유일하다.
    - 보고되지 않은 값은 NULL이고 `unknown_fields`에 이름을 적는다.
    - 누적이 줄어들면 `anomaly`로 표시한다.
    - 행은 바꿀 수 없다.
  - `quota_observations`
    - 계정 한도를 provider × auth profile × model × bucket으로 관측 시각과 함께 남긴다.
    - 초기화 시각이 없으면 NULL이고, 사유가 반드시 있다(CHECK).
    - confidence: provider_reported 또는 unknown. retry_after와 error_kind도 둔다.
    - 행은 바꿀 수 없다.
- `packages/domain/src/usage/index.ts`
  - `recordUsage`
    - 값 검사: 음수, 소수, 모르는 scope, window 0을 거부한다.
    - session 보고에는 native session id가 필요하다.
    - 같은 event key는 한 번만 저장한다(사전 확인과 `ON CONFLICT`).
    - session 누적은 같은 session에서 advisory lock을 잡고 delta를 계산한다. 기준은 지금까지의 최댓값이다.
  - `usageSummary`: 청구 사용량은 session마다 누적 delta → 없으면 turn → 없으면 message 순서로 한 범위만 센다. 범위를 더하지 않는다.
    - 보고가 빠진 값이 있으면 `unknown: true`이고, 아는 부분은 하한으로 둔다.
    - 문맥은 마지막 message/turn 보고의 입력과 window로 계산한다. 누적값은 쓰지 않는다.
  - `recordQuota`, `quotaStatus`(bucket별 최신 관측)
- 범위 밖(RFC-009 부록)
  - `apps/api/src/usage/index.ts`: `GET /api/papers/:paperId/usage`(소유자 범위), `GET /api/providers/quota`(로그인 필요)
  - `apps/api/src/server.ts`(등록)
  - `apps/web/src/features/paper/PaperPage.tsx`("AI 실행" 탭에 패널)
- `apps/web/src/features/usage/`
  - `format.ts`: 모르면 "알 수 없음", 일부만 알면 "N 이상(일부 보고 없음)". 비용은 "(추정)". 초기화 시각은 Asia/Seoul로 보여 주고, 없으면 "초기화 시각 확인 불가".
  - `UsagePanel.tsx`: 세 덩어리로 나눈다. 이 논문의 앱 사용량, 문맥(마지막 요청 기준), 계정 한도(공급자 관측). 관측 시각을 함께 보여 준다.
- 시험(`tests/tasks/PW-029/`)
  - `usage.int.test.ts` 7
  - `format.test.ts` 2
  - `usage.e2e.ts` 1

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-029-A / TST-029A 누적/turn/context metrics가 서로 구분돼 UI와 ledger에 저장 | 통합: turn 1000 → session 1000 → turn 3000 → session 4000. 청구 입력은 4000이다(합산하면 8000). 문맥은 3000/200000 = 1.5%다(누적 4000이 아님. 누적 보고에도 window가 있는 경우). ledger에는 범위, 원래 값, delta가 따로 남는다 |
| | 통합: session 보고가 없으면 turn을 더한다. 보고 없는 값은 unknown이고 아는 부분은 하한이다. 보고가 전혀 없는 논문은 전부 unknown이다. unknown_fields에 이름이 남는다 |
| | 통합 API: 소유자는 요약을 받는다. 다른 소유자는 404, 로그인하지 않으면 quota 401 |
| | 브라우저: "AI 실행" 탭의 사용량 패널 — 입력 4,000, 출력 300, $0.0300(추정), 문맥 "3,000 / 200,000 토큰 · 1.5%", five_hour 82.5%·초기화 오후 2:00(서울), seven_day "알 수 없음"·"초기화 시각 확인 불가"(`usage-panel.png`) |
| REQ-029-B / TST-029B 같은 cumulative event 재전달을 중복 합산하지 않고 null reset을 임의 시각으로 채우지 않음 | 통합: 같은 key 재전달은 duplicate다. 재개된 session이 같은 누적값을 새 key로 보내면 delta 0이다. 같은 key의 동시 전달 2개(session)와 4개(turn)도 한 번만 저장된다 |
| | 통합: 누적이 줄면 anomaly이고 delta는 NULL(음수 비용 아님)이다. 늦게 온 낮은 보고 뒤의 250은 최댓값 200 기준으로 50만 센다 |
| | 통합: 초기화 시각이 없는 quota는 NULL과 사유("reset time not reported")를 둔다. unknown 상태는 0%가 아니다. 형식을 모르는 시각은 원문과 사유로 남는다. DB는 사유 없는 NULL reset과 관측 수정을 거부한다 |
| | 통합: 음수, 소수, 음수 비용, 모르는 scope, window 0, 101%, 시각이 아닌 resets_at은 거부한다(0으로 저장하지 않음) |

## RED → GREEN
- 순서 기록: 이번에는 구현을 먼저 쓰고 시험을 나중에 썼다(작업 규칙과 다름).
  - 그래서 RED는 구현을 치운 상태에서 시험을 돌려 확인했다(`red.log`: 모듈이 없어 실패).
  - 동작 차원의 검증은 mutation으로 했다.
- mutation(`mutation.log`): 11번 실행했다.
  - 처음에 2종이 살아남았다.
    - 문맥을 누적 보고에서 읽기: 시험의 누적 보고에 window가 없었다(시험 공백). 누적 보고에 window를 넣어 탐지했다.
    - 중복 사전 확인 제거: `ON CONFLICT`가 같은 일을 하므로 같은 동작이다.
  - 최종 10종 탐지, 1종은 같은 동작.
- 개발 중 고친 것
  - 같은 key의 동시 turn 보고는 session lock 밖이라 UNIQUE 오류가 났다. `ON CONFLICT DO NOTHING` → duplicate로 고쳤다.
  - 화면에 "초기화 초기화 시각 확인 불가"가 겹쳐 나왔다. 고쳤다.
- GREEN: 통합 7, unit 2, 브라우저 1.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 273, integration 227, contracts 17, e2e 80, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- 비용은 공급자 보고값과 추정이다. 실제 청구액이라고 말하지 않는다(화면 문구).
- 모르는 값을 0으로, 없는 초기화 시각을 임의 시각으로 바꾸지 않는다(CLAUDE.md 불변조건).
- 계정 한도와 앱 사용량은 섞지 않는다. 문맥 %는 누적 청구량으로 계산하지 않는다(spec 08).

## 미실행 / 남은 위험
- **실제 공급자 보고의 기록 연결: not_run.** worker가 provider 이벤트(`usage`·`quota`)를 받아 `recordUsage`/`recordQuota`로 넘기는 일은 PW-030에서 붙인다.
- **event key는 adapter가 만든다.** Claude는 session id + message/result id, Codex는 thread id + turn id가 될 예정이다. key가 매번 달라도 누적 보고는 최댓값 기준이라 두 번 세지 않는다.
- **최댓값 기준의 대가.** 공급자가 누적을 0부터 다시 세면(session 재시작), 이전 최댓값을 넘기 전까지 증가분을 0으로 센다(과소 집계, anomaly 표시). 과다 집계보다 이쪽을 택했다. 예산 상한은 PW-050에서 따로 예약·상한으로 지킨다.
- 통화는 USD만, 소수 6자리로 반올림한다.
- 화면은 탭을 열 때 한 번 읽는다(실행 중 자동 갱신은 PW-054에서).

## 독립 리뷰 반영 (2026-10-09)
리뷰 결론: 변경 요청. MAJOR 1·MINOR 3·nit 4.
- MAJOR: 문맥 크기를 turn 합계로 계산했다. turn은 여러 모델 요청의 합이라, 450,000/200,000이 225%로 나왔다.
  - 고침: 문맥은 요청 하나의 보고(message scope)로만 계산한다. Claude의 message 보고는 cache 입력을 포함한다(PW-023). turn·session 보고만 있으면 "알 수 없음(요청 하나의 크기가 보고되지 않음)"이다. 문구는 "마지막 모델 요청 하나 기준"이다.
  - 시험: 두 요청(1300, 1700)으로 된 turn(3000)에서 문맥은 1700/0.9%다. turn만 있으면 unknown이다.
- MINOR-2: 한 필드가 줄면 같은 보고의 다른 필드 증가분까지 버렸다. 그런데도 합계는 "확실함"으로 보였다.
  - 고침: 필드마다 최댓값 대비 증가분(음수면 0)을 센다. anomaly는 표시만 한다. delta 합은 언제나 필드별 최댓값과 같다.
- MINOR-3: `"5"`가 2001-05-01로, zone 없는 시각이 서버 시간대로 해석됐다(임의 시각).
  - 고침: zone이 명시된 ISO 8601이나 epoch 초(숫자)만 시각으로 받는다. 그 밖은 원문(`raw_resets_at`)과 사유로 남긴다. `observed_at`도 같은 규칙이다.
- MINOR-4: 같은 run의 보고가 session id 유무로 두 묶음으로 갈려 두 번 셌다. run도 session도 없는 보고는 논문 전체가 한 묶음이었다.
  - 고침: run(job)이 있으면 run 단위로 묶는다. run도 session도 없는 보고는 거부한다.
- nit
  - 아무것도 모르는 토큰 수는 "알 수 없음"으로 보인다("0 이상" 아님).
  - 다시 읽기에 실패하면 "마지막으로 읽은 값"이라고 표시한다.
  - Codex event key는 turn 단위가 아니라 보고마다 따로 둔다(누적 보고가 turn 안에서 여러 번 오므로). RFC-010 연결 때 적용한다.
  - quota API는 로그인한 모든 소유자에게 보인다. v1은 한 사람 설치(owner 1명)를 전제로 한다. 여러 소유자가 될 때 auth profile에 소유자 범위를 넣는다(남은 위험).
- 증거: `red.log` 아래쪽, `mutation.log` 아래쪽(5종 탐지), 통합 8, unit 2, 브라우저 1.

## 다음
PW-030: 실제 provider 통합 gate
