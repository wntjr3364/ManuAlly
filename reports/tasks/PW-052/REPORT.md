# PW-052 — 오류 분류·bounded retry — REPORT
상태: in_review (2026-10-10)

## 무엇이 이미 있었고 무엇을 더했나
- **이미 있음**(PW-013·028·049·050)
  - 큐의 재시도: 보통 오류는 시도 3회(MAX_ATTEMPTS)까지 지연을 늘려 다시 큐에 넣는다. `JobOutcomeError`는 상태를 바로 정한다.
  - 취소(PW-028): 사용자 취소는 CANCELLED이고, 실행 프로세스를 정리한다.
  - quota 대기(PW-049)와 예산 승인(PW-050)
- **이 Task에서 더함**
  - `classifyError()` / `classifyEvent()`(`packages/providers/src/error-normalization`): 공급자 오류를 한 종류로 나눈다.
    - 종류: quota, auth, network, overloaded, budget, evidence_missing, schema, conflict, disk_full, invalid_request, unknown
    - 결과: 다음 상태, 사용자의 다음 행동, 재시도 여부, retry-after, 고정 안내문, 짧은 detail
    - 판단 순서:
      1. HTTP 401/403은 무조건 auth이고 429는 무조건 quota다. 메시지에 무엇이 쓰였든 같다.
      2. 공급자의 오류 type
      3. ENOSPC
      4. 네트워크 오류 코드
      5. HTTP 상태: 503/529는 overloaded, 500/502/504는 network, 그 밖의 4xx는 invalid_request
      6. 메시지 패턴
      7. 그 밖에는 unknown
    - 재시도하는 종류는 network와 overloaded뿐이다. unknown은 FAILED이고 "보고"를 안내한다.
    - detail은 비밀을 지운 뒤(`sk-…` 형 키, `Bearer …`, 32자 이상 불투명 문자열) 500자로 자른다.
  - `withErrorHandling()`(`apps/worker/src/errors`)
    - **circuit breaker**: 같은 공급자·로그인이 5분 안에 3번 과부하면 5분 동안 부르지 않는다. 그동안 실행은 handler(모델 호출) 없이 재시도로 돌아간다.
    - handler가 이미 정한 오류(`JobOutcomeError`: gate, 거절, quota 대기)와 lease 상실은 그대로 통과한다.
    - 그 밖의 오류는 분류한다. 실행이 아직 작업을 쥐고 있으면(fence) `run_errors`에 기록한 뒤 상태를 정한다.
      - quota → `QuotaExceeded`(PW-049 대기)
      - auth → WAITING_AUTH, 재시도 없음
      - budget → WAITING_BUDGET
      - evidence → WAITING_USER
      - schema, invalid request, disk full, unknown → FAILED
      - conflict → STALE
      - network, overload → 큐 재시도. 최대 3회이며, 다 쓰면 FAILED다.
    - 작업을 잃은 실행(취소됨, 다른 실행이 잡음)은 아무것도 기록하지 않는다. 원래 오류를 다시 던지고, 큐가 lease 상실로 처리한다.
    - 작업의 `last_error`는 고정 안내문과 `[종류]`다. 공급자의 원문은 담지 않는다.
  - migration `pw_052_0001`: `run_errors`, `provider_overloads`(둘 다 불변)
  - 실행 탭: FAILED, STALE, WAITING_* 작업에 사유와 다음 행동을 보인다(`run-reason`).

## 변경 파일
- write scope
  - `packages/providers/src/error-normalization/index.ts`
  - `apps/worker/src/errors/index.ts`
  - `db/migrations/pw_052_0001_run_errors.sql`
  - `tests/tasks/PW-052/classify.test.ts`(unit 27)
  - `db/migrations/pw_052_0002_deferred_runs.sql`(리뷰 반영)
  - `tests/tasks/PW-052/errors.int.test.ts`(통합 15, 리뷰 반영 뒤 17)
  - `tests/tasks/PW-052/runs-reason.e2e.ts`(브라우저 1)
