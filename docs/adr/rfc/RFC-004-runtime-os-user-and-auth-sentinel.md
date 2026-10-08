# RFC-004 — 런타임 격리: 본인 Linux 계정 + 분리된 CLI profile + auth sentinel + Codex bubblewrap
Status: proposed
Trigger task: PW-004
Affected requirements/specs/contracts: REQ-004, REQ-026, REQ-059, REQ-061; docs/specs/07_AGENT_RUNTIME.md, 09_SECURITY_AND_PRIVACY.md, 12_OPERATIONS_AND_BACKUP.md

Problem and evidence:
- PW-004 live 음성 검사(개발 컨테이너):
  - 빈 `CLAUDE_CONFIG_DIR`, run 전용 HOME, whitelist env에서도 Claude CLI 2.1.294가 `loggedIn: true (oauth_token)`를 보고했다.
  - 호스트 수준 자격증명 공급원이 있으면 env/HOME 격리로는 막을 수 없다.
  - Codex 0.161.0은 빈 `CODEX_HOME`에서 account=null(격리됨)이었다.
- Codex 0.161.0 실측:
  - `unified_exec`(명령 실행)는 `-c`, `--disable`, config.toml 어느 방법으로도 꺼지지 않는다.
  - `approval_policy="untrusted"`는 시작 시 거부된다.
  - 따라서 read-only sandbox 안 명령은 승인 없이 실행되고, 실행 OS 사용자가 읽을 수 있는 파일을 모두 읽을 수 있다.
- 이 컨테이너의 PID 1은 고아 프로세스를 회수하지 않는다(zombie 잔존).
- **사용자 결정(2026-10-08):** 실행 환경은 Linux이고, 별도 OS 사용자가 아니라 **본인 계정**으로 실행한다. AI를 쓰려면 논문 자료는 어차피 전송되어야 한다.

Proposed change:
1. 본인 Linux 계정으로 실행한다. 단, root로는 실행하지 않는다.
2. **Claude**:
   - 플랫폼 전용 `CLAUDE_CONFIG_DIR`(예: `~/.local/share/paper-workspace/claude`)에 사용자가 한 번 다시 로그인한다. 같은 Claude 구독 계정이어도 된다. 개발용 `~/.claude` 세션·설정·히스토리와 섞이지 않게 하는 것이 목적이다.
   - Linux에는 macOS Keychain 같은 OS 저장소가 없다. 그래서 profile 분리가 효과를 낼 가능성이 높다. 그 여부는 sentinel이 판정한다.
   - 모델에는 built-in 도구를 주지 않는다(`--tools ""` + `--restricted`). 본인 계정이어도 모델이 파일을 직접 읽거나 쓰지 못하고, MCP paper gateway만 쓴다.
3. **auth sentinel 필수**:
   - 각 머신(PC·서버)에서 admission 전과 CLI 업그레이드 후에 `spikes/isolation/tools/auth-sentinel.mjs`를 실행한다.
   - 빈 profile에서 `isolated`가 아니면(leak/unknown) 해당 provider를 admission하지 않는다.
   - 결과는 host와 시각을 가지며 24시간 안에 갱신해야 한다(spike 구현).
4. **Codex**: 본인 계정으로 실행하되 반드시 **bubblewrap**으로 감싼다.
   - 보이는 것: run 폴더(쓰기), `CODEX_HOME`(쓰기), 시스템 실행 파일·라이브러리(읽기 전용).
   - 보이지 않는 것: 홈의 나머지(~/.ssh, 연구 원본, 개발 저장소).
   - 이 sandbox가 실측으로 검증될 때까지(PW-025/026) Codex는 비활성이다.
   - 시스템 `bubblewrap` 패키지 또는 codex에 들어 있는 bwrap을 쓴다(sudo 불필요). preflight가 `bwrap` 존재와 비특권 user namespace 허용 여부를 기록한다.
