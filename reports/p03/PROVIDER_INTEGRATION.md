# P03 — 실제 provider 통합 상태 (PW-030)
작성: 2026-10-09 · 개발 컨테이너

이 문서는 무엇을 **실제로 실행했는지**와 **실행하지 않았는지**를 나눠 적는다. 실제 Claude·Codex 호출은 이 개발 환경에서 한 번도 하지 않았다.
- 사용자 로그인 profile, 비용·약관 승인, live 호출 허가가 없기 때문이다(CLAUDE.md, 세션 규칙).
- 그래서 아래 어느 줄도 "v1 전체 연동 완료"를 뜻하지 않는다.

## 상태 (기계 판독용 — `tests/tasks/PW-030/gate.test.ts`가 등록부와 대조한다)
```json
{
  "providers": [
    { "provider": "mock", "live": "executed", "what": "모의 provider로 선택 질문·교정·스트리밍·취소 전 과정(PW-020, PW-028 브라우저 시험)", "evidence": ["tests/tasks/PW-020/stream.e2e.ts", "tests/tasks/PW-028/runs.e2e.ts"] },
    { "provider": "claude_agent", "live": "not_run", "reason": "사용자 PC의 격리 로그인 profile과 live smoke 승인이 필요하다. 등록부 requires_verification", "stand_in": "tests/tasks/PW-024/claude.test.ts (대역 CLI)", "manual": "tests/tasks/PW-024/live-smoke.manual.ts" },
    { "provider": "codex", "live": "not_run", "reason": "사용자 PC의 로그인 profile, 바깥 sandbox 검증, live smoke 승인이 필요하다. app-server를 sandbox 안에서 띄우는 연결이 아직 없다. 등록부 requires_verification", "stand_in": "tests/integration/providers/codex-pipeline.int.test.ts (대역 app-server)", "manual": "tests/integration/providers/codex-live-smoke.manual.ts" }
  ],
  "v1_provider_integration_complete": false
}
```

## 실제로 실행한 것 (이 컨테이너, 대역 provider)
`tests/integration/providers/codex-pipeline.int.test.ts`, 통합 3개.
- 연결 순서(worker가 할 일을 시험에서 조합)
  1. 작업을 claim한다.
  2. 그 run에 묶인 token을 발급한다(PW-027/028).
  3. 승인 결정 아래에서 Codex adapter를 시작한다(PW-025).
  4. 모델의 도구 호출이 gateway를 거쳐 PENDING proposal이 된다(PW-017/027).
  5. 누적 사용량 보고가 ledger에 delta로 남는다(PW-029).
  6. fencing token으로 작업을 완료한다. 완료 뒤 token은 죽는다.
- turn 중간 중지: 취소가 저장되고, turn은 interrupt된다. 늦은 도구 호출은 `invalid_token`, 늦은 완료는 "lease lost"다. proposal은 늘지 않는다.
- 재개: 저장된 thread id로만 재개한다. 모르는 id는 거부한다.
- 대역 provider로 이미 검증된 것
  - Claude CLI 대역: 명시적 session, 고정 플래그, 취소(PW-024)
  - Linux sandbox 실제 실행: unshare backend, 사설 network와 egress proxy(PW-026)
  - 프로세스 수명: interrupt → 그 run의 group만 종료, 재시작 정리(PW-028)
  - 사용량·한도 표시(PW-029)

## 실행하지 않은 것과 이유
| 항목 | 상태 | 이유 / 필요한 것 |
|---|---|---|
| Claude Code live smoke (TST-024A) | not_run | 사용자 PC: 격리 profile 로그인, sentinel 확인, `--approve-live-smoke` |
| Codex app-server live smoke | not_run | 사용자 PC: 로그인 profile, `verifyOuterSandbox` 통과, `--approve-live-smoke`. decline 응답 형식, `thread/start`·`turn/start` 매개변수, `item/tool/call` 형식 실측 |
| Codex app-server를 sandbox 안에서 실행 | **미구현** | adapter가 지금은 sandbox 밖에서 app-server를 띄운다. gate는 sandbox가 "이 host에서 동작함"을 확인할 뿐이다. `runSandboxed(network: 'proxy')`로 감싸는 연결은 RFC-010(제안)으로 분리한다. 그 전에는 Codex를 승인하지 않는다 |
| Claude CLI를 sandbox 안에서 실행 | **미구현** | 위와 같다(RFC-010) |
| MCP bridge를 실제 Claude CLI가 쓰는 동작 | not_run | live smoke에서 확인 |
| CLI의 `HTTPS_PROXY` 준수 | not_run | live smoke에서 확인 |
| bubblewrap backend 실행 | not_run | 이 컨테이너에 bwrap이 없다 |
| 개요 기반 1문단 초안 | blocked | 문단 초안(Writer)은 P05 PW-042에서 만든다. P03에는 부분 수정(선택 교정)만 있다 |
| worker의 실제 provider run 경로 | 미연결 | 지금 run 경로는 모의 provider(프로세스 안)다. 실제 provider 연결은 P05 Writer와 RFC-010에서 한다 |

## 사용자 PC에서 할 일 (수동, 비용 발생)
1. Claude: `tests/tasks/PW-024/live-smoke.manual.ts` 머리말의 순서대로 진행한다. 결과 JSON을 `reports/tasks/PW-024/live-evidence.json`에 저장한다.
2. Codex: `tests/integration/providers/codex-live-smoke.manual.ts` 머리말의 순서대로 진행한다. 결과 JSON을 `reports/p03/evidence/codex-live.json`에 저장한다.
3. 두 결과가 `passed: true`일 때만 등록부 행을 `approved`로 바꾸는 RFC를 올린다. 바꾸기 전에는 gate test가 위 표를 그대로 지킨다.
