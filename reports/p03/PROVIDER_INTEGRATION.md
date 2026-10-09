# P03 — 실제 provider 통합 상태 (PW-030)
작성: 2026-10-09 · 개발 컨테이너

이 문서는 무엇을 **실제로 실행했는지**와 **실행하지 않았는지**를 나눠 적는다. 실제 Claude·Codex 호출은 이 개발 환경에서 한 번도 하지 않았다.
- 사용자 로그인 profile, 비용·약관 승인, live 호출 허가가 없기 때문이다(CLAUDE.md, 세션 규칙).
- 그래서 아래 어느 줄도 v1에서 실제 provider를 쓸 준비가 끝났다는 뜻이 아니다.

## 상태 (기계 판독용 — `tests/tasks/PW-030/gate.test.ts`가 등록부와 대조한다)
```json
{
  "providers": [
    { "provider": "mock", "live": "executed", "what": "모의 provider로 선택 질문·교정·스트리밍·취소 전 과정. evidence는 실행 로그가 아니라 매번 실행되는 시험 파일이다(PW-020, PW-028 브라우저 시험)", "evidence": ["tests/tasks/PW-020/stream.e2e.ts", "tests/tasks/PW-028/runs.e2e.ts"] },
    { "provider": "claude_agent", "live": "not_run", "reason": "사용자 PC의 격리 로그인 profile과 live smoke 승인이 필요하다. 등록부 requires_verification", "stand_in": "tests/tasks/PW-024/claude.test.ts (대역 CLI)", "manual": "tests/tasks/PW-024/live-smoke.manual.ts" },
    { "provider": "codex", "live": "not_run", "reason": "사용자 PC의 로그인 profile, 바깥 sandbox 검증, live smoke 승인이 필요하다. app-server를 sandbox 안에서 띄우는 연결이 아직 없다. 등록부 requires_verification", "stand_in": "tests/integration/providers/codex-pipeline.int.test.ts (대역 app-server)", "manual": "tests/integration/providers/codex-live-smoke.manual.ts" }
  ],
  "open_items": [
    { "item": "providers_inside_sandbox", "status": "open", "why": "RFC-010: adapter가 Claude CLI·Codex app-server를 아직 sandbox 밖에서 띄운다. 등록부는 sandbox 안 live 증거(ran_inside_sandbox)가 있어야 승인한다" },
    { "item": "worker_provider_run_path", "status": "open", "why": "worker의 실제 provider run 경로(token 발급, superviseRun, 사용량 기록)가 아직 시험에서만 조합되어 있다(RFC-010)" },
    { "item": "paragraph_draft_from_outline", "status": "blocked", "why": "개요 기반 1문단 초안은 P05 PW-042(Writer)에서 만든다" }
  ],
  "v1_provider_integration_complete": false
}
```

## 실제로 실행한 것 (이 컨테이너, 대역 provider)
- 이 연쇄 시험의 한계
  - 승인된 등록부와 `sandbox: {verified: true}`는 시험이 만든 값이다.
  - 사용량 event key(`thread:job:순번`)는 adapter가 만들 형식이 아니다.
  - 수명 관리(`startRunProcess`/`superviseRun`)와 sandbox는 이 연쇄에 들어 있지 않다. 각각 PW-026·028 시험에서 따로 검증했다.
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
3. RFC-010(provider를 sandbox 안에서 실행)이 구현된 뒤, 그 안에서 실행한 결과가 `passed: true`이고 `ran_inside_sandbox: true`일 때만 등록부 행을 `approved`로 바꾸는 RFC를 올린다. 등록부는 sandbox 밖 증거로는 승인을 받지 않는다(검사 코드). 바꾸기 전에는 gate test가 위 표를 그대로 지킨다.