5. runner는 고아를 회수하는 init 아래에서 실행한다(systemd user service, 또는 컨테이너 `--init`/tini).
6. **sudo 없이 동작한다(사용자 결정).** 실행 폴더(run)는 잠깐 쓰는 작업 공간이고 논문 정본은 DB/data root에 있다. 그래서 run 폴더는 다음 순서로 홈 밖의 본인 전용 위치에 만든다(`defaultRunsRoot`).
   1. `$XDG_RUNTIME_DIR/paper-workspace/runs`: 보통 `/run/user/<uid>`이며, 로그인 세션이 만들고 본인 소유 0700이다.
   2. 이 폴더가 없으면(systemd 세션이 없는 ssh 등) `/tmp/paper-workspace-<uid>/runs`를 쓴다. 다른 사용자가 미리 만들어 둔 폴더이거나 권한이 열려 있으면 거부한다.
   - 홈 아래(`~/.claude`가 있는 곳)에는 두지 않는다. Claude가 상위 폴더의 지침 파일을 자동으로 읽을 수 있기 때문이다.
   - 상위 폴더에 CLAUDE.md, AGENTS.md, .claude, .mcp.json, .codex가 있으면 준비 시와 실행 직전에 모두 거부한다.
   - data root(DB·원본 asset)는 홈 아래(`~/.local/share/paper-workspace` 등)에 두어도 된다. AI 프로세스는 거기서 실행되지 않는다.
   - Codex용 bubblewrap은 시스템 패키지가 없어도 된다. codex npm 패키지에 들어 있는 bwrap(`codex-resources/bwrap`)을 쓸 수 있다. 필요한 것은 커널의 비특권 user namespace 허용이며, preflight가 `unshare -Ur true`로 확인한다.
7. **외부 전송 정책 기본값(사용자 결정):** 사용자가 논문 프로젝트에 넣은 자료는 선택된 provider로 전송을 허용한다. 프로젝트별로 "민감 자료(개인식별·인체 유래) 전송 차단" 스위치는 남겨둔다. 자격증명·개발 파일·선택하지 않은 원본은 전송 대상이 아니다.

Alternatives considered:
- 별도 OS 사용자(이전 안): 격리는 가장 강하지만 사용자가 원하지 않았다. Claude는 도구 0개 + 분리 profile + sentinel로 충분히 대체된다. Codex는 bubblewrap으로 대체한다.
- env/HOME 격리만: 실측으로 불충분함이 확인돼 기각.

Security/privacy/budget/provider terms impact:
- 같은 구독 계정의 quota를 터미널 사용과 공유한다(완전 격리 불가).
- 본인 계정 실행이므로 runner 코드 자체의 버그는 사용자 권한으로 동작한다. 그래서 runner는 provider 프로세스에 위험 플래그·도구를 주지 않는 방식(allowlist, admission 필수)으로 방어한다.

Data migration / backward compatibility: 없음.

Tests and acceptance criteria:
- 이미 통과(spike):
  - sentinel 단위 테스트
  - 발급되지 않았거나 다른 provider용인 admission으로는 실행 거부
  - full argv allowlist, mcp-config 실행 폴더 제한
  - 비root 사용자 실행 시 0444 입력 수정 실패(PW-004)
- 사용자 머신에서 할 것:
  - sentinel isolated 확인
  - Claude live smoke(PW-024)
  - bubblewrap 안 Codex가 실행 폴더 밖(~/.ssh 더미 sentinel 파일)을 읽지 못함(PW-025/026)

Write scope: spikes/isolation/**(완료), P03 PW-026 runner, infra 문서.

User decision / reviewer:
- 2026-10-08 사용자: Linux, 본인 계정, 자료 전송 허용, **sudo 없이 동작해야 함**.
- 이 RFC의 나머지(분리 profile 로그인, sentinel, Codex bubblewrap)는 P00 gate에서 승인 필요.
