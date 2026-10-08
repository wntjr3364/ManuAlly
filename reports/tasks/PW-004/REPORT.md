# PW-004 — 실행 세션·권한 격리 spike — 보고서

상태: **in_review** — 중요 발견 1건, 사고(incident) 1건 포함
일자: 2026-10-08

## 변경 파일
- `spikes/isolation/runner.mjs`
  - `prepareRun`: run별 디렉터리 home/tmp/work/inputs를 0700으로 만들고, 선택한 입력만 읽기 전용(0444)으로 복사한다. symlink, `..`, 절대경로, root 밖으로 가는 realpath, 없는 파일은 거부한다. run id 재사용을 금지한다.
  - `buildChildEnv`: env whitelist만 전달한다(PATH, run 전용 HOME/TMPDIR, LANG, TZ, provider profile dir). 개발용 `~/.claude`·`~/.codex`는 거부한다. 토큰은 서버의 0600 secret 파일에서만 읽는다.
  - `buildClaudeArgs` / `assertSafeClaudeArgs`: 명시 `--session-id` 또는 `--resume <uuid>`만 허용한다. `-c/--continue`, `--dangerously-*`, `--add-dir`, `--bare`, `--fork-session`, `--remote-control`, plugin 로딩 등은 거부한다.
    built-in 도구 0개(`--tools ""`), `--strict-mcp-config`, `--allowedTools mcp__paper`, `--permission-mode dontAsk`, `--permission-prompts none`, 선택적 `--effort`.
  - `buildCodexArgs`: `app-server --listen stdio://`만 허용(ws/unix socket 거부), `sandbox_mode="read-only"`, `approval_policy="never"`.
  - `spawnIsolated` / `cancelRun`: 별도 process group에서 실행한다. 취소는 SIGINT → SIGTERM → SIGKILL 순서로 **해당 group에만** 보낸다.
  - `collectStreamJson`: 우리가 정한 session id가 기준이다. provider가 다른 id를 보고하면 `sessionMismatch`로 표시하고 채택하지 않는다.
  - `createCodexRpcGuard`: PW-002 정책 적용. 모르는 server request는 decline한다.
  - `checkAuthIsolation` (**신규, 아래 발견에서 추가**): 빈 profile로 로그인 여부를 확인하는 sentinel. 모델 호출은 하지 않는다.
- `tests/tasks/PW-004/{isolation.test.mjs,fake-cli.mjs,fake-auth-cli.mjs}` — 10개 테스트
- `reports/tasks/PW-004/{red.log,green.log,live-negative-claude-empty-profile.json,auth-sentinel.cloud-dev-container.json}`

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-004-A 전용 session id, 명시 resume·interrupt, 원본 sentinel hash 유지 | TST-004A ×5 (fake CLI) | pass — **메커니즘만 검증**. 실제 provider의 resume/interrupt는 blocked |
| REQ-004-B 암묵 continue, symlink 원본 접근, 상속 HOME/config, sandbox 밖 shell surface 차단 | TST-004B ×5 | pass |

RED: `ERR_MODULE_NOT_FOUND`. 이후 auth sentinel 추가 시 export 없음으로 다시 RED. 최종 GREEN 10/10 (`green.log`).

## 진행 중 수정한 것
1. interrupt 테스트가 실패해 멈춤(hang). 원인은 이 컨테이너의 PID 1(`process_api`)이 고아 프로세스를 회수하지 않아, 종료된 손자 프로세스가 **zombie**로 남은 것이다(`/proc/<pid>/status`에서 `State: Z` 확인).
   - kill 자체는 정상 동작했다. 테스트의 생존 판정을 "zombie = 종료"로 수정했다.
   - (정정) 최초 보고서는 "정리 코드를 `t.after`로 옮겼다"고 썼지만 실제로는 반영되지 않았었다(편집 명령이 앞선 `pkill`로 중단됨). 리뷰 후 bf76f80에서 실제로 반영했다.
   - **운영 발견:** runner는 고아를 회수하는 init(systemd 서비스 또는 컨테이너에서 `tini`/`--init`) 아래에서 돌아야 한다.

## ⚠️ 중요 발견 — env/HOME 격리만으로는 자격증명 격리가 안 된다
실제 Claude CLI 2.1.294로 **빈** `CLAUDE_CONFIG_DIR`, run 전용 HOME, whitelist env(API 키·토큰 없음)로 음성 검사를 했다.
- 예상: 인증 실패.
- 실제: `claude auth status` → `loggedIn: true, authMethod: oauth_token`. `-p` 실행도 성공했다.
- 즉 이 클라우드 컨테이너는 **호스트 수준에서 자격증명을 공급**한다. 사용자 PC에서는 macOS Keychain 같은 OS 수준 저장소가 같은 종류의 위험이다.
- Codex 0.161.0은 빈 `CODEX_HOME`에서 `account: null`이었다 → isolated.

