# PW-002 — Provider 인증·배포 admission — 보고서

상태: **in_review**
일자: 2026-10-08

## 사용자 결정 (2026-10-08)
1. 런타임 AI는 API 키가 아니라 **사용자 본인 계정으로 로그인한 Claude Code CLI / Codex CLI**를 사용한다.
2. 배포는 **개인 PC(PERSONAL_LOCAL)와 연구실 서버(PRIVATE_SELF_HOSTED) 둘 다** 지원한다.
3. Codex 포함 여부와 계획 변경 승인은 구현자에게 위임 → v1에 두 adapter 모두 포함(Claude 먼저).

## 변경 파일
- `spikes/provider-admission/registry.json` — provider × auth × deployment 9개 조합, contract(`provider_capability.schema.json`) 필드 + 근거(evidence).
- `spikes/provider-admission/admission.mjs` — registry 검증, 모델 호출 gate, 인증 프로필 계획, CLI 버전 probe, Codex RPC 정책 검사.
- `spikes/provider-admission/codex-app-server-0.161.0.inventory.json` — `codex app-server generate-json-schema`로 생성한 메서드 목록(104 client requests / 10 server requests / 84 notifications)과 schema bundle sha256.
- `spikes/provider-admission/codex-rpc-policy.json` — client request allowlist 12개, 위험 surface deny 목록, server request 처리(모든 approval 요청 decline, `item/tool/call`만 tool gateway로).
- `tests/tasks/PW-002/admission.test.mjs` — 7개 테스트.
- `reports/tasks/PW-002/{red.log,green.log,cli-version-probe.json}`

## 조사 결과 (공식 문서 + 설치 버전 help/schema, live 호출 없음)
| 항목 | Claude Code CLI 2.1.294 | Codex CLI 0.161.0 |
|---|---|---|
| 프로그래밍 연동 | `claude -p --output-format stream-json` | `codex app-server` (stdio JSON-RPC) |
| 구독 인증 | 일반 `-p`는 구독 로그인 사용. **`--bare`는 OAuth를 읽지 않으므로 사용 불가.** `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`) 또는 격리된 `CLAUDE_CONFIG_DIR` 로그인 | `CODEX_HOME` 격리 + `codex login` (ChatGPT) |
| 위험 | `ANTHROPIC_API_KEY`가 env에 있으면 `-p`는 항상 API 키를 사용 → child env에서 반드시 제거 | `account/rateLimitResetCredit/consume`, `thread/shellCommand`, `command/exec`, `fs/*` 존재 → deny |
| 세션 | `--session-id <uuid>`, `--resume <id>`; `-c/--continue` 금지 | `thread/start`, `thread/resume(threadId)` |
| 도구 | `--tools ""`(built-in 전부 끔) + `--strict-mcp-config --mcp-config` | MCP 서버 config(`-c mcp_servers…`), sandbox `read-only`, approvalPolicy `never` |
| 중단 | SIGINT = turn 종료, SIGTERM = turn 미완 기록(exit 143) | `turn/interrupt(threadId, turnId)` |
| 압축 | `--autocompact` 존재, `-p`에서 수동 compact는 **unknown** | `thread/compact/start` + `thread/compacted` 알림 |
| 사용량/한도 | result의 usage/cost(추정치). 구독 quota·reset 조회는 **unknown** | `account/rateLimits/read`(usedPercent, windowDurationMins, resetsAt), `thread/tokenUsage/updated` |
| effort | `--effort low…max` | P03에서 확인 |

**설계 결론:** 두 provider 모두 **같은 MCP 기반 paper tool gateway**(run-token으로 범위 결정)를 붙인다. Claude의 built-in 도구와 Codex의 shell/fs 표면은 쓰지 않는다.

## 이용 조건 판단 (S01)
공식 문서: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products."*
→ 이 플랫폼은 **계정 소유자 본인만 사용하는 단일 소유자 도구**이며, 다른 사람에게 로그인이나 한도를 제공하지 않는다. MULTIUSER_HOSTED는 disabled. 연구실 서버도 본인만 접근하는 조건. 최종 이용조건 판단은 사용자가 자신의 요금제 약관으로 확인할 사항이며, live smoke 전까지 admission은 `requires_verification`이다.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-002-A 조합별 admission·출처·확인일·시험상태 | TST-002A ×3 (전 조합 존재 / 검증기가 누락·잘못된 enum·근거 없는 verified 거절 / multi-user·API key disabled) | pass |
| REQ-002-B credential 복사·private 접근 거절, 승인 전 모델 호출 0회 | TST-002B ×4 (gate가 mock 외 전부 거부 / 복사·쿠키·latest 세션·개발 config dir 거부 / probe는 `--version`만, HOME 격리, API 키·OAuth 토큰 미전달 / Codex 정책이 pinned schema와 일치하고 위험 surface 차단) | pass |

RED: `ERR_MODULE_NOT_FOUND` (`red.log`). GREEN: 7/7 (`green.log`).
실제 바이너리 버전 probe: claude 2.1.294, codex 0.161.0 (`cli-version-probe.json`, `--version`만).

## 미실행 / blocked
- **Live smoke (structured turn, session resume, interrupt, usage event 실제 shape, 401/429 정규화): blocked.** 이 클라우드 컨테이너의 Claude 자격증명은 개발 세션의 것이므로 런타임에 쓰면 안 된다(Constitution). 사용자 PC/서버에서 격리 프로필로 로그인한 뒤 PW-030 전에 실행해야 한다.
- Codex 로그인 상태에서의 `account/rateLimits/read` 실제 값: blocked(로그인 없음).

## 잔여 위험
- CLI는 자주 업데이트된다. 버전 pin과 inventory 재생성 + 정책 검사(`checkCodexRpcPolicy`)를 업그레이드 gate로 둔다.
- 구독 quota 공유: 같은 계정의 터미널 사용과 한도를 공유하며 완전한 격리는 불가능하다.

## 다음 Task
PW-003 문서 선택·포맷 왕복 spike.
