# P03 Gate — provider adapter·격리·gateway·수명·사용량 (PW-023 ~ PW-030)
작성: 2026-10-09 · 상태: **사용자 위임에 따라 진행 — 실제 provider 사용은 아직 승인하지 않음**

## 사용자 결정
- 사용자 지시(2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라". 이 gate의 결정은 위임에 따라 권장안으로 기록한다. 사용자는 언제든 되돌릴 수 있다.
- 위임으로 정한 항목
  1. RFC-009(P03 write scope 연결 파일) 채택. Task별 부록에 모두 기록했다.
  2. RFC-010(실제 provider를 sandbox 안에서 실행 + worker run 경로 연결) 채택. 구현은 P05 Writer(PW-042) 전에 한다.
     - **보안 경계를 바꾸는 결정이라 사용자 확인 대상으로 표시한다.**
  3. 실제 Claude Code·Codex는 이 컨테이너에서 not_run이다.
     - 등록부는 두 provider 모두 requires_verification으로 유지한다.
     - sandbox 안에서 실행한 live 증거(`ran_inside_sandbox: true`) 없이는 승인되지 않는다(검사 코드).
  4. OpenAlex는 사용조건을 확인할 수 없어 넣지 않는다(P04 PW-031).
- **P03 완료. P04(PW-031부터) 진행.** PW-031은 이미 in_review다.

## 사용자가 직접 해야 하는 일 (위임할 수 없음)
- 사용자 PC에서 live smoke를 실행한다(비용·약관은 사용자 계정).
  - Claude: `tests/tasks/PW-024/live-smoke.manual.ts`
  - Codex: `tests/integration/providers/codex-live-smoke.manual.ts`
  - 결과는 RFC-010 구현 뒤 sandbox 안 실행으로 다시 받는다.
- 등록부 승인 RFC는 사용자가 결정한다.

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-023 | provider 등록부·이벤트 정규화(provider_event v1) | unit 19, 통합 1 | approve(minor 반영) |
| PW-024 | Claude Code CLI adapter(명시 session, 고정 플래그, 승인 gate) | unit 24, 통합 2 | 리뷰·재리뷰 approve |
| PW-025 | Codex app-server adapter(사적 stdio, RPC 허용 목록, turn 하나씩·정리) | unit 29 | 리뷰·재리뷰 approve |
| PW-026 | run 폴더 + Linux sandbox(unshare/bwrap, pivot_root, capability 제거, 사설 network + egress proxy) | unit 19 | 리뷰(MAJOR: abstract socket)·재리뷰 approve |
| PW-027 | typed tool gateway(run token 범위, 닫힌 schema, 감사, socket·MCP bridge) | 통합 13, 계약 2 | 리뷰 approve(minor 반영) |
| PW-028 | 중지·interrupt·좁은 종료·재시작 정리·재연결 화면 | 통합 12, unit 2, 브라우저 2 | 리뷰(MAJOR: 취소 뒤 gateway 제안)·재리뷰 approve |
| PW-029 | 사용량 ledger·한도 관측(범위 분리, 지어내지 않음) | 통합 8, unit 2, 브라우저 1 | 리뷰(MAJOR: 문맥=turn 합계)·재리뷰 approve |
| PW-030 | 통합 gate(대역 연쇄, 실행/미실행 보고, 수동 live smoke) | unit 5, 통합 4 | 리뷰(minor 4) 반영, 재리뷰 대기 |

최종 회귀 `pnpm test` exit 0: unit 278, integration 251, contracts 17, e2e 80, spikes·evals·pack PASS.

## 다음 phase로 넘기는 위험 (확인만)
- **실제 provider 동작은 미검증이다.** Claude CLI, Codex app-server, MCP bridge, `HTTPS_PROXY` 준수, Codex 응답 형식 모두 대역 기준이다.
- **adapter가 아직 sandbox 밖에서 provider를 띄운다(RFC-010).** 그 전에는 실제 사용을 승인하지 않는다.
- **worker의 실제 provider run 경로가 없다.** gateway·수명·사용량은 시험에서만 조합되어 있다(RFC-010).
- bubblewrap backend는 실행하지 않았다(컨테이너에 없음).
- 커널 취약점, 같은 사용자 계정의 할당량·자원은 완전히 격리되지 않는다(CLAUDE.md).
- PW-015 브라우저 시험이 전체 실행에서 한 번 실패했다. 18회 반복으로도 재현하지 못했다. 원인은 미확인이다.
- **P01·P02에서 넘어온 항목은 아직 열려 있다.** 실제 IME, Firefox/Safari, 배포.
