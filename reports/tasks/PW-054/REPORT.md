# PW-054 — Run 상태 UI·운영 reliability gate — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
- **실행 제어 패널**(`apps/web/src/features/run-control`): "AI 실행" 탭의 각 실행 옆 "자세히"로 연다. 실행 상태가 바뀔 때마다 서버에서 다시 읽으므로 보이는 값은 DB 값이다.
  - 상태, 시도 횟수
  - 사유와 다음 행동: 멈췄거나 기다릴 때만 보인다. 다시 큐에 들어간 작업에는 옛 사유를 보이지 않는다.
  - 공급자
  - 마지막 checkpoint: 경계, 남은 단계, 시각
  - 문맥(마지막 점검 때): 공급자 보고 / 추정(반올림, "약") / 알 수 없음
  - 한도 대기: 알려진 초기화 뒤 확인 시각, 또는 "초기화 시각 확인 불가 — 다음 확인 …"(서울 시각)
  - 자동 재개: 허용, 만료, 허용 안 함. 어떤 경우에도 "자동 재개는 초안·제안을 만드는 데까지만 합니다. 원고 적용은 언제나 직접 승인합니다."를 함께 쓴다.
  - 버튼: 다시 시작, 자동 재개 허용(1/6/24/72시간)·철회, 중지
- **서버**
  - `GET /api/papers/:id/jobs/:jobId/control`(`runControl`): 작업, 마지막 checkpoint와 그 공급자, 문맥(마지막 기록, 없으면 unknown이고 0이 아님), 한도 대기, 자동 재개 허락, 마지막 분류 오류, 지금 가능한 행동을 준다. lease와 fencing 정보는 내보내지 않는다.
  - `POST /api/papers/:id/jobs/:jobId/resume`(`resumeJob`): 사용자 행위다(명시 intent `resume_job`, actor `owner:`). WAITING_QUOTA/AUTH/BUDGET/USER인 작업만 QUEUED로 되돌리고, 열린 한도 대기를 닫으며, 바로 다시 dispatch한다. 새 실행이 gate, 정책, 한도, 예산을 다시 확인한다. 결과는 제안까지이고, 원고 적용은 사용자 행위다.
  - PW-052 리뷰에서 남은 위험이던 "WAITING_AUTH/BUDGET/USER 재개 화면 없음"을 이것으로 닫는다.
- P06 gate 보고: `reports/p06/P06_GATE.md`

## 변경 파일
- write scope
  - `apps/web/src/features/run-control/format.ts`, `RunControl.tsx`
  - `tests/tasks/PW-054/format.test.ts`(unit 6), `run-control.int.test.ts`(통합 7), `run-control.e2e.ts`(브라우저 1)
  - `reports/tasks/PW-054/**`, `reports/p06/P06_GATE.md`
- 범위 밖(RFC-013 부록)
  - `packages/domain/src/run-control/index.ts`
  - `apps/api/src/run-control/index.ts`, `apps/api/src/server.ts`(등록)
  - `apps/web/src/features/runs/RunsTab.tsx`(자세히/접기, 패널이 열리면 행의 중지 버튼은 패널 것만)
