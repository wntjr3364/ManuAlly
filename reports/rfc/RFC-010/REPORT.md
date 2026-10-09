# RFC-010 — 실제 provider를 sandbox 안에서 실행하고 worker run 경로에 연결 — REPORT
상태: in_review (2026-10-09) · 결정: 사용자 위임으로 채택(보안 경계 변경이라 사용자 확인 대상으로 표시)

## 무엇이 바뀌었나
1. **adapter는 스스로 CLI를 띄우지 않는다.** `packages/providers/src/core/launch.ts`
   - `Launcher` 계약: `version()`(끝까지 실행)과 `spawn()`(run process)
   - `assertLauncher`가 `sandboxed: true`가 아닌 launcher를 거부한다. Codex는 launcher의 sandbox 종류가 admission이 검증한 종류(`RunDecision.sandbox_kind`, 새 필드)와 같아야 한다.
   - 예외는 adapter 단위 시험용 `directLauncherForTests` 하나뿐이다. 이것이 출하 코드에 없다는 것을 source 검사 시험이 확인한다.
   - `startClaudeTurn`, `startCodexServer`는 `launcher`를 필수로 받고, `--version` 확인도 launcher로(같은 sandbox 안에서) 한다.
2. **worker의 sandbox launcher.** `apps/worker/src/provider-runs/sandboxed-launcher.ts`
   - CLI는 PW-026 sandbox 안에서 돈다. 함께 들어가는 것:
     - run 폴더
     - 읽기 전용: CLI 설치 폴더, Node 설치 폴더, gateway 폴더
     - 쓰기 가능한 다른 폴더: 격리된 로그인 profile 하나
     - network: run의 egress proxy를 거쳐서만
   - `--version`은 network 없이 같은 sandbox에서 실행한다.
   - 시작된 sandbox 프로세스의 환경에 run marker를 넣고 시작 시각을 즉시 읽는다(`identifyRunProcess`). 그래서 supervisor와 재시작 뒤 reconcile이 알아본다.
   - 그 프로세스를 끝내면 PID namespace가 끝나고, 안의 모든 것이 함께 끝난다.
3. **worker run 경로.** `apps/worker/src/provider-runs/index.ts` `runProviderTurn`
   - 하는 일(순서대로):
     - run 폴더와 그 안의 gateway 폴더(host가 만듦, 안에서는 읽기 전용)를 만든다.
     - job과 fencing token에 묶인 run token을 발급한다.
     - Claude: gateway socket과 MCP bridge를 둔다. mcp.json은 gateway 폴더 안이라 CLI가 바꿀 수 없다.
     - Codex: app-server의 tool 요청을 같은 gateway(`callTool`)로 답한다.
     - egress proxy를 연다.
     - adapter를 시작하고, run process를 기록하고, `superviseRun`으로 감독한다.
     - usage는 ledger로, quota는 관측 기록으로 보낸다.
   - 언제나 하는 정리:
     - token 폐기
     - 남은 run process 종료. 중간에 실패한 경우도 포함하며, 폴더를 지우기 전에 한다.
     - socket과 proxy 닫기
     - 폴더 삭제
   - `PROVIDER_EGRESS`: Claude·Codex host:443 목록. live smoke에서 실측해 확정한다.
4. **sandbox**(`infra/sandbox/sandbox.ts`)
   - `prepareSandboxCommand`: 명령만 준비하고 시작은 호출자가 한다. `runSandboxed`는 이를 이용한다.
   - `SandboxRun.gatewayDir`: run 폴더 바로 안의 폴더를 읽기 전용으로 다시 bind한다. 기존 `inputsDir`과 같은 방식이다.
   - 사설 `/tmp` tmpfs를 모든 bind보다 먼저 만든다. 전에는 읽기 전용 경로 bind 뒤에 만들어서 `/tmp` 아래의 읽기 전용 경로를 가렸다.
