# PW-049 — Quota 대기·리셋 재검증 — REPORT
상태: in_review (2026-10-10)

## 설계
- handler가 할당량 한도를 만나면 `QuotaExceeded`(공급자, 로그인)를 던진다.
  - `withQuotaWaits()`가 아직 작업을 쥔 실행(fencing)으로 지속되는 대기(`quota_waits`)를 남긴다.
  - 그 뒤 작업은 WAITING_QUOTA가 된다.
  - 대기가 6번을 넘으면 사용자에게 간다(WAITING_USER).
- **깨울 시각**은 그 공급자·로그인의 최근 관측(버킷·모델별 최신, 결정 시각 이전 것)으로 정한다.
  - 막힌 버킷이 **모두** 재설정되어야 하므로 가장 늦은 재설정 + 짧은 jitter(30–120초)다.
  - 재설정 시각을 모르는 버킷이 있으면 시각을 만들지 않는다. 제한된 backoff(15, 30, 60, 120분)를 쓰고, 깰 때 공급자 확인을 요구한다.
  - 공급자의 retry-after를 지킨다.
- **깨어날 때 판단**(`wakeDueWaits`, 행 잠금으로 한 번만, 이 순서):
  1. 작업이 아직 기다리는가. 아니면 닫는다(취소: `job_cancelled`). 공급자에게 묻지 않는다.
  2. 사용자의 **자동 재개 허락**이 유효한가. 없음, 철회, 만료면 WAITING_USER다(이유를 적음).
  3. **다른 버킷이 아직 막혔는가**(재설정 시각을 앎). 그 시각으로 다시 잡는다. 공급자에게 묻지 않는다.
  4. **공급자에게 묻는다**(probe). 로그인 필요면 WAITING_AUTH, 아직 막힘이면 backoff다. 모름이면 backoff인데, 재설정 시각을 알았고 지났고 막힌 버킷이 없을 때만 실행이 곧 확인이 된다.
  5. 논문이 아직 이 공급자로 보내도 되는가. 아니면 WAITING_USER(`policy_changed`)다.
  6. 작업이 요청된 문서 head가 그대로인가. 아니면 STALE(`document_changed`)이다.
  7. 모두 통과하면 작업을 다시 QUEUED로 둔다(dispatch 메시지는 상태 변경과 같은 문장에서 쓰임).
- 재개는 **제안 생성까지**다. 아무것도 적용하지 않는다. 공급자를 바꾸거나 추가 결제를 하지 않는다.
- **자동 재개 허락**은 사용자 행위다: `POST /api/papers/:paperId/jobs/:jobId/auto-resume`.
  - `{intent: allow_auto_resume, hours: 1–72}` 또는 `{intent: revoke_auto_resume}`
  - 끝난 작업은 409, 남의 작업은 404다. 가장 최근 행이 유효하다.
- job guard 변경(migration): WAITING_QUOTA → WAITING_USER, WAITING_AUTH, STALE 전환을 더했다.
- worker 연결: Writer handler에 wrapper를 씌웠고 1분마다 깨운다. 확인된 가용성 probe가 없어 probe 답은 "모름"이다. 그래서 재설정 시각을 아는 대기만 재개되고, 모르는 대기는 기다리다가 6번 뒤 사용자에게 간다.

## 변경 파일
- write scope
  - `db/migrations/pw_049_0001_quota_waits.sql`
  - `apps/worker/src/quota-scheduler/index.ts`: `QuotaExceeded`, `enterQuotaWait`, `withQuotaWaits`, `wakeDueWaits`
  - `tests/tasks/PW-049/quota.int.test.ts`(통합 11)
- 범위 밖(RFC-013 부록): `packages/domain/src/quota-waits/index.ts`, `apps/api/src/quota-waits/index.ts`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-049-A / TST-049A: 공급자 시각 이후 실제 사용 가능성을 재확인하고 승인 범위의 미완료 작업을 재개한다 | 재설정 30분 뒤 + jitter 60초에 깨운다. 그 전에는 아무 일도 없고 공급자에게도 묻지 않는다. 그 뒤 공급자에게 (그 공급자·로그인으로) 묻고, 사용 가능하면 작업이 QUEUED가 되며 dispatch 메시지가 1개 생긴다. 재개된 실행은 제안(PENDING)만 만들고 적용 revision은 없다. 허락 API: 0시간·73시간·intent 없음은 422, 남의 것은 404, 허락·철회가 기록되고, 취소된 작업은 409다. 재설정 시각을 알고 지났으면 공급자가 "모름"이어도 재개된다 |
| REQ-049-B / TST-049B: 다른 bucket이 남았거나 unknown reset·취소·승인 만료 상태에서 무조건 실행하지 않는다 | 막힌 버킷이 둘이면 늦은 쪽(주간)에 깨운다. 나중에 관측된 주간 한도는 공급자에게 묻지 않고 그 재설정으로 다시 잡는다. 재설정 모름이면 15분 → (모름) 30분 → (막힘) 60분이고, 확인될 때만 재개된다. 결정 시각 뒤의 관측은 쓰지 않는다. 취소된 작업은 닫히고 묻지 않는다. 허락 없음, 철회, 만료는 WAITING_USER다(사유가 last_error에 있음). 로그인 필요는 WAITING_AUTH, 전송 정책 변경은 WAITING_USER, 원고 변경은 STALE이다. 대기는 6번까지이고 그다음은 사용자다. 옛 실행은 대기를 만들지 못한다. 동시에 깨워도 한 번만 결정된다 |