**대응 (구현함):** `checkAuthIsolation` sentinel.
- 모든 호스트에서 provider를 admission하기 전에 반드시 실행한다.
- 빈 profile인데 로그인이 보이면 `leak`, 판단 불가면 `unknown`이다. 둘 다 admission을 거부한다.
- 이 컨테이너 결과(`auth-sentinel.cloud-dev-container.json`): **claude=leak, codex=isolated**.

**설계 반영 (PW-006 / RFC):** 런타임은 **전용 OS 사용자**로 실행해야 한다.
- 그 사용자의 Keychain/홈에는 사용자가 런타임용으로 로그인한 자격증명만 둔다.
- 서버에서는 추가로 bubblewrap/컨테이너 sandbox를 쓴다.
- 이는 "선택"이 아니라 admission 조건이다.

## ⚠️ 사고 기록 — 승인 없는 모델 호출 1회
- 무엇: 위 음성 검사에서 실제 `claude -p` 실행이 인증에 성공해 모델 호출이 1회 발생했다.
- 내용: 합성 프롬프트 "Reply with the single word: ping". 사용자 데이터는 없었다.
- 사용량: input 2 / cache write 2,284 / output 4 tokens, CLI 추정 비용 $0.00918.
- 사용된 자격증명: 이 클라우드 개발 세션이 호스트 수준에서 제공한 것.
- 원인: "실패할 것"을 전제로 실제 호출 경로를 실행했다. Constitution상 실제 호출은 사용자 승인 계정·예산이 필요하다.
- 재발 방지:
  - 음성 검사는 이제 `claude auth status`(모델 호출 없음)로 **먼저** 인증 상태를 확인한다.
  - (정정) 최초 보고서는 "runner가 sentinel 결과로 실행을 거부한다"고 썼지만, 당시에는 sentinel이 구현만 되고 어디에서도 호출되지 않았다(리뷰 M5). bf76f80에서 `decideModelCall`과 `startProviderRun`에 연결했다.
  - 이후 이 컨테이너에서 실제 provider 실행은 하지 않았다.
- 부수 효과로 얻은 사실: 2.1.294가 위 플래그 조합을 그대로 받아들임을 확인했다.
  - `system/init`에서 tools=[], mcp_servers=[], permissionMode=dontAsk.
  - init의 `capabilities`에 `interrupt_receipt_v1` 등이 있다.
  - 이벤트 순서: system/init → assistant → rate_limit_event → result/success.
  - `rate_limit_event`라는 이벤트가 존재한다 → PW-029 quota 관측 후보.

## 실증된 것 / 미실증
| 항목 | 상태 |
|---|---|
| Claude 플래그 조합 수용, stream-json 이벤트 shape, 명시 session id 반영 | 실측(위 사고 실행에서) |
| Codex app-server stdio `initialize` / `account/read` 왕복 | 실측(로그인 없이, 모델 호출 없음) |
| 빈 profile auth sentinel | 실측: claude=leak, codex=isolated |
| process group 취소, 원본 폴더 불변, env 비상속 | fake CLI로 검증 |
| 실제 provider의 resume·interrupt·usage | **blocked** — 사용자 머신의 격리 profile 로그인 후 PW-024/025/030 |
| OS 사용자 분리, bubblewrap/컨테이너 sandbox, egress 제한 | **not_run** — 배포 호스트에서 검증 필요 |

## 잔여 위험
- 이 테스트는 root로 실행됐다. root는 0444 파일도 수정할 수 있으므로 **런타임은 non-root 전용 사용자 필수**다.
- Codex는 Linux sandbox에 bubblewrap이 필요하다(번들 bwrap 사용 경고). 서버에 `bubblewrap` 패키지 설치를 권장한다.
- `--allowedTools mcp__paper`의 서버 단위 허용 문법은 문서 기준이며, MCP gateway 연결은 PW-027에서 실측한다.

## 다음 Task
PW-005 집필 품질 baseline fixture.

