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
   - 정리 코드는 `t.after`로 옮겼다.
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
  - runner는 sentinel이 `isolated`가 아니면 실행을 거부한다(admission 조건).
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
