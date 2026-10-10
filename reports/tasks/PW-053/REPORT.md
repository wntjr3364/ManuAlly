# PW-053 — Crash·disk full·stale 재개 시험 — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
Writer 작업에 장애를 실제로 주입하는 시험 묶음을 만들었다(`tests/faults`, `tests/tasks/PW-053`).
- 데이터: 임시 PostgreSQL과 합성 데이터만 쓴다.
- 작성기: MOCK writer만 쓴다(공급자 없음).

주입하는 장애는 다음과 같다.
- **프로세스 강제 종료**: 별도 worker 프로세스(`tests/faults/writer-child.ts`)를 `SIGKILL`로 죽인다. 정리 코드는 하나도 돌지 않는다.
  - 공급자 호출 중
  - 결과를 저장하는 commit 안: 시험용 trigger의 `pg_sleep`으로 commit을 붙잡아 둔 채 죽인다.
- **디스크 포화**
  - DB: 시험용 trigger가 SQLSTATE 53100 `disk_full`을 낸다. 제안 저장 시, 호출 전 checkpoint 시, 원고 저장 시 각각 주입한다.
  - worker: `ENOSPC`
- **문서 변경**
  - 작업이 죽어 있는 동안 원고 수정
  - 호출 중 원고 수정: 초안이 따라 붙을 문단을 고친다.
- **승인 철회**
  - 작업이 죽어 있는 동안 outline 승인이 바뀜
  - 호출 중 outline 승인이 바뀜
- **취소**
  - 호출 중 취소한 뒤 프로세스 사망
  - commit 중 취소한 뒤 프로세스 사망

시험이 찾은 결함 둘을 고쳤다(범위 밖, RFC-013 부록).
1. **결과 저장 중 DB 디스크 포화가 재시도로 처리됨.**
   - 원인: 완료 트랜잭션의 오류는 handler 밖(`completeJob`)에서 난다. 그래서 PW-052 분류를 거치지 않았고 큐가 다시 시도했다.
   - 결과: 재시도마다 공급자를 다시 부른다. 저장할 수 없는 답을 위해서다. spec 08은 "disk full → 안전 중단·저장 미완 알림"이다.
   - 수정: 큐(`processDelivery`)가 `ENOSPC`·`53100`을 재시도 없이 FAILED로 둔다. 사유는 "disk is full… result was not stored… nothing was half-stored… free space"다. 분류기도 코드 `53100`을 disk_full로 안다.
2. **호출 중 outline 승인이 바뀐 답이 PENDING으로 저장됨.**
   - 적용은 이미 거절되었다(적용 시 gate 재검사, 409). 원고는 안전했다. 그러나 제안 목록에는 대기 중인 제안으로 보였다.
   - 수정: Writer가 완료 트랜잭션에서 gate를 다시 읽는다(`gateReasonsIn`, 적용 경로와 같은 검사). 계획이 바뀌었으면 답을 STALE로 저장하고, 사유("the plan changed while the paragraph was written (outline_not_active…)")를 남긴다.

## 변경 파일
- write scope
  - `tests/faults/inject.ts`: 디스크 포화, commit 붙잡기, 붙잡힘·해제 대기, worker 프로세스
  - `tests/faults/writer-child.ts`
  - `tests/tasks/PW-053/faults.int.test.ts`(통합 12)
  - `reports/tasks/PW-053/**`
- 범위 밖(RFC-013 부록)
  - `apps/worker/src/queue/index.ts`: 디스크 포화 = 안전 중단
  - `apps/worker/src/writer/index.ts`: 저장 시 계획 재검사 → STALE
  - `packages/domain/src/writer/index.ts`: `gateReasonsIn` export(기존 `gateHoldsIn`을 나눔, 동작 같음)
  - `packages/providers/src/error-normalization/index.ts`: 코드 `53100` → disk_full
- migration 없음

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-053-A / TST-053A: checkpoint에서 복구하며 중간 응답은 검증된 proposal 상태로만 보존된다 | **호출 중 SIGKILL**: 작업은 RUNNING(token 1)으로 남는다. 제안은 0이고 checkpoint는 호출 전 1개다. lease가 만료되면 회복 sweep이 QUEUED로 돌린다. 재수화는 resumable이고 남은 단계는 `provider_call`, 완료 작업은 없다. 새 실행은 호출 1번으로 끝나고, 제안 1개(PENDING), 마지막 checkpoint `after_proposal`(token 2)를 남긴다. 죽은 실행의 checkpoint에는 완료 작업이 없다. **commit 안 SIGKILL**: 검증 checkpoint는 남지만 제안과 작업 성공은 한 트랜잭션이라 둘 다 없다(RUNNING, result null). 재수화의 남은 단계는 `store_proposal`이다. 다음 실행이 답을 다시 만들어(호출 1번, at-least-once) 제안 1개를 저장한다. 늦게 온 옛 메시지는 duplicate다 |
| REQ-053-B / TST-053B: 복구 과정이 새 문서를 덮거나 저장 실패를 성공으로 표시하거나 취소 작업을 부활시키지 않는다 | **새 문서**: 작업이 죽어 있는 동안 owner가 저장한다. 회복된 제안의 base는 요청 당시 revision이고, 적용하면 owner revision 위에 붙는다(부모 = owner 저장, owner 문장 유지). 호출 중 초안이 따라 붙을 문단을 owner가 고치면 STALE로 저장되고, 적용은 409, head는 owner 수정이다. **저장 실패**: 제안 저장 시 DB 포화면 FAILED(재시도·재호출 없음, result null, 사유 "disk is full… not stored"), 다시 배달하면 skipped, 제안·`after_proposal` 없음. 호출 전 checkpoint 시 포화면 호출 0, FAILED. worker ENOSPC는 FAILED. 원고 저장 시 포화면 500 `{error: internal}`, head와 revision 수 그대로이고, 공간이 돌아오면 같은 저장이 201이다. **취소**: 호출 중 취소 후 사망하면 회복 sweep, `recoverJobs`, 재배달, 다시 sweep 뒤에도 CANCELLED(token 1)이다. 호출 0, 제안 0, 재수화 `job_cancelled`, 새 token의 checkpoint 없음. commit 중 취소 후 사망하면 취소는 200이고 CANCELLED, 제안 0. **승인 철회**: 죽어 있는 동안 outline이 바뀌면 재수화가 not resumable이고, 재개 실행은 호출 0으로 멈추며 제안 0. 호출 중 바뀌면 답은 STALE(`outline_not_active`)이고 적용 409, 원고 그대로다 |