- 범위 밖(RFC-013 부록)
  - `packages/domain/src/jobs/index.ts`(`deferJob`, 리뷰 반영)
  - `apps/worker/src/queue/index.ts`(`JobDeferred`, 결과 `deferred`, 리뷰 반영)
  - `packages/providers/package.json`(export 하나)
  - `apps/worker/src/main.ts`(조합)
  - `apps/web/src/features/runs/RunsTab.tsx`(사유 표시)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-052-A / TST-052A: 각 오류가 올바른 WAITING/FAILED 상태와 다음 행동을 표시한다 | unit: 종류별 표(Claude·Codex 메시지, HTTP, type, 코드). 통합: 401→WAITING_AUTH "log in again", budget→WAITING_BUDGET, evidence→WAITING_USER, schema→FAILED, conflict→STALE, ENOSPC→FAILED "disk is full", unknown→FAILED "not retried"; 각각 `run_errors`에 종류, 다음 상태, 행동이 남는다. 429→quota 대기(`quota_waits`), handler가 정한 오류는 다시 분류하지 않는다. 브라우저: WAITING_AUTH에 "Log in again", WAITING_QUOTA에 "usage limit"가 보인다 |
| REQ-052-B / TST-052B: 401을 quota reset으로 처리하거나 계정 문제에서 무한 반복 모델 호출하지 않는다 | 401/403은 메시지에 "rate limit"가 있어도 auth다. 메시지의 "log in again"도 429를 auth로 바꾸지 않는다. 401은 다시 배달해도 모델 호출이 1번이고 quota 대기가 없다. network는 3번 호출 뒤 FAILED다(무한 반복 없음). 과부하 3번이면 circuit이 열려 다른 작업도 부르지 않고, 다른 로그인은 영향받지 않는다. 공급자 원문과 비밀은 `last_error`·detail에 남지 않는다. 취소된 실행은 기록하지 않고 상태를 바꾸지 않는다 |

## RED → GREEN
- RED(`red.log`): 분류 모듈이 없어 unit suite가 실패한다.
  - 통합·브라우저 시험은 구현 뒤에 썼다. 따로 RED를 남기지 않았다. 대신 mutation으로 시험이 동작을 잡는지 확인했다.
- GREEN: unit 27, 통합 15, 브라우저 1, typecheck·lint 통과
- mutation(`mutation.log`): 21종 모두 탐지
  - 처음 살아남은 2종은 시험을 더한 뒤 탐지했다.
    - detail 500자 자르기 없음: 시험 문자열(`x`×5000)이 통째로 지워져 자르기에 닿지 않았다. 보통 단어로 된 긴 메시지로 바꿨다.
    - 작업을 잃은 실행이 기록함: 실행 중 취소 시험을 더했다.
  - 첫 실행의 redaction mutation 하나는 패턴 인용 오류로 적용되지 않았다. 고쳐 다시 돌렸고, 키·불투명 문자열 둘 다 탐지했다.
- 회귀(리뷰 전): `pnpm test` exit 0 — unit 433, integration 566, contracts 17, 브라우저 96 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 계정 문제(401/403)는 quota로 보지 않고 재시도하지 않는다. 사용자가 다시 로그인해야 한다. 앱은 로그인 정보를 읽거나 복사하지 않는다.
- 공급자 원문은 사용자 화면의 사유에 쓰지 않는다. 기록용 detail도 비밀을 지우고 자른다.
- 실패는 반쯤 저장되지 않는다. 제안 저장은 완료 트랜잭션 안에 있고, 오류는 그 전에 상태만 바꾼다.
- 재시도는 network·overload만, 큐의 3회 안에서 한다.

