# PW-013 — DB job·outbox·audit 기반 — REPORT
Status: in_review (독립 리뷰 대기) / Phase: P01 / Requirement: REQ-013

## 변경 파일
- `db/migrations/pw_013_0001_jobs_outbox_audit.sql`
  - `jobs`
    - intent 목록 제한
    - 같은 논문 안에서 `(paper_id, idempotency_key)`가 같으면 하나의 job
    - payload와 hash
    - 상태: QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED/STALE/WAITING_*
    - lease와 fencing token
    - 복합 FK `(paper_id, owner_id)`
  - guard trigger
    - 생성 시 QUEUED
    - intent·payload 불변
    - 정해진 전이만 허용, 종료 상태는 최종
    - fencing token 감소 금지, claim마다 새 token
    - 삭제·TRUNCATE 금지
  - `job_outbox`: job과 같은 트랜잭션에서 기록하는 발행 대기열. 내용과 발행 시각은 불변, 삭제 금지
  - `audit_events`
    - 불변
    - 기록 대상: job, story/outline revision, evidence, fact, claim의 생성·상태 변경과 job의 lease 재획득
    - trigger가 변경과 같은 트랜잭션에서 기록한다
    - actor는 `pw.actor`(owner:id / worker:id)이고, 앱 밖 SQL이면 `db:<role>`
- `packages/domain/src/jobs/index.ts`
  - `enqueueJob`: 호출자의 트랜잭션 안(client) 또는 새 트랜잭션(pool)에서 job과 outbox를 함께 기록
    - 같은 키를 다시 쓰면 기존 job을 돌려준다. 내용이 다르면 409
  - `claimJob`
    - 대기 중이거나 lease가 만료된 job만 가져간다
    - token+1, 시도 횟수+1
  - `heartbeatJob`
  - `completeJob`: job을 잠그고 현재 token을 확인한 뒤, 같은 트랜잭션에서 정본 쓰기(`apply`)와 SUCCEEDED를 기록
  - `failJob`
    - retry이면 다시 QUEUED로 두고 새 outbox를 backoff와 함께 만든다(최대 3회)
    - 그 밖에 FAILED / STALE / WAITING_*
  - `cancelJob`: 실행 중인 worker는 이후 token 검사에서 실패한다
  - 외부 응답에서 lease_owner·token은 숨긴다
- `apps/worker/src/queue/index.ts`
  - `relayOutbox`
    - `FOR UPDATE SKIP LOCKED`로 발행
    - 실패하면 시도 횟수·오류·backoff를 기록하고 나중에 재시도
    - 발행 후 기록 전에 중단되면 다시 발행한다(at-least-once)
  - `PgBossQueue`: pg-boss 12.34.0, 같은 PostgreSQL의 `pgboss` schema
  - `processDelivery`
    - 메시지는 job을 가리키는 포인터일 뿐이다
    - job row와 paper·intent가 다르면 rejected, 이미 끝났으면 duplicate, 취소되었으면 skipped
    - claim 실패는 duplicate
    - handler 결과는 completeJob의 fencing 검사 안에서만 정본에 쓴다
- `apps/api/src/routes/jobs/index.ts`
  - 목록, 조회, 취소(paper-scoped)
  - job 생성은 기능 경로(AI 초안 등)가 하고, 클라이언트가 직접 만들지 않는다
- 범위 밖 연결(RFC-006 부록 기록)
  - `apps/api/src/server.ts`: route 등록
  - `apps/worker/package.json`: pg-boss, pg, @pw/domain 추가
  - root `package.json` `pnpm.overrides`: 아래 의존성 참고

## 의존성 (CLAUDE.md "Versions": 14일 이상 지난 버전만)
- pg-boss **12.34.0**(2026-09-23, MIT)
  - 최신 12.37.x는 14일 미만이고, ADR-008이 "직전 안정 버전"을 지정했다
  - Node 엔진 요구는 22.12 이상이며, 설치된 Node는 22.22.0이다
- 하위 의존성 중 14일 미만인 두 개는 `pnpm.overrides`로 더 오래된 버전에 고정했다
  - rrule-temporal 2.8 → **2.2.6**(09-17)
  - serialize-error 13.0.2 → **13.0.1**(01-18)
  - 두 버전 모두 pg-boss의 semver 범위를 만족한다
- pg는 기존 8.23.0으로 통일했다