## RED → GREEN
- RED(`red.log`): 12개 중 1개 실패. 결과 저장 중 DB 포화가 QUEUED(재시도)가 된다(FAILED 기대).
  - 그 전 실행 두 번은 시험 쪽 오류였다. 고친 뒤 위 RED를 다시 남겼다.
    1. lease 최소값(1000ms)보다 짧은 lease
    2. 붙잡힌 commit을 `pg_stat_activity.query`로 찾음 → `wait_event = 'PgSleep'`으로 바꿈
    3. 적용 요청의 `expected_revision_id` 누락
  - "호출 중 승인 변경" 시험의 첫 판은 제안이 있으면 적용 거절만 확인했다. 그래서 PENDING 저장을 잡지 못하고 통과했다. 결과를 드러내는 단언으로 PENDING을 확인한 뒤 STALE을 요구하도록 고쳤다. 이 RED는 로그 대신 mutation("plan change not stale")으로 확인한다.
- GREEN: 통합 12, typecheck·lint 통과
- 관련 suite: PW-013/042/044/046/047/049/051/052 통합 131, PW-052 unit 31 통과
- mutation(`mutation.log`): 7종 모두 탐지
  - 처음 살아남은 1종(placeHolds 늦음 검사 생략)은 호출 중 문단 수정 시험을 더한 뒤 탐지했다.
- 회귀: `pnpm test` (`pnpm-test.log`, 아래)

## 보안·과학적 실패 경로
- 결과는 완료 트랜잭션 하나로만 저장된다. 그 안에서 죽거나 디스크가 차면 반쯤 남는 것이 없다. 성공 표시도 없다.
- 디스크 포화를 재시도하지 않는다. 저장할 수 없는 답을 위해 공급자를 다시 부르지 않는다.
- 승인이 바뀐 계획의 답은 적용될 수 없다(적용 시 gate). 이제 저장 때부터 STALE로 보인다.
- 취소는 회복, 재배달, 이후 sweep으로 되살아나지 않는다.
- 외부 응답은 한 번만 만들어진다고 보장하지 않는다. commit 중 사망 뒤에는 다시 부른다(spec 08: 안전 재생성, 과금 at-least-once).

## 미실행 / 남은 위험
- **실제 파일시스템 포화**(작은 tmpfs 등)와 **전원 차단**은 하지 않았다.
  - 둘 다 root나 mount가 필요해 sudo 없는 연구실 서버 조건에 맞지 않는다.
  - DB 포화는 SQLSTATE 53100 주입, worker 포화는 ENOSPC 오류로 흉내 냈다.
  - asset(blob) 저장의 ENOSPC 경로는 시험하지 않았다. PDF 업로드가 디스크 포화에서 반쯤 쓴 파일을 남기지 않는지는 asset 저장 방식(`packages/domain/src/asset-policy/store.ts`: 임시 파일, fsync, rename)에 기대고 있다.
- **PostgreSQL 서버 자체의 사망**(재시작, WAL 복구)은 시험하지 않았다. DB는 정본이고, 그 내구성은 PostgreSQL 보증과 백업(spec 12, P07)에 맡긴다.
- 브라우저 쪽 저장 실패 표시(저장 실패 시 "저장됨"을 보이지 않음, 로컬 저장소가 차면 보고)는 PW-015 시험(`editor.e2e.ts` TST-015B, `recovery.test.ts` "a full storage is reported")이 맡는다. 이 Task에서 다시 만들지 않았다.
- 실행 중 `failJob` 자체가 DB 포화로 실패하면 작업은 RUNNING으로 남는다. lease 만료 뒤 회복 sweep이 다시 큐에 넣거나 시도를 다 쓰면 FAILED로 둔다(PW-051 경로).
- MOCK writer만 썼다. 실제 CLI 프로세스를 죽였을 때의 하위 프로세스 정리는 PW-028(`reconcileRunProcesses`)이 맡는다.

## 다음
PW-054: Run 상태 UI·운영 reliability gate
