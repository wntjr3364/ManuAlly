# PW-028 — Interrupt·취소·재연결 — REPORT
상태: in_review (2026-10-09)

## 이미 있던 것(앞 Task)과 이번에 더한 것
- 앞 Task(PW-013/020)에 이미 있던 것
  - 취소 API: DB에 먼저 기록한다(`cancelJob`).
  - 작업의 fencing token: 취소되거나 넘겨진 run은 이벤트를 붙이거나 완료하지 못한다.
  - SSE `Last-Event-ID` 재생과 원고 화면의 "취소" 버튼.
- 이번 Task
  - worker 쪽 수명 관리: 저장된 취소 감지 → provider interrupt → 그 run의 process group만 종료 → 재시작 후 정리.
  - 다시 연결해도 DB 상태를 보여 주는 "AI 실행" 탭.

## 변경 파일
- `db/migrations/pw_028_0001_run_processes.sql`: `run_processes`
  - run마다 기록한다: job, fencing token, worker, host, pid, process group, 프로세스 시작 시각(clock ticks), 무작위 run marker.
  - 행은 한 번 쓰고, 한 번 끝낸다(`ended_at`, `end_reason`). 나머지 변경과 삭제는 trigger가 막는다.
- `apps/worker/src/lifecycle/index.ts`
  - `startRunProcess`
    - 자기 process group(detached)으로 시작하고, 환경 변수 `PW_RUN_MARKER`에 무작위 marker를 넣는다.
    - 시작 시각을 읽어 기록한다.
    - 기록에 실패하면 그 group을 바로 끝낸다(기록 없는 프로세스를 남기지 않음).
  - `watchJob`: job 행을 주기적으로 읽는다. CANCELLED → `cancelled`, 다른 상태나 다른 fencing token → `lease_lost`. DB 오류는 취소로 보지 않는다.
  - `superviseRun`
    - 프로세스가 스스로 끝나면: 남은 group 구성원을 정리하고 `exited`.
    - 중지 신호가 오면
      1. provider interrupt(기한 있음)
      2. 끝나면 `interrupted`
      3. 안 끝나면 `terminateRunGroup`
  - `terminateRunGroup`
    - 기록된 group에 marker를 가진 살아 있는 구성원이 있을 때만 신호를 보낸다. 신호마다 다시 확인한다.
    - SIGTERM → 유예 → SIGKILL(`terminated`/`killed`). 구성원이 없으면 아무것도 죽이지 않고 `gone`으로 기록한다.
  - `processMatches`: 같은 host, 살아 있음, 시작 시각 일치(재사용된 pid 구별), group 일치, marker 일치.
  - `reconcileRunProcesses`: 재시작 후 이 host의 열린 기록을 본다.
    - job이 그 token으로 아직 RUNNING이고 lease가 살아 있으며 프로세스가 맞으면 둔다.
    - 프로세스가 없으면 `gone`.
    - 나머지는 같은 확인을 거쳐 끝내고 `reconciled`.
  - 이름으로 끝내기(`pkill`, `killall`)나 `kill(-1)`, `kill(0)`은 없다(소스 검사 시험).
- `apps/web/src/features/runs/`
  - `run-state.ts`: 저장된 상태별 문구. 완료가 무엇인지 적는다: "답변 완료 — 원고는 바뀌지 않음", "제안 준비됨 — 적용은 원고에서 따로", "취소됨 — 결과 없음" 등.
  - `RunsTab.tsx`: 이 논문의 AI run 목록.
    - 서버에서 다시 읽는 때: 탭을 열 때, 실행 중인 run이 있으면 2초마다, 탭이 다시 보일 때, 네트워크가 돌아올 때.
    - 연결이 끊기면 "마지막으로 읽은 상태"라고 표시하고, 중지 버튼을 끈다.
    - "중지"는 서버에 취소를 저장한다.
- 범위 밖(RFC-009 부록): `apps/web/src/features/paper/PaperPage.tsx`("AI 실행" 탭 연결)
- 시험(`tests/tasks/PW-028/`)
  - `fake-run.mjs`: provider run 대역. 50 ms마다 출력하고, 같은 group에 손자 프로세스를 둔다. stdin "interrupt"로 멈춘다. 옵션으로 interrupt나 SIGTERM을 무시한다.
  - `lifecycle.int.test.ts` 9
  - `run-state.test.ts` 2
  - `runs.e2e.ts` 2(브라우저)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-028-A / TST-028A 취소가 지속 저장되고 재연결 화면은 DB의 최종 run 상태와 일치 | 통합: API 취소 → supervisor가 감지 → provider interrupt → 프로세스와 손자 종료. `run_processes`는 `interrupted`, job은 CANCELLED, SSE 재생은 `job … "status":"CANCELLED"`와 `end`로 끝난다 |
