# RFC-002 — 실제 provider(Claude CLI) 최소 연결을 P02로 앞당김
Status: accepted (delegated)
Trigger task: PW-006
Affected requirements/specs/contracts: REQ-020, REQ-022, REQ-024; tasks PW-020, PW-024 순서
Problem and evidence:
현재 순서에서는 실제 AI가 P03 끝(30번째 Task)에야 연결된다. 사용자의 핵심 가치인 "웹에서 드래그 → 짧은 채팅 → 바로 수정"을 22개 Task 동안 Mock으로만 확인하게 된다. 구독 CLI 방식(RFC-001)은 API 키 발급 없이 사용자 PC에서 바로 쓸 수 있다.
Proposed change:
- PW-020 범위를 "Mock AI·스트리밍 UI + Claude CLI 최소 adapter"로 확장한다.
- 최소 adapter 조건: replace_selection 제안만, built-in 도구 0개, 격리 profile, auth sentinel 통과, 사용자의 명시적 사용 승인 필수.
- Codex와 전체 tool gateway는 P03 그대로.
- PW-024는 이 최소 adapter를 확장·강화하는 Task가 된다.
- 테스트 기본값은 계속 Mock이다. 실제 호출 테스트는 opt-in 플래그와 사용자 승인일 때만 실행한다.
Alternatives considered:
- 원래 순서 유지: 안전하지만 사용자 확인이 늦어진다.
- P01부터 연결: 정본·승인 기반 전에 AI를 붙이는 것이라 기각.
Security/privacy/budget/provider terms impact: P03의 격리를 앞당겨 일부 적용해야 한다. sentinel과 env whitelist는 PW-004 코드를 재사용한다. 사용자 quota를 쓰므로 실행마다 사용자 승인이 필요하다.
Data migration / backward compatibility: 없음.
Tests and acceptance criteria: PW-020에 "auth sentinel isolated가 아니면 실행 거부", "사용자 승인 없으면 호출 0회", "Mock과 같은 proposal 계약 통과" 테스트를 추가한다.
Write scope: PW-020 write_scope에 packages/providers/claude-cli-minimal/** 추가(P01 시작 시 manifest 반영).
User decision / reviewer: 사용자가 2026-10-08 계획 변경 판단을 구현자에게 위임. phase gate에서 재확인.