5. **lifecycle**: `identifyRunProcess`, `recordRunProcess`, `newRunMarker`. 기존 `startRunProcess`는 그대로 둔다.
6. **worker main**: 시작할 때와 1분마다 `reconcileRunProcesses`를 실행한다. PW-028 리뷰에서 "주기 실행은 RFC-010 연결"로 남겼던 일이다.
7. **gateway transport 이동**
   - `apps/api/src/agent-tools/{index.ts→tool-socket.ts, mcp-bridge.mjs}`를 `apps/worker/src/provider-runs/`로 옮겼다. 실제로 쓰는 쪽이 worker다.
   - api는 이 둘을 쓰지 않았다. 바뀐 것은 PW-027 시험의 import 경로뿐이다.
8. **수동 live smoke**(Claude: `tests/tasks/PW-024/live-smoke.manual.ts`, Codex: `tests/integration/providers/codex-live-smoke.manual.ts`)
   - 이제 실제 CLI를 worker와 같은 방식으로 sandbox 안에서 실행한다(`sandboxed-smoke.manual-helper.ts`).
   - 증거에 `ran_inside_sandbox: true`와 egress 기록이 들어간다. 그래서 등록부 승인 조건을 채울 수 있다.
   - 버전 문자열은 key를 만들려고 host에서 한 번 읽는다. adapter는 sandbox 안에서 다시 확인한다.

## 인수 조건 → 시험 (`tests/rfc/RFC-010/provider-runs.int.test.ts`, 통합 7)
| RFC 인수 조건 | 시험 |
|---|---|
| 대역 CLI를 sandbox 안에서 실행해 PW-030 chain을 다시 통과 | Claude: MCP bridge → gateway socket → `propose_manuscript_edit` → PENDING 제안, usage 기록, token 폐기, run process `exited`, 폴더 없음. Codex: app-server 안 tool 요청 → 같은 결과(usage 900), thread id |
| run 폴더 밖 쓰기, host loopback, abstract socket에 닿지 않음 | Claude 대역이 안에서 시도한다. host 파일 읽기와 run 밖 쓰기는 ENOENT다. 다른 run은 보이지 않는다. gateway socket 교체·gateway 폴더 쓰기는 EROFS다. host TCP와 abstract socket은 연결되지 않는다. 환경에 token·DB·marker가 없고 proxy 변수만 있다. 버전 확인을 sandbox 밖에서 하면 대역이 틀린 버전을 내서 거부된다 |
| 취소하면 sandbox 안의 프로세스까지 끝남 | 대역이 `setsid`로 세션을 떠난 `sleep`을 남긴다. job 취소 → supervisor → interrupt → group 종료 → host `/proc`에서 사라짐. token 무효 |
| (추가) 재시작 뒤 정리 | supervisor가 보지 못하는 run(죽은 worker)을 `reconcileRunProcesses`가 marker로 알아보고 끝낸다 |
| adapter는 sandbox 밖 실행을 거부 | launcher 없음 또는 host launcher → 거부(Claude·Codex). Codex: admission이 userns인데 bubblewrap launcher → 거부. 출하 코드에 시험용 launcher 없음(source 검사) |
| live 증거의 `ran_inside_sandbox: true` | 수동 smoke가 sandbox 안 실행 결과로 이를 기록한다. 등록부 검사 코드는 PW-030 그대로다. **실행: not_run**(사용자 PC) |

## RED → GREEN
- RED(`red.log`): 구현 전에는 모듈이 없어 시험 파일이 실패했다. 행동 단위 RED는 mutation이 맡는다.
- GREEN: RFC-010 통합 7. 기존 adapter·sandbox·gateway·lifecycle·PW-030 시험은 test launcher를 명시하고 통과했다.
  - 기존 시험 변경 1건: PW-026 bwrap argv 시험이 확인하던 순서("`--tmpfs /tmp` 바로 다음 run bind")를 새 불변조건으로 바꿨다. 새 조건은 "`/tmp`가 모든 bind보다 먼저"이고 gateway의 읽기 전용 bind도 확인한다. 조건을 더 엄격하게 바꾼 것이다.
- mutation(`mutation.log`): 14종 모두 탐지.
  - 처음 13종 중 marker 1종이 살아남았다. 재시작 뒤 정리 시험을 더한 뒤 탐지했다.
  - 목록: sandboxed 검사, Codex 종류 일치, Claude·Codex spawn·버전 확인을 launcher 밖에서 하기, gateway 읽기 전용 bind, tmpfs 순서, proxy network, marker, token 폐기, usage 기록, supervisor 생략, 폴더 삭제
