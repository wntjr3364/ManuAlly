# RFC-010 — 실제 provider를 sandbox 안에서 실행하고 worker run 경로에 연결
Status: accepted (delegated, 2026-10-09) — 보안 경계 변경이라 P03 gate에서 사용자 확인 대상으로 표시한다. 구현은 P05 Writer(PW-042) 전에 한다
Trigger task: PW-030(P03 통합 gate)
Affected requirements/specs/contracts: REQ-024, REQ-025, REQ-026, REQ-027, REQ-028; docs/specs/07_AGENT_RUNTIME.md "실제 격리"

Problem and evidence:
- PW-024·025 adapter는 Claude CLI와 Codex app-server를 worker 프로세스에서 바로 띄운다.
- PW-026 sandbox는 동작하지만, adapter가 그 안에서 실행하지 않는다.
- Codex 승인 gate는 "이 host에서 sandbox가 검증됨"만 본다. 실제 run이 sandbox 안에서 도는지는 보지 않는다.
- PW-027 gateway, PW-028 수명 관리, PW-029 사용량 기록은 시험에서만 조합되어 있다(`tests/integration/providers/codex-pipeline.int.test.ts`). worker의 실제 run 경로에는 아직 없다.

Proposed change:
1. provider 실행 명령을 `runSandboxed`/`startRunProcess`의 형태로 감싼다.
   - network `proxy`. 허용 목록은 provider API host:443과, 로그인 갱신에 필요한 인증 host:443이다. 목록은 live smoke에서 실측해 확정한다.
   - 읽기 전용: CLI 설치 폴더. 쓰기: run 폴더와, 전용 격리 profile(개발자 `~/.claude`·`~/.codex`가 아님)의 bind. 자격증명은 복사하지 않는다(CLAUDE.md Safety).
   - 실행 사용자는 runtime 사용자다.
2. adapter가 그 감싼 명령을 쓰도록 바꾼다(`packages/providers/src/claude|codex/**`). 버전 확인(`--version`)도 같은 sandbox 안에서 한다.
3. tool gateway socket은 host 소유의 읽기 전용 폴더에 두고 bind한다(PW-027 리뷰 nit).
4. worker run handler
   - run token을 발급하고(job fencing), socket을 시작한다.
   - adapter를 시작해 `superviseRun`으로 감싼다.
   - 이벤트를 `recordUsage`/`recordQuota`로 넘긴다.
   - 끝나면 token을 폐기하고 socket을 닫는다.
5. Codex 승인 gate에 "이 run은 sandbox 안에서 시작됨"을 넣는다(sandbox 결정이 run과 함께 전달).

Alternatives considered:
- sandbox 없이 provider 내장 sandbox(Codex read-only)만 믿는다: P00 측정에서 `unified_exec`를 끌 수 없었다. 거부.
- 컨테이너(Docker) 사용: 사용자 결정(sudo·Docker 없이)과 맞지 않는다. 거부.

Security/privacy/budget/provider terms impact:
- 격리가 강해진다.
- CLI가 `HTTPS_PROXY`를 따르지 않으면 접속이 안 된다(안전한 쪽 실패). live smoke에서 확인한다.

Data migration / backward compatibility: 없음(새 연결)
Tests and acceptance criteria:
- 대역 CLI를 sandbox 안에서 실행해 PW-030 chain 시험을 다시 통과한다.
- run 폴더 밖 쓰기, host loopback, abstract socket은 닿지 않는다(PW-026 probe).
- 취소하면 sandbox 안의 프로세스까지 끝난다. unshare(`--kill-child`)와 bwrap(`--die-with-parent`, `--new-session`) 둘 다 시험한다.
- live 증거에는 `ran_inside_sandbox: true`가 있어야 등록부가 승인한다(PW-030 리뷰 반영으로 검사 코드에 넣음).
Write scope: `packages/providers/src/{claude,codex}/**`, `apps/worker/src/{runner,lifecycle}/**`, 새 `apps/worker/src/provider-runs/**`, 관련 tests/reports
User decision / reviewer: 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다. 독립 리뷰가 확인한다.
