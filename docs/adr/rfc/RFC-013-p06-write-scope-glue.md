# RFC-013 — P06 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-10)
Trigger task: PW-047 이후 P06 Task
Affected requirements/specs/contracts: REQ-047 … REQ-054; docs/specs/07_AGENT_RUNTIME.md, docs/specs/08_CONTEXT_QUOTA_AND_JOBS.md

Problem and evidence:
- RFC-011·012와 같은 이유다.
- P06 Task의 write scope는 해당 기능의 worker·domain 폴더와 migration만 준다.
- checkpoint·context 예산·할당량 대기·비용 예산은 이미 있는 job handler(Writer 등)의 경계에서 불려야 동작한다. 그래서 그 handler와 등록·화면 파일을 고쳐야 한다.

Proposed change:
- 각 Task가 범위 밖에서 고친 파일을 아래 부록에 Task별로 적는다.
- 공유 표(`jobs` 등)의 CHECK 변경은 그 Task의 migration에서 하고 부록에 적는다.
- 인증·청구 모델 변경은 이 RFC로 덮지 않고 별도 RFC로 한다.

Alternatives considered: RFC-011과 같다.

Security/privacy/budget/provider terms impact:
- checkpoint와 재수화는 모델을 부르지 않는다.
- 요약은 검증되지 않은 메모이고 승인·사실·완료의 근거가 아니다(spec 08).
- 재개 전에 정본과 정책을 다시 검사한다.

Data migration / backward compatibility: 새 표만(기존 표의 데이터는 바꾸지 않음)
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-047
  - `apps/worker/src/writer/index.ts`: Writer handler의 checkpoint 세 곳(호출 전, 검증 후, 제안 저장 — 마지막은 완료 트랜잭션 안). 두 번째 이후 실행은 마지막 checkpoint를 재검사하고, 바뀐 것이 있으면 WAITING_USER로 보낸다.
  - 리뷰 반영: `job_checkpoints`는 `jobs(paper_id, id)`를 참조하고 바뀌지 않는다(삭제 동작 없음). 지금은 작업·논문 삭제가 없다. 앞으로 보존 기간 정리나 논문 삭제를 만들 때 이 표를 함께 다뤄야 한다(review NIT 3).
- PW-048: 범위 밖 파일 없음
- PW-049
  - 새 도메인 폴더 `packages/domain/src/quota-waits/**`: 사용자의 자동 재개 허락(1–72시간, 철회)과 대기 목록. 허락은 사용자 행위라 인증된 API로만 받는다.
  - 새 route 폴더 `apps/api/src/quota-waits/**`, `apps/api/src/server.ts`(등록)
  - `apps/worker/src/main.ts`: Writer handler를 `withQuotaWaits`로 감싼다. 1분마다 `wakeDueWaits`를 돈다. 확인된 공급자 가용성 확인이 아직 없어 probe는 "모름"이다.
  - 공유 함수 변경(이 Task migration `pw_049_0001`): `pw_job_guard`에 WAITING_QUOTA → WAITING_USER, WAITING_AUTH, STALE 전환을 더했다. 다른 전환은 그대로다.
- PW-050
  - 새 route 폴더 `apps/api/src/budget/**`, `apps/api/src/server.ts`(등록): 예산 설정(사용자 행위), 논문 예산 상태
  - `apps/worker/src/main.ts`: Writer를 `withAdmission`으로 감싼다(바깥, MOCK은 free).
  - 리뷰 반영: `apps/worker/src/main.ts`가 모든 AI handler를 승인으로 감싸고, 1분마다 미정산 예약을 정산한다.
- PW-051
  - `apps/worker/src/local/index.ts`: 회복 주기에서 `recoverJobs` 대신 `reconcileInflight`를 부른다(상태 사건, 미정산 예약, 기록 포함).
  - `apps/worker/src/main.ts`: PW-050의 별도 정산 sweep을 뺐다(회복 sweep이 한다).
  - 리뷰 반영: 회복 sweep(`reconcileInflight`)은 지금 local worker 고리에서만 돈다. pg-boss 배치를 쓰면 같은 sweep을 주기적으로 직접 돌려야 한다(review n3).
- PW-052
  - `packages/providers/package.json`: `./error-normalization/index.ts` export 하나(worker가 분류기를 씀)
  - `apps/worker/src/main.ts`: 모든 AI handler를 승인(PW-050) ⊃ quota 대기(PW-049) ⊃ 오류 분류(PW-052) 순으로 감싼다. Writer의 별도 `withQuotaWaits`는 이 조합으로 옮겼다.
  - `apps/web/src/features/runs/RunsTab.tsx`: FAILED뿐 아니라 STALE, WAITING_* 작업에도 사유(다음 행동 포함)를 보인다.
  - `run_errors` 조회 API는 만들지 않았다(남은 위험).
  - 리뷰 반영(M1)
    - `apps/worker/src/queue/index.ts`: `JobDeferred`와 배달 결과 `deferred`. 일을 시작하지 않은 실행을 시도로 세지 않고 미룬다.
    - `packages/domain/src/jobs/index.ts`: `deferJob`(fenced, 시도 하나 반환, dispatch 지연)
    - 공유 함수 변경(migration `pw_052_0002`): `pw_job_guard`가 `pw.defer_run` 표시가 있는 트랜잭션에서만 RUNNING→QUEUED, attempts−1, 같은 token을 허락한다. 다른 규칙은 그대로다.
    - `apps/worker/src/main.ts`: `withCircuitBreaker`를 승인 바깥에 둔다(미룸이 예산 실행을 쓰지 않게).