- 회귀
  - 첫 실행(`pnpm-test-first-run.log`): PW-016 브라우저 시험 하나가 실패했다(인용만 선택 → 질문 → Esc → Shift+Home 뒤 도구막대 없음). PW-037에 이은 두 번째다. PROGRESS의 열린 항목이라 원인을 찾았다.
  - 원인: 팝업은 열린 뒤 한 tick 늦게 입력칸으로 focus를 옮긴다(`setTimeout(…, 0)`). 그 사이의 Esc는 편집기로 가서 사라지고, 팝업은 열린 채 남는다. 일부러 일찍 Esc를 누르는 probe에서 4회 중 1회 재현했다.
  - 제품도 고쳤다(`apps/web/src/features/selection-chat/SelectionChat.tsx`). 팝업이 열려 있으면 Esc는 focus가 어디에 있든 팝업을 닫는다. 입력칸 안에서는 기존 처리 그대로이고, IME 조합을 끝내는 Esc는 팝업을 유지한다.
    - 새 시험 `Esc closes the popup wherever the focus is`는 RED(`red-esc.log`) 뒤 GREEN이다.
    - 기존 시험에는 실제 사용 순서대로 "입력칸 focus 확인 → Esc → 팝업 닫힘 확인"을 넣었다. 같은 파일의 IME 시험과 같은 방식이다. 8회 반복에서 모두 통과했다.
  - PW-016·018·022 브라우저 시험은 21개 모두 통과했다.
  - 다시 전체 실행: `pnpm test` exit 0 — unit 278, integration 380, contracts 17, 브라우저 86 (`pnpm-test.log`)

## 미실행 / 남은 위험
- **bubblewrap backend: not_run**(설치되지 않음). argv 시험과 같은 코드 경로이지만 실제 실행 증거가 없다. bwrap이 있는 PC·서버에서는 `verifyOuterSandbox({backend:'bwrap'})`와 live smoke로 확인한다.
- **실제 Claude·Codex: not_run.** 실제 CLI가 `HTTPS_PROXY`를 따르는지, `PROVIDER_EGRESS`의 host 목록이 충분한지는 live smoke로 확정한다. 따르지 않으면 접속이 되지 않는다(안전한 쪽 실패).
- 실제 CLI 설치 폴더 구조(npm 전역, native 설치)에 따라 `--cli-root`가 필요할 수 있다.
- worker의 job intent 연결(어떤 job이 `runProviderTurn`을 쓰는지)은 P05 Writer(PW-042)에서 한다. 지금은 run 경로와 정리까지다.
- PDF 파서(PW-035)는 아직 이 sandbox 밖에서 prlimit만으로 돈다(network 격리 없음). 같은 launcher로 옮기는 것은 후속 작업이다.
- 같은 사용자 계정의 할당량, 커널 취약점은 완전히 격리되지 않는다(CLAUDE.md).