## 미실행 / 남은 위험
- **실제 공급자 오류는 쓰지 않았다**(실제 CLI 호출 금지). Claude/Codex 메시지와 HTTP 형태는 합성 fixture다. 실제 CLI가 다른 문구나 코드로 오류를 내면 unknown(FAILED, 재시도 없음)으로 떨어진다. 안전한 쪽이지만 안내가 덜 구체적이다. 사용자 PC의 live smoke에서 확인해야 한다.
- WAITING_AUTH, WAITING_BUDGET, WAITING_USER 작업을 다시 큐에 넣는 화면은 없다. 사용자는 새로 요청한다(기존 동작).
- `run_errors`를 보는 API·화면은 없다. 실행 탭은 작업의 `last_error`만 보인다.
- circuit breaker는 DB 기록으로 판단한다. 잠그지 않으므로 여러 worker가 같은 순간에 각각 한 번 더 부를 수 있다. half-open 시험 호출은 없다. 마지막 과부하 5분 뒤 닫힌다(review n1).
- `classifyEvent`는 아직 운영 코드에서 쓰지 않는다. 실제 adapter의 오류 사건을 handler가 던지는 경로에 붙일 때 쓴다(review n3).
- 실행 탭의 사유는 작업의 `last_error`다. PW-047/049/050의 옛 메시지는 "안내 + [종류]" 형식이 아니다(owner에게 안전한 문장이지만 형식이 다름, review n4).
- 미룬 claim도 실행 수(`billingAccount.runs`)에 들어간다(호출 없음, re-review n2). `JobDeferred`의 상한은 던지는 쪽이 진다(n3). circuit은 앱 시계와 DB 시계를 섞는다. worker와 DB가 다른 호스트면 시계 차이만큼 열림·닫힘이 어긋난다(n4).
- 메시지 패턴은 영어 문구만 안다. 로그인 문구와 한도 문구가 함께 있으면 로그인 문제로 본다(호출하지 않는 쪽).
- 지금 main.ts의 공급자는 MOCK(`authProfileId: 'none'`)이다. 실제 공급자를 붙일 때 로그인 id를 넘겨야 circuit이 로그인별로 나뉜다.

## 다음
PW-053: Crash·disk full·stale 재개 시험