- migration 없음

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-054-A / TST-054A: AI 대기 중에도 수동 원고 편집·자료 열람이 되고 상태가 DB와 일치한다 | 통합: 한도 대기 작업의 control 값(상태, 시도, 사유가 jobs 행과 같음)을 확인한다. checkpoint `before_call`/`provider_call`, 오류 quota/wait_for_reset, 대기 1개(reset_known false), 문맥 unknown(null), 자동 재개 not_allowed, 행동 {cancel, resume, auto_resume}, fencing·lease 정보 없음. 대기 중 원고 저장 201, 근거·문헌·원고 읽기 200. 다시 시작: intent 없으면 422, 다른 owner 404, 같은 owner의 다른 논문 URL 404, 성공하면 QUEUED, 대기 closed("resumed by the owner"), 새 outbox 1, audit actor owner. 다시 다시 시작하면 409, 끝난 뒤 409, 취소된 작업 409. 브라우저: 패널이 DB의 WAITING_QUOTA와 사유·다음 행동, "초기화 시각 확인 불가", 문맥 "알 수 없음"을 보인다. 그동안 원고를 손으로 써서 "저장됨"(DB head에 그 글), 자료 탭이 열리고, DB 상태는 그대로다. 다시 시작하면 패널과 행이 QUEUED(DB 일치), 옛 사유는 사라지고, 중지하면 CANCELLED(DB 일치, 새로 읽어도 같음) |
| REQ-054-B / TST-054B: unknown 사용량을 0/정확한 백분율로 표시하거나 자동재개를 자동원고승인으로 취급하지 않는다 | unit: unknown 문맥은 "알 수 없음"(숫자 없음). 추정은 "약 141,000 / 200,000 토큰 (약 71%, 추정)"(소수점 백분율 없음). 공급자 보고는 정확 값과 70.5%. 창 크기를 모르면 백분율 없음. 초기화 모름은 "확인 불가 + 다음 확인(서울)". 자동 재개 문구 세 경우 모두 "원고 적용은 언제나 직접". 통합: 추정 문맥은 source 추정으로 그대로 전달된다. 자동 재개 허락(6시간) 뒤 wake가 재개해 실행이 끝나도 제안은 PENDING이고, 원고 head와 revision 수는 그대로다. 다시 시작한 실행도 PENDING 제안만 남고 원고는 그대로다. 브라우저: 자동 재개 허용 뒤에도 "원고 적용은 언제나 직접" |

## RED → GREEN
- RED(`red.log`): unit은 모듈이 없어 실패, 통합 6개는 route가 없어 실패(404).
- GREEN: unit 6, 통합 7, 브라우저 1, typecheck·lint 통과. 브라우저 증거: `1-waiting-run.png`, `2-resumed.png`
- 구현 중 시험 쪽 수정
  - outbox 수 단언을 "증가 1"로 바꿨다(시험에는 relay가 없어 첫 메시지가 미발행으로 남음).
  - 자동 재개 시험에서 논문이 그 공급자를 허용하도록 했다. 허용 없이는 wake가 `policy_changed`로 사용자에게 넘긴다. 이는 맞는 동작이다.
- 화면 확인 중 고친 것
  - 다시 시작한 뒤에도 옛 대기 사유가 보이던 것
  - 중지 버튼 중복
  - 기간 선택이 가로 전체를 차지하던 것
- mutation(`mutation.log`): 15종 모두 탐지
  - 처음 살아남은 1종(다른 논문의 작업 읽기)은 같은 owner의 다른 논문 시험을 더한 뒤 탐지했다. 같은 시험이 resume 쪽 변이도 잡는다.
  - 마지막 UI 변이 1종은 첫 실행이 중단되어 다시 돌렸다.
- 회귀(리뷰 전): `pnpm test`는 exit 1이었다. 실패한 시험은 없다(unit 443, integration 588 통과). 리뷰어의 임시 probe 파일(`zz-probe.int.test.ts`)이 수집된 뒤 지워져 그 파일 하나가 "Cannot find module"로 실패했다. 이 실행은 증거로 쓰지 않고, 리뷰 반영 뒤 다시 돌렸다(아래).

## 보안·과학적 실패 경로
- 다시 시작과 자동 재개는 모두 사용자 행위이고, 결과는 제안까지다. 원고 적용은 늘 사용자의 적용 요청(gate, CAS)을 거친다.
- 모르는 값(문맥, 초기화 시각)은 0이나 추정 시각으로 채우지 않는다. 추정은 추정이라고 쓴다.
- 패널은 lease와 fencing 같은 내부 정보를 보이지 않는다. 사유는 PW-052의 고정 안내문이고 공급자 원문이 아니다.