## 범위 밖 파일 (RFC-010 write scope 부록)
RFC 범위(`packages/providers/src/{claude,codex}/**`, `apps/worker/src/{runner,lifecycle}/**`, `apps/worker/src/provider-runs/**`, 관련 tests/reports) 밖:
- `packages/providers/src/core/{launch.ts(새), admission.ts(sandbox_kind), index.ts}`, `packages/providers/package.json`(exports)
- `infra/sandbox/sandbox.ts`(`prepareSandboxCommand`, `gatewayDir`, tmpfs 순서)
- `apps/worker/src/main.ts`(주기 reconcile)
- `apps/api/src/agent-tools/**` → `apps/worker/src/provider-runs/`(이동)
- 시험: PW-024·025·026·027, `tests/integration/providers/*`(test launcher 명시, 수동 smoke)
- 회귀 중 찾은 결함: `apps/web/src/features/selection-chat/SelectionChat.tsx`(Esc), `tests/tasks/PW-016/selection.e2e.ts`(대기 조건, 새 시험)

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 1, NIT 3)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 로그인 profile 하나가 모든 run에 쓰기 가능으로 bind됨. Codex는 sandbox 안 명령(`unified_exec`, 끌 수 없음)으로 다른 논문의 transcript와 `auth.json`을 읽을 수 있었다. Claude도 모든 논문의 세션이 한 profile에 있었다 | **논문마다 자기 CLI 상태 폴더**(`<stateRoot>/<provider>/<paper>`, 비공개·영속)를 쓴다. 세션과 transcript는 그 논문 것만 있다. 로그인 profile에서는 **credential 파일만**(`CREDENTIAL_FILES`: Claude `.credentials.json`, Codex `auth.json`) 그 폴더 안 자리로 읽기·쓰기 bind한다. token 갱신이 원래 파일에 그대로 반영된다. 로그인 profile의 나머지(다른 논문 transcript, settings, hooks)는 sandbox 안에 없다. sandbox에 단일 파일 bind를 더했다(`fileBinds`: 원본·대상 모두 실행 사용자의 비공개 일반 파일, 링크 없음, 대상은 쓰기 가능 폴더 안). 시작할 때마다 상태 폴더에 심어진 지시·hook·설정(`settings.json`, `CLAUDE.md`, `AGENTS.md`, `hooks/`, `.mcp.json`, 내용 있는 `config.toml` 등)이 있으면 거부한다(다음 run을 오염시키는 경로 차단). 로그인이 없으면 그렇게 말한다 | probe: 다른 논문의 상태 폴더 ENOENT, 로그인 profile의 다른 파일 ENOENT, credential은 읽힘(아래 공개). 상태 폴더 분리·transcript 위치·token 갱신 반영. 심어진 파일 4종 거부·로그인 없음 |
| MINOR: 반쯤 시작한 run의 정리에 시험이 없음 | 시험 추가: (a) 시작 기록 실패(worker id 제약 위반) → CLI와 손자 프로세스가 사라지고 폴더도 없음. (b) 이벤트 처리 실패 → 기록된 run이 종료됨 | `MINOR: a run that fails half-way` |
| NIT: Esc가 페이지 어디서든 팝업을 닫음 | 편집기, 팝업, 또는 포커스 없음(body)에서 온 Esc만 닫는다. 다른 입력칸·대화상자의 Esc는 팝업과 입력을 그대로 둔다 | 브라우저 `an Esc meant for another control` |
| NIT: quota bucket 이름 | 정규화된 provider_event v1의 quota에는 bucket이 없다. 바꾸려면 계약 버전 변경이 필요하다. 지금은 `reported` 하나로 두고 남은 위험에 적었다 | — |
| NIT: egress socket이 쓰기 가능한 run 폴더에 있음 | 읽기 전용 gateway 폴더로 옮겼다. CLI가 지우거나 바꿀 수 없다 | probe `replaceEgressSocket` EROFS |

- 수동 live smoke 도구도 같은 방식으로 바꿨다(smoke 전용 상태 폴더, credential bind).
- **공개**: CLI와 그 안에서 도는 명령은 자기가 쓰는 credential을 언제나 읽을 수 있다(로그인에 필요하다). 모델이 그것을 답에 되풀이할 위험은 남는다. 그래서 provider 답은 제안으로만 저장되고 사용자가 본다.
- RED(`red-review.log`): 532a52a 구현으로 새·바뀐 시험 7개가 실패한다. Esc 시험도 실패한다.
- GREEN: RFC-010 통합 10, PW-016 브라우저 10.
- mutation(`mutation.log` 하단):
  - 9종 탐지: credential bind 전달, 로그인 profile을 상태로 쓰기, 논문 간 상태 공유, 심어진 파일 검사, egress socket 위치(probe를 실제 위치로 고친 뒤), unshare 파일 bind, Esc 범위, 기록 안 된 시작의 종료(둘 다 제거 시)
  - 1종 동치: 기록 실패 시 종료는 `recordRunProcess`가 먼저 한다.
- 회귀: `pnpm test` exit 0 — unit 278, integration 383, contracts 17, 브라우저 87 (`pnpm-test-review.log`)
- 남은 위험(추가):
  - `CREDENTIAL_FILES`와 파일 bind 방식(제자리 쓰기)이 실제 CLI와 맞는지는 live smoke로 확인한다. CLI가 이름 바꾸기로 저장하면 갱신이 실패한다(인증 오류로 보임).
  - quota bucket 구분이 없다.
