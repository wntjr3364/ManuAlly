# PW-051 — Lease fencing·경합·outbox 복구 — REPORT
상태: in_review (2026-10-10)

## 무엇이 이미 있었고 무엇을 더했나
- **이미 있음**(PW-013·028·047–050): 작업 lease와 heartbeat, claim마다 오르는 fencing token, 그리고 모든 쓰기의 fencing 확인이다. 쓰기는 완료, 진행 사건, checkpoint, 예약, quota 대기다. 그 밖에 outbox(상태 변경과 같은 문장에서 배달 메시지 작성), 만료 lease 회복(`recoverJobs`), 제안 적용 CAS(PW-017/042)가 있었다.
- **이 Task에서 더함**
  - `reconcileInflight()`(worker): 한 번의 회복 sweep이다.
    1. lease가 만료된 실행을 다시 큐에 넣거나, 시도를 다 쓴 작업은 FAILED로 한다(`recoverJobs`).
    2. 그렇게 회복된 작업마다 **상태 사건**을 남긴다(`status`, `lease_expired`, 이전 owner). 그래서 브라우저 진행 표시가 사라진 실행을 계속 보여 주지 않는다. 그 사이 다른 worker가 잡은 작업에는 사건을 남기지 않는다.
    3. 큐가 잃은 메시지를 다시 보낸다.
    4. 끝난 실행의 예약을 정산한다(PW-050).
    5. `recovery_log`에 기록한다.
    - local worker가 30초마다 돈다(기존 `recoverJobs` 자리).
  - `leaseState()`(domain): 누가 돌리는지와 lease가 만료됐는지를 보여 준다. 만료된 실행을 살아 있다고 보이지 않는다.
  - `billingAccount()`(domain): 작업의 실행 수, 사용량을 보고한 실행 수, 결과가 남은 실행 수(언제나 많아야 1)를 준다. 청구 보장은 `at_least_once`이고 `exactly_once: false`다. 결과가 버려진 실행도 공급자를 불렀을(청구됐을) 수 있으며, 그 사용량은 센다.

## 변경 파일
- write scope
  - `db/migrations/pw_051_0001_recovery_log.sql`
  - `packages/domain/src/leases/index.ts`
  - `apps/worker/src/recovery/index.ts`
  - `tests/tasks/PW-051/recovery.int.test.ts`(통합 11)
- 범위 밖(RFC-013 부록): `apps/worker/src/local/index.ts`, `apps/worker/src/main.ts`

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-051-A / TST-051A: worker 재시작/경합에도 문서 commit은 한 번 발생하고 진행 상태가 reconcile된다 | worker A가 provider 호출에서 멈춘 채 lease가 만료된다. 회복이 작업을 다시 큐에 넣고 상태 사건(QUEUED, lease_expired, 이전 owner A)을 남긴다. B가 이어받아 끝낸다(token 2). 깨어난 A는 `lost_lease`이고 제안은 1개다. 회복 기록이 남는다. 같은 메시지를 동시에 세 번 배달하면 한 번만 실행된다(나머지 duplicate, 늦은 중복도 duplicate). relay가 발행 뒤 표시 전에 죽어 다시 발행되면 두 번째 배달은 no-op이다. 큐가 잃은 메시지는 sweep이 다시 만든다. 같은 제안을 동시에 세 번 적용하면 원고 revision은 1개다(200 하나, 409 둘). 재큐 직후 다른 worker가 잡은 작업에는 낡은 사건이 없다. lease를 잃은 실행의 예약은 sweep이 정산한다 |
| REQ-051-B / TST-051B: expired worker가 fence를 무시해 수정하거나 외부 모델 과금까지 exactly-once라고 보고하지 않는다 | B가 돌고 있을 때 A(token 1)의 heartbeat는 false다. 진행 사건과 완료는 CONFLICT다. 남은 제안의 저장 checkpoint는 B의 fence(2)다. 시도를 다 쓴 작업은 회복 때 FAILED가 된다(사건 포함, 무한 반복 없음). 두 실행이 모두 사용량을 보고하면 계정은 runs 2, 사용량 실행 2, 남은 결과 1, `at_least_once`, `exactly_once: false`이고, 안내에 "not exactly once"가 있다. 만료되지 않은 작업은 만료로 보이지 않고, 다른 작업 id는 404다 |