## 미실행 / 남은 위험
- 실제 공급자 한도와 문맥 값은 보지 못했다(MOCK, 합성 오류). 실제 CLI가 보고하는 값의 표시는 사용자 PC live smoke에서 확인해야 한다.
- 다시 시작은 시도 횟수를 되돌리지 않는다. 이미 3번 시도한 작업은 재시도 가능한 오류 한 번이면 FAILED다. 예산 실행 상한(5)도 그대로다.
- 예산 설정 화면은 여전히 없다(API만). WAITING_BUDGET에서 다시 시작해도 예산이 없으면 다시 WAITING_BUDGET이다.
- 문맥 줄은 지금 늘 "알 수 없음"이다. 문맥 예산 고리(PW-048 `runJobTurns`)를 쓰는 handler가 아직 없다(Writer는 한 번 호출). 기록은 문맥 점검·교체 때만 생긴다.
- 자동 재개는 worker의 가용성 probe가 늘 "모름"이라, 알려진 초기화 시각이 지난 대기에서만 일어난다.
- WAITING_USER가 실행 상한(`too_many_runs`)이나 대기 6번 소진 때문이면 "다시 시작"은 호출 없이 다시 WAITING_USER가 된다(review n2). 그 경우는 사유에 적혀 있다.
- 패널은 열려 있는 동안 5초마다 다시 읽는다(review m3). 이 주기 갱신은 자동 시험이 없다(브라우저 시험은 상태 변화로 다시 읽는 경로를 본다).
- 운영 로그/관측(spec 12: 반복 실패, orphan process, backup age, disk pressure의 운영 화면)은 P07 범위로 남긴다.

## 다음
P06 gate(`reports/p06/P06_GATE.md`) 뒤 P07: PW-055

## 리뷰 (bd9d1f3): approve — MINOR 4, NIT 3
| 지적 | 처리 | 시험 |
|---|---|---|
| m1: 사용자 다시 시작과 한도 scheduler가 잠금 순서가 반대라 교착(재현: 40P01 → 500) | 다시 시작이 scheduler와 같은 순서로 잠근다(작업의 열린 대기 → 작업). 그래도 교착이 나면 409 BUSY(아무것도 바뀌지 않음, 다시 시도) | scheduler처럼 대기를 잡은 트랜잭션이 이어서 작업을 잡아도 다시 시작은 기다렸다가 200 QUEUED(전에는 500). mutation(잠금 순서) 탐지 |
| m2: "다음 행동"이 다른 실행의 오류를 설명할 수 있음(예: 전 실행의 network 오류 → 예산 대기에 "자동으로 다시 시도") | 마지막 분류 오류에 `next_state`를 함께 준다. 화면은 그 오류가 지금 상태로 이끈 경우만 그 행동을 쓰고, 아니면 상태 자체의 다음 행동(예산 → 예산을 정한 뒤 다시 시작)을 쓴다. 대기·실행 중에는 없다 | unit: 예산 대기 + 옛 RETRY 오류는 예산 안내, 일치하면 오류의 행동, QUEUED는 없음. 통합: `next_state` 반환. mutation 2종 탐지 |
| m3: 패널이 상태 변화 때만 다시 읽음(대기 재조정·checkpoint가 안 보임) | 끝나지 않은 작업의 패널은 열려 있는 동안 5초마다 다시 읽는다 | 자동 시험 없음(남은 위험) |
| m4: P06 gate가 한계를 빠뜨림 | gate에 더했다: 문맥 예산 고리 미연결(문맥 줄은 늘 unknown), probe가 "모름"이라 자동 재개는 알려진 초기화 뒤에만, "화면 = DB" 행의 범위 | — |
| n1: "문맥(마지막 요청)"이 실제로는 마지막 점검 때 값 | "문맥(마지막 점검 때)"로 바꿨다 | 브라우저 |
| n2: 실행 상한·대기 소진 WAITING_USER에서 다시 시작은 다시 WAITING_USER | 남은 위험으로 기록(사유에 이유가 보임) | — |
| n3: 추정 백분율 반올림이 토큰 반올림과 다름 | 그대로 둔다(둘 다 "약…추정") | — |

- RED(`red-review.log`): unit 1(nextStepText 없음), 통합 2(교착 500, next_state 없음)
- GREEN: unit 7, 통합 9, 브라우저 1, typecheck·lint 통과
- mutation(`mutation.log` 하단): 3종 모두 탐지
- 회귀(리뷰 반영): `pnpm test` exit 0 — unit 444, integration 590, contracts 17, 브라우저 97 (`pnpm-test-review.log`)
- 리뷰 결론: approve(MAJOR 없음). 반영분은 작은 수정(RED→GREEN, mutation 3/3, 전체 회귀 통과)이라 재리뷰 없이 닫는다.