## RED → GREEN
- RED(`red.log`): domain/worker 모듈이 없어 suite가 실패한다.
- GREEN: 통합 11
  - 처음 하나가 실패했다. 출력함에는 처음 요청 때 쓰인 메시지도 있다(시험에서 relay를 돌리지 않음). 그래서 "새 메시지 1개"로 고쳤다.
- mutation(`mutation.log`): 24종 중 23종 탐지
  - 처음 살아남은 "결정 시각 뒤의 관측도 씀"은 시험을 더한 뒤 탐지했다.
  - "SKIP LOCKED 제거"는 살아남았다(동등). 두 번째 결정은 잠금을 기다린 뒤 대기가 이미 결정된 것을 본다. 한 번만 결정됨은 상태 재확인과 DB trigger("decided once")가 보장한다. SKIP LOCKED는 기다리지 않게 할 뿐이다.
- 회귀: `pnpm test` exit 0 — unit 406, integration 514, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 사용자가 허락하지 않았거나 허락이 끝났으면 스스로 재개하지 않는다.
- 재개는 제안까지다. 적용, 공급자 교체, 추가 결제는 없다.
- 재설정 시각을 지어내지 않는다. 모르면 backoff와 공급자 확인이다.
- 결정은 fencing(진입)과 행 잠금(깨움)으로 한 번만 한다.

## 미실행 / 남은 위험
- **실제 공급자 가용성 확인(probe)이 없다.** 지금 worker의 probe는 "모름"이다. Codex는 account/rateLimits 읽기가 문서화되어 있으나 미검증이고, Claude는 확인 방법이 미확인이다. live smoke로 정할 일이다.
- 실제 Claude·Codex의 429를 `QuotaExceeded`로 바꾸는 연결은 provider run 경로에서 할 일이다. 지금은 Writer(MOCK)에 wrapper만 씌웠다.
- 자동 재개 허락과 대기 상태를 보여 주는 **화면이 없다**(spec 08 "웹 상태": 대기 이유, 확인된 재설정 시각 Asia/Seoul 표시, stop/resume). API만 있다.
- WAITING_USER가 된 작업을 사용자가 다시 큐에 넣는 길이 없다. 다시 요청한다.
- 재설정 시각은 공급자 보고에 의존한다. 보고가 틀리면 일찍 깨지만, 공급자 확인 단계가 막는다(probe가 생긴 뒤).

## 다음
PW-050: 비용 예산

## 리뷰 (39f954f, 144658b): approve — MINOR 4, NIT 5
| 지적 | 처리 | 시험 |
|---|---|---|
| m1: 할당량 대기 뒤 재개도 claim이라 작업의 재시도 횟수(3)를 써 버림 | **남은 위험으로 기록**(고치려면 공유 job 모델 변경이 필요하고, 비용 예산과 함께 PW-050 이후에 다룬다). 재개를 두 번 한 뒤 일시 오류 하나면 작업이 FAILED가 된다 | — |
| m2: 재설정 시각 없는 다른 버킷이 남았는데 공급자 'allowed'로 재개됨 | Probe 계약을 명시했다: 'allowed'는 **이 로그인의 모든 한도**(창, 주간, 크레딧, 모델)를 공급자가 확인했다는 뜻이다. 그보다 약한 답은 'unknown'이고, 막힌 버킷이 있으면 'unknown'으로는 재개하지 않는다 | 5시간 창은 재설정, 주간은 시각 없음: 'unknown'이면 다시 잡고, 'allowed'(로그인 전체 확인)면 재개한다 |
| m3: WAITING_USER 안내가 없는 "resume"을 권함 | 안내를 "취소하고 원할 때 다시 요청"으로 바꿨다. 화면·재개 API가 없음은 남은 위험이다 | 안내에 "resume or cancel"이 없다 |
| m4: 원고를 어디든 고치면 기다리던 작업이 STALE | 문단 작업은 **자기 자리**만 본다(PW-042 `placeHolds`, 섹션 끝 배치 포함). 다른 작업은 head 비교를 유지한다 | 끝에 넣을 문단 작업은 다른 문단을 써도 재개된다. 따라갈 문단을 고치면 STALE이다 |
| n1: 공급자 확인(probe)이 잠금 안에서 실행됨 | 잠금 없이 먼저 판단해 필요할 때만 묻고, 그 뒤 잠금 아래에서 모두 다시 확인한다. 그 사이 상태가 바뀌어 답이 없으면 다음 회차에 결정한다 | probe 중에 작업·대기 행을 다른 연결이 잠글 수 있다 |
| n2: lease를 잃은 실행이 열린 대기를 남기면 다음 대기가 unique 위반 | 새 대기를 만들 때 열린 대기를 `closed`(`superseded`)로 닫는다 | 남은 대기가 닫히고 새 대기(attempt 2)가 생긴다 |
| n3: 막힌 버킷을 작업의 모델로 거르지 않음 | 남은 위험으로 기록(보수적: 다른 모델의 오래된 거절도 기다리게 함) | — |
| n4: retry-after만 있는 429는 지금 probe("모름")로는 자동 재개되지 않음 | 남은 위험으로 기록(약 7.75시간 기다린 뒤 사용자에게) | — |
| n5: 재개 때 공급자가 같은지 확인하지 않음 | 남은 위험으로 기록. 논문 전송 정책 검사는 그대로 적용된다 | — |

- RED(`red-review.log`): 리뷰 시험 4개(m3, m4, n1, n2)가 144658b에서 실패한다. m2 시험은 처음부터 통과한다(계약을 고정하는 시험).
- GREEN: 통합 16. 기존 "원고 변경" 시험은 자기 자리를 고치는 경우로 바꿨다(m4).
- mutation(`mutation.log` 하단): 6종 모두 탐지
- 회귀: (아래 채움)