## 리뷰 (73e756f): changes requested — MAJOR 1, MINOR 3, NIT 4
| 지적 | 처리 | 시험 |
|---|---|---|
| M1: circuit이 열린 동안 작업이 재시도 지연(2, 4초) 안에 시도 3회를 다 써서 FAILED가 됨("나중에 재시도" 안내와 다름). 과부하 한 번이 5분 동안 오는 모든 작업을 실패시킴. 매 claim이 예산 실행(PW-050)도 하나씩 씀 | circuit 검사를 `withCircuitBreaker`로 떼어 **승인 바깥**에 둔다(main.ts). 열려 있으면 실행은 아무것도 부르지 않고 `JobDeferred`를 던진다. 큐는 `deferJob`으로 작업을 QUEUED로 되돌린다. 이때 claim이 센 시도를 돌려주고(attempts−1, 같은 token), circuit이 닫힐 때까지 dispatch를 미룬다. 한 작업의 미룸은 6번(`CIRCUIT.maxDeferrals`)까지이고, 그 뒤에는 호출 없이 FAILED다. job guard(migration `pw_052_0002`)는 `deferJob`이 트랜잭션에 표시(`pw.defer_run`)했을 때만 RUNNING→QUEUED, attempts−1, 같은 token을 허락한다 | main.ts와 같은 조합으로 circuit을 연다. 새 작업을 6번 배달하면 매번 `deferred`, QUEUED, attempts 0, 호출 0, 예산 예약 0, circuit_open 기록 6이다. 다음 dispatch는 약 5분 뒤다. 7번째에는 호출 없이 FAILED다. circuit이 닫히면(시계 이동) 작업이 돌아 SUCCEEDED, attempts 1이다. guard: 표시 없음, −2, FAILED로, token 변경은 거절하고 정확한 미룸만 허락한다. 안에서 던진 미룸은 오류 처리를 그대로 지나간다 |
| m1: 메시지만 있을 때 한도 패턴이 로그인 패턴보다 먼저 맞음("Authentication failed: too many requests" → quota 대기 → 깨어나 다시 호출) | 로그인 패턴을 먼저 본다. 둘 다 있으면 로그인 문제(호출 없음) | unit: 두 문구가 섞인 메시지 2개 → auth, 한도만 → quota |
| m2: base64 키(`+/`), 짧은 `ghp_` 토큰, `x-api-key: …`가 detail에 남음 | 긴 불투명 문자열에 `+/=`를 포함한다. `key/token/secret/password/authorization/cookie` 뒤 `:`/`=` 값을 지운다(Basic/Bearer 포함). `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `AKIA`, `xai-` 접두를 지운다 | unit: 6가지 키, 5가지 label 형식이 지워진다. 보통 문장("the key point failed")은 남는다 |
| m3: 흔한 메시지가 unknown으로 떨어짐 | "credit balance is too low"는 auth다(API-key 과금이며 v1은 구독 로그인만 쓴다, WAITING_AUTH). "stream ended unexpectedly", "socket hang up", "premature close", "other side closed", "connection reset"은 network다(재시도 3회 안) | unit |
| n1: half-open 없음, 잠금 없는 판단 | 남은 위험으로 기록 | — |
| n2: 403 + 한도 type도 로그인 문제로 봄 | **반영하지 않음.** spec 08은 401/403을 WAITING_AUTH로 정한다. 잘못 고른 "다시 로그인"은 호출하지 않는 안전한 쪽이다. 반대로 고르면 권한 문제에서 깨어날 때마다 다시 호출한다 | unit: 403 + rate_limit_error → auth |
| n3: `classifyEvent` 미사용 | 남은 위험으로 기록 | — |
| n4: 옛 경로의 WAITING 사유 형식 | 남은 위험으로 기록(PW-054 실행 상태 UI에서 맞춘다) | — |

- RED(`red-review.log`): unit 3개(m1–m3), 통합 1개(M1 circuit 시험)가 실패한다.
- GREEN: unit 31, 통합 17, typecheck·lint 통과
- mutation(`mutation.log` 하단): 12종 모두 탐지
  - 처음 살아남은 2종 가운데 m1 변이는 로그인 패턴이 여전히 먼저여서 순서 변이가 아니었다. 순서를 뒤집는 변이로 다시 돌렸다.
  - 다른 1종(미룸이 오류 처리를 지나감)은 시험을 더한 뒤 탐지했다.
- 회귀(리뷰 반영): `pnpm test` exit 0 — unit 437, integration 568, contracts 17, 브라우저 96 (`pnpm-test-review.log`)

## 재리뷰 (eefd689): approve — NIT 4
| 지적 | 처리 | 시험 |
|---|---|---|
| n1: 긴 불투명 문자열 규칙이 UUID(작업·요청 id)와 긴 경로도 지움 | UUID 모양 전체는 남긴다. 경로는 계속 지운다(`/`가 든 base64 키와 구별하지 않는 보수적 선택) | unit: UUID는 남고, UUID 뒤에 더 붙은 문자열은 지워진다. mutation 1종 탐지 |
| n2: 미룬 claim도 fencing token을 올려 PW-051 `billingAccount.runs`(= token)가 호출 없는 claim을 셈 | 남은 위험으로 기록한다. runs는 "claim 수"이고 이미 "공급자 전에 멈춘 실행도 포함"이라고 안내한다(PW-051 m2). 과금 사용량(`sessions_with_usage`)은 영향받지 않는다 | — |
| n3: `JobDeferred`의 상한은 던지는 쪽에만 있음 | 남은 위험으로 기록한다. 지금 던지는 곳은 circuit breaker 하나이고 6번 상한이 있다. 새 호출자는 자기 상한을 가져야 한다(`JobDeferred` 주석) | — |
| n4: circuit 판단이 앱 시계와 DB 시계(`provider_overloads.created_at`)를 섞음 | 남은 위험으로 기록한다. 지금 배치는 worker와 DB가 같은 호스트다(개인 PC, 연구실 서버) | — |

- GREEN: unit 31, 통합 17, typecheck·lint 통과
- 리뷰 결론: approve. n1 반영은 작은 수정(unit 31, mutation 1/1)이라 재리뷰 없이 닫는다.