## RED → GREEN
- RED(`red.log`): leases·recovery 모듈이 없어 suite가 실패한다.
- GREEN: 통합 11
- mutation(`mutation.log`): 11종 모두 탐지
  - 기존 fence(heartbeat, 완료)를 끄는 mutation도 이 시험이 잡는다.
  - 처음 살아남은 2종은 시험을 더한 뒤 탐지했다: 다시 잡힌 작업에 사건을 남김, 미정산 예약 정산 없음. 첫째에는 시험 hook(`afterRecover`)을 더했다.
- 회귀(리뷰 전): `pnpm test` exit 0 — unit 406, integration 549, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 결과는 현재 fence의 실행만 저장한다. 옛 실행은 무엇도 바꾸지 못한다.
- 청구는 정확히 한 번이라고 말하지 않는다. 버려진 실행의 사용량도 세고, 그렇게 보고한다.

## 미실행 / 남은 위험
- **실제 프로세스 충돌**(worker kill -9, DB 연결 끊김)은 시험하지 않았다. lease 만료를 DB에서 직접 앞당겨 흉내 냈다. 실행 프로세스 정리는 PW-028의 `reconcileRunProcesses`가 따로 한다.
- 외부 공급자 호출 자체는 중복될 수 있다. 버려진 실행이 이미 공급자를 불렀을 수 있다(과금 포함, spec 08). 이 경우를 막지 않고 숨기지 않는다.
- pg-boss 큐 경로는 같은 `processDelivery`를 쓰지만, 이 시험은 local relay로 했다.
- 회복 기록을 보여 주는 화면이 없다.

## 다음
PW-052: 오류 분류·bounded retry

## 리뷰 (eef38d2, 06b6bd8): approve — MINOR 2, NIT 4
| 지적 | 처리 | 시험 |
|---|---|---|
| m1: 회복 사건이 `status` 종류라 브라우저가 "새 실행 시작"으로 읽음(다시 큐에 들어간 작업이 "작업 중"으로 보임) | 회복 사건은 `error` 종류 `{reason: lease_expired, status}`다(브라우저 reducer는 이를 실행 시작으로 보지 않는다). worker id는 브라우저가 보는 데이터에서 빼고 회복 기록에만 남긴다 | reducer: 답 중 → job QUEUED → 회복 사건이면 phase는 queued이고 label이 유지된다. 사건 데이터에 worker id가 없다 |
| m2: `runs_with_usage`가 실행이 아니라 세션을 셈 | `sessions_with_usage`로 이름을 바꾸고 안내에 뜻을 적었다(실행은 claim 수이며, 공급자 전에 멈춘 실행도 포함) | 계정 시험 |
| n1·n2: 두 sweep이 한 회복에 사건 둘을 붙이거나, 다른 원인에 사건이 붙음 | 만료 실행의 회복과 그 사건을 **한 트랜잭션**(`FOR UPDATE SKIP LOCKED`)에서 한다. 사건은 그 sweep이 실제로 회복한 작업에만, 한 번 붙는다. `recoverJobs`는 잃은 메시지 재발송만 맡는다 | 동시 sweep 둘: 회복 1번, 사건 1개. 회복 직후 다른 worker가 잡아도 사건 1개이고 작업은 끝난다 |
| n3: 정산 sweep이 local worker 고리에 달림 | RFC-013에 적었다(pg-boss 배치는 `reconcileInflight`를 직접 돌려야 함) | — |
| n4: 늦은 중복 메시지가 재시도 지연을 건너뛸 수 있음(기존 동작) | 남은 위험으로 기록(결과는 맞음: claim 하나, fence) | — |

- GREEN: 통합 13
  - 기존 "다시 잡힌 작업에는 사건 없음" 시험은 바뀐 의미(회복과 사건이 한 트랜잭션)에 맞춰 "사건 1개, 새 실행이 끝남"으로 바꿨다.
- mutation(`mutation.log` 하단): 4종 모두 탐지(사건 종류, worker id 노출, SKIP LOCKED, 시도 횟수)
- 회귀: `pnpm test` exit 0 — unit 406, integration 551, contracts 17, 브라우저 95 (`pnpm-test-review.log`)
- 리뷰 결론: approve(MAJOR 없음). 반영분은 작은 수정(통합 13, mutation 4/4, 전체 회귀 통과)이라 재리뷰 없이 닫는다.