## 독립 리뷰 후속 (bf76f80)
| 리뷰 | 조치 |
|---|---|
| M4 profile 경로 우회 | `buildChildEnv`가 `assertSafeProfileDir`를 사용한다(realpath·symlink·HOME·소유자). 소유자는 control plane이 아니라 **런타임 사용자** 기준 |
| M5 sentinel 미연결 | `startProviderRun`이 해당 provider의 admission 결정(`allowed:true`) 없이는 프로세스를 띄우지 않는다. 인자도 provider별로 검증 |
| M6 Claude 설정 표면 | `--restricted` 필수(user/project/local 설정·hooks 무시). runs root 상위에 CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude, .mcp.json, .codex가 있으면 거부. preflight가 managed settings 경로 존재를 기록 |
| M7 Codex shell | feature 15개를 `-c features.X=false`로 끔(측정: `codex-features.txt`). **`unified_exec`는 끌 수 없음.** `approval_policy="untrusted"`는 0.161.0에서 시작 거부(측정) → `on-request` 사용. 결론: Codex는 바깥 filesystem sandbox 필수(RFC-004) |
| 인자 denylist | `assertSafeClaudeArgs`를 allowlist로 교체. 값 검증, 중복 금지, 필수 잠금 플래그 확인, `=` 형태·묶음 short flag·위치 인자(prompt) 거부. prompt는 stdin으로만 전달 |
| prepareRun 허점 | hardlink(nlink>1) 거부. `O_NOFOLLOW` open + inode 재확인 후 fd에서 복사(TOCTOU). 실패 시 run 폴더 삭제. runs root는 group/world 쓰기·symlink·타 소유자 거부 |
| 프로세스 처리 | 리더 종료 후에는 그룹 일괄 kill 대신 `/proc`에서 같은 그룹이면서 리더보다 늦게 시작한 프로세스만 정리. spawn `error` 처리로 바이너리가 없으면 즉시 실패 |
| root에서 생략되던 검사 | root로 테스트할 때 가짜 provider를 **nobody(65534)로 실행**. 읽기 전용 입력 검사가 항상 수행되고, 실행 사용자 uid도 확인 |
| 임시 폴더 누수 | 모든 테스트가 `t.after`/`after`로 정리 |

재측정(`auth-sentinel.cloud-dev-container.json`, `tools/auth-sentinel.mjs`): claude=leak, codex=isolated.
- 중간에 Codex가 `unknown`으로 나온 적이 있다. 원인은 `untrusted` 설정으로 app-server가 시작하지 못한 것이다.
- 이 경우 sentinel은 실패 시 거부(fail-closed)로 동작했다.

테스트: 12/12 (`green.log`).

## 2차 리뷰 후속 (5de9421)
- **N1 (major)**: `startProviderRun`이 `-p`/`app-server` 뒤쪽만 검사하던 문제를 고쳤다. 이제 전체 argv를 검증하고, 테스트용 인터프리터 경로는 `cmdPrefix`로 분리해 따로 검증한다(절대 경로 파일만, 플래그 금지).
- **N2**: `--mcp-config`는 run 폴더 안 경로만 허용한다.
- **위조 가능한 admission**: `decideModelCall`이 만든 frozen 결정만 받는다(WeakSet 발급 확인). sentinel은 같은 host·24시간 이내여야 한다. 이 확인은 프로세스 안에서의 실수 방지이며, 제품의 권한 근거는 서버 DB 기록이다.
- **재사용된 pgid**: `groupStillOurs` 규칙을 쓴다. Linux는 프로세스 그룹 id로 쓰이는 PID를 재할당하지 않는다. 같은 번호를 리더로 쓰는 다른 프로세스가 있거나 /proc를 읽을 수 없으면 아무것도 kill하지 않는다. 리더 종료 뒤에는 그룹 signal을 보내지 않는다.
- **실행 직전 재검사**: 상위 폴더의 agent-config 파일을 다시 확인한다.
- **사용자 결정 반영**: 본인 Linux 계정 실행(RFC-004 개정). 테스트의 nobody 실행은 "root가 아닌 실행 사용자"를 흉내 내는 용도로 유지한다.
- 테스트: 15/15.

## sudo 없는 실행 위치 (사용자 결정 2026-10-08)
- `defaultRunsRoot` 순서:
  1. `$XDG_RUNTIME_DIR/paper-workspace/runs`: 본인 소유 0700일 때만 사용.
  2. 그 외에는 `<tmp>/paper-workspace-<uid>/runs`: 다른 사용자가 미리 만든 폴더이거나 권한이 열려 있으면 거부.
- 이 컨테이너에는 `XDG_RUNTIME_DIR`가 없다(→ 2번 사용). `unshare -Ur true`는 성공했다(비특권 user namespace 허용).
- codex 0.161.0 npm 패키지에 bwrap이 들어 있다(`@openai/codex-linux-x64/vendor/.../codex-resources/bwrap`) → 시스템 bubblewrap 설치(sudo) 없이 sandbox가 가능하다. 실제 sandbox 동작 검증은 PW-025/026에서 한다.
- `tools/auth-sentinel.mjs`는 runsRoot를 생략하면 이 기본 위치를 쓴다.
- 테스트: 17/17. PW-001 preflight에 `no_sudo` 항목(XDG 상태, user namespace)을 추가했다: 8/8.