## 요구사항-시험 매핑 (`tests/tasks/PW-013/jobs.int.test.ts`, 실제 PostgreSQL + pg-boss)
| AC | Test | 결과 |
|---|---|---|
| REQ-013-A commit 후 재시작해도 job이 queue로 가고, 같은 intent는 중복 등록되지 않음 | 메모리 상태 없이 새 relay·queue·worker로 전달·실행·SUCCEEDED, 재발행 없음; 같은 키 동시 6회 → job 1개·outbox 1개, 키 재사용에 다른 payload 409; 호출자 트랜잭션 rollback 시 job·outbox 모두 없음; 미등록 intent·잘못된 키 거부 | pass |
| REQ-013-B 발행 장애·중복 메시지에도 유실·중복 정본 변경 없음 | 발행 실패 → 미발행·attempts·오류 기록 후 재시도 성공; 발행 후 기록 전 중단 → 실제로 queue에 메시지 2개, 처리 결과 completed+duplicate, 정본 1회; 같은 job 동시 5개 전달 → 1회만 실행; lease 만료 worker는 새 소유자 완료 후는 물론 **실행 중에도** 완료 불가(fencing); 정본 쓰기 실패 시 완료도 rollback; 취소된 job은 실행 안 됨; paper·intent가 맞지 않는 메시지 거부 | pass |
| 감사 기록 | job 생성→RUNNING→SUCCEEDED가 actor(owner/worker)와 함께 기록, 수정·삭제 불가; story revision 상태 변경도 기록 | pass |
| API | owner는 목록·조회·취소(재취소는 멱등), 다른 owner 404, 내부 lease 정보 비공개 | pass |

- RED: placeholder 상태에서 14/14 실패(`red.log`)
- GREEN: 15/15(`green.log`)
- Mutation 5종 모두 탐지
  - 키 중복 방지 제거
  - 발행 실패 후에도 발행 처리
  - job 감사 trigger 제거
  - live lease 무시
  - fencing 비교 제거: 처음에는 탐지되지 않았다. 새 소유자가 끝난 뒤에만 시험했기 때문이다. "실행 중 stale 완료" 시험을 추가해 탐지되게 했다
- 회귀: `pnpm test` exit 0
  - unit 50, integration 113, contracts 13, e2e 1, spikes 70
  - evals PASS, pack-check PASS

## 보안·과학적 실패 경로
- **queue는 정본이 아니다.** 메시지 내용(paper·intent)은 job row와 대조하고, 결정은 DB가 한다.
- **늦은 worker·중복 메시지는 정본을 바꾸지 못한다.** fencing token 검사와 정본 쓰기를 한 트랜잭션에서 하고, job row를 잠근다.
- **외부 모델 호출이 정확히 한 번이라고는 보장하지 않는다(spec 08).** 이 Task는 정본 변경의 1회성만 보장한다.
- **감사 기록은 앱 밖 SQL 변경도 남긴다(`db:pw`).** 다만 superuser는 trigger를 끌 수 있다. runtime role 분리는 기존 이월 항목이다.

## 미실행 / 남은 위험 / 이월
- **API 기능 경로와 job 연결.** PW-010의 `/ai/draft-requests`는 아직 gate만 검사한다.
  - 다음 단계: gate 재검사 + enqueue를 한 트랜잭션에서 하고, story/outline/node id를 payload에 고정한다(PW-010 리뷰 A-m2 이월).
  - PW-014 또는 P02에서 한다.
- **승인 함수의 actor.** PW-010·011 domain 함수는 `pw.actor`를 설정하지 않아 감사 actor가 `db:pw`로 남는다. 승인자는 각 행의 approved_by/verified_by에 있다. PW-014에서 정리한다.
- **worker 상시 실행 루프 없음.** 주기적 relay와 `processDelivery` 호출, 그리고 WAITING_QUOTA 재개 스케줄은 P02/P03(provider)에서 붙인다.
- **pg-boss 운영 설정은 미검증.** 유지보수, 보관기간, LISTEN/NOTIFY가 해당한다. queue 메시지는 받는 즉시 완료 처리한다(재전달은 outbox·lease가 담당).
- **완료된 job·outbox·audit의 보존 정책은 PW-061이다.**

## 다음 Task
PW-014 수동 수직 경로 E2E + P01 gate(리뷰 후).
