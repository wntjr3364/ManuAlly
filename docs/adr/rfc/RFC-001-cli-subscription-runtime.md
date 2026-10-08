# RFC-001 — 런타임 AI를 사용자 본인 로그인의 Claude Code CLI / Codex CLI로 실행
Status: accepted
Trigger task: PW-002
Affected requirements/specs/contracts: REQ-002, REQ-024, REQ-025, REQ-030; docs/specs/07_AGENT_RUNTIME.md; docs/research/PROVIDER_COMPATIBILITY.md; contracts/provider_capability.schema.json (auth_mode 값)
Problem and evidence:
계획서는 인증 방식을 미정(API key 후보)으로 두었다. 사용자가 2026-10-08에 "API가 아니라 Claude Code, Codex로 사용"하고 "개인 PC와 연구실 서버 둘 다"라고 결정했다.
공식 문서 S01: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." → 다른 사람에게 로그인을 제공하는 제품은 불가. 계정 소유자 본인이 자기 머신에서 공식 CLI headless 모드를 쓰는 형태로 제한한다.
`--bare`는 OAuth를 읽지 않으므로(S02) 구독 모드에서는 쓸 수 없다. `ANTHROPIC_API_KEY`가 env에 있으면 `-p`가 항상 API 키를 쓴다(env-vars 문서).
Codex 0.161.0 app-server schema는 thread/turn/compact/interrupt/rateLimits를 제공한다(PW-002 inventory).
Proposed change:
- Claude: `claude -p --output-format stream-json` subprocess. 인증은 런타임 전용 `CLAUDE_CONFIG_DIR`에 사용자가 직접 로그인하거나 `claude setup-token` 값을 서버 secret 파일(0600)에 둔다. `ANTHROPIC_API_KEY`는 child env에서 항상 제거한다.
- Codex: private stdio `codex app-server`. 인증은 런타임 전용 `CODEX_HOME`에서 `codex login`.
- 두 provider 모두 같은 MCP paper tool gateway를 사용한다(ADR-013).
- registry의 `api_key` 모드와 MULTIUSER_HOSTED는 disabled.
- Agent SDK(TypeScript)는 PW-024에서 CLI 직접 구동과 비교 평가하는 대안으로 남긴다.
Alternatives considered:
- Anthropic/OpenAI API 키 과금: 사용자 거부.
- 개발용 `~/.claude` 공유: Constitution 위반으로 기각.
- 브라우저 쿠키/비공식 endpoint: 금지된 지름길로 기각.
Security/privacy/budget/provider terms impact: 구독 quota는 사용자의 터미널 사용과 공유된다(완전 격리 불가). 본인 전용 단일 소유자 배포만 허용한다. 실제 요금제 약관 최종 확인은 사용자 책임이며 live smoke 전까지 admission=requires_verification.
Data migration / backward compatibility: 없음(구현 전).
Tests and acceptance criteria: PW-002 TST-002A/B(통과), PW-004 auth sentinel, PW-024/025 live smoke(사용자 머신), PW-030 gate.
Write scope: spikes/provider-admission/**, P03 provider packages.
User decision / reviewer: 사용자 결정 2026-10-08. 독립 review 대기.