| | 통합: interrupt를 무시하면 SIGTERM(`terminated`), SIGTERM도 무시하면 SIGKILL(`killed`). lease를 다른 worker가 가져가도(`lease_lost`) 같은 순서로 멈춘다 |
| | 브라우저: 실행 중 새로고침해도 run은 RUNNING이고, 탭에 "실행 중"이 보인다. "중지" → DB CANCELLED, 화면 "취소됨 — 결과 없음". 1.5초 뒤에도 CANCELLED이고 `answer_done`이 없다. 다시 새로고침해도 같고, 중지 버튼이 없다 |
| | 브라우저: 오프라인이면 "연결 끊김 — 마지막으로 읽은 상태" 표시와 중지 비활성. 그동안 다른 곳에서 취소되고, 온라인 복귀 뒤에는 DB 상태(CANCELLED)를 보여 준다 |
| REQ-028-B / TST-028B 취소 후 늦은 response가 문서를 바꾸거나 broad pkill로 타 세션이 종료되지 않음 | 통합: 취소 뒤 같은 token의 `completeJob`(apply 포함)과 `appendJobEvent`는 "lease lost"로 거부된다. apply는 실행되지 않고, 문서 head는 그대로, job은 CANCELLED다 |
| | 통합: run A를 취소해도 같은 명령으로 도는 run B(다른 marker)와 그 손자, run 밖에서 같은 명령으로 띄운 개발자 프로세스는 살아 있다 |
| | 통합: 기록과 맞지 않는 프로세스(시작 시각만 다름 = 재사용된 pid, marker 없음)는 `processMatches` false이고, 종료 요청은 `gone`으로 아무것도 죽이지 않는다 |
| | 정적: worker 소스 전체에 `pkill`, `killall`, `kill(-1)`, `kill(0)`이 없다 |
| | 재시작 정리: 취소된 job의 남은 run은 끝내고 `reconciled`. 이미 없는 run은 `gone`. 아직 유효한 run은 그대로 둔다 |
| | 기록 불변: 끝낸 뒤 다시 바꾸기, pid 변경, 삭제는 거부한다 |

## RED → GREEN
- RED(`red.log`): 모듈이 없어 통합·unit이 실패했다. 탭이 없어 브라우저 시험 2개가 시간 초과로 실패했다.
- GREEN: 통합 9, unit 2, 브라우저 2.
- 개발 중 고친 것
  - 소스 검사 시험이 주석 속 "pkill" 낱말에 걸렸다. 주석을 고쳤다.
  - 재시작 정리 시험: leader만 죽이면 손자가 marker를 가진 채 남는다. 이것도 끝내는 것이 맞다. 시험은 "이미 끝난 run"을 group 전체 종료로 만들도록 고쳤다.
- mutation(`mutation.log`): 12번 실행해 11종을 탐지했다.
  - 살아남았던 1종: 시작 시각 검사 제거. 위조 기록이 모두 marker 검사에서 먼저 걸렸기 때문이다. → marker는 맞고 시작 시각만 다른 경우를 직접 시험해 탐지했다.
- 화면 증거: `runs-after-reconnect.png`, `runs-offline.png`(`PW_SAVE_EVIDENCE=1`).
- 회귀
  - 첫 전체 실행(`pnpm-test.first-run.log`): PW-015 브라우저 시험 1개가 실패했다("final check nit 2", 다른 탭 로그아웃 뒤 복구본이 남음).
  - 이 Task가 건드리지 않은 경로다. 단독 8회와 CPU 부하 속 10회를 반복했지만 재현되지 않았다.
  - 원인은 찾지 못했다. 다시 나오면 PW-015 결함으로 다룬다.
  - 두 번째 전체 실행 `pnpm test` exit 0(`pnpm-test.log`): unit 271, integration 220, contracts 17, e2e 79, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- **늦은 답은 정본에 닿지 않는다.** 이벤트·완료·proposal 쓰기가 모두 job fencing token을 거친다. 취소나 넘겨받기 뒤에는 거부된다.
- **다른 세션의 프로세스를 끝내지 않는다.** 대상은 기록된 group이고, 그 안에서도 marker를 가진 프로세스가 살아 있을 때뿐이다. 신호마다 다시 확인한다.
- **재사용된 pid를 쫓지 않는다.** `processMatches`는 시작 시각과 marker를 함께 본다. group 신호는 marker가 있는 구성원이 있을 때만 보낸다.

## 미실행 / 남은 위험
- **실제 Claude·Codex 연결: not_run**(live 금지)
  - adapter interrupt(Codex `turn/interrupt`, Claude 취소)를 `superviseRun`의 `interrupt`에 잇는다.
  - sandbox 실행(`runSandboxed`)을 `startRunProcess`로 시작한다.
  - 둘 다 PW-030에서 붙인다. 지금 run 경로(모의 provider, 프로세스 안)는 기존 fencing으로 멈춘다.
- **sandbox 안 프로세스에는 marker가 없다**(`env -i`). 그래서 끝내는 대상은 바깥 `unshare`/`bwrap` 프로세스다.
  - unshare backend: `--kill-child`와 pid namespace로 안쪽이 함께 끝난다.
  - bubblewrap: `--new-session`으로 다른 session이 되므로, 바깥 bwrap을 끝냈을 때 안쪽이 함께 끝나는지 PW-030에서 확인해야 한다(미설치로 미확인).
- **marker를 지운 자식은 정리 대상에서 빠진다.** run의 손자가 환경 변수를 비우고 새 session을 만들면 group·marker 검사로 찾지 못한다. 이 경우는 sandbox pid namespace가 막는다. sandbox 밖에서는 남을 수 있다.
- **취소 감지는 polling이다**(기본 500 ms). LISTEN/NOTIFY는 쓰지 않았다.
- **원고 화면의 진행 표시(JobStreams)는 새로고침 뒤 다시 나타나지 않는다.** 대신 "AI 실행" 탭이 저장된 상태를 보여 준다. 원고 화면에 다시 붙이는 일은 P06 PW-054(Run 상태 UI)에서 한다.
- PW-015 시험의 1회 실패(위). 원인 미확인.

## 다음
PW-029: Usage·quota 관측 기본
