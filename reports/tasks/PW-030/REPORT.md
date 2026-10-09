# PW-030 — 실제 provider 통합 gate — REPORT
상태: in_review (2026-10-09)

## 결론
- 실제 Claude Code·Codex 호출은 **실행하지 않았다(not_run).** 사용자 로그인 profile, 비용·약관 승인, live 호출 허가가 이 환경에 없다.
- 대신 P03의 부품을 실제 순서로 조합한 연쇄 시험을 대역 Codex로 실행했다.
- 상태와 이유는 `reports/p03/PROVIDER_INTEGRATION.md`에 사람용 표와 기계 판독 블록으로 적었다.
- gate 시험은 그 블록을 등록부와 대조한다. 승인과 live 증거가 없는 provider를 "실행"이나 "v1 연동 완료"로 적으면 실패한다.

## 변경 파일
- `tests/integration/providers/`
  - `fake-codex-gateway.mjs`: PW-025 대역에 두 가지를 더했다. profile의 `tool-call.json`대로 도구를 호출하고, 누적 사용량을 보고한다.
  - `codex-pipeline.int.test.ts`(통합 3)
    - 연쇄: 작업 claim → run token(job fencing에 묶임) → 승인 결정 아래 Codex adapter → 도구 호출이 gateway를 거쳐 PENDING proposal → 누적 사용량이 ledger delta → 완료 → token 소멸
    - turn 중 중지: 취소 저장, interrupt, 늦은 도구 호출은 `invalid_token`, 늦은 완료는 "lease lost", proposal 증가 없음
    - 저장된 thread id로만 재개
  - `codex-live-smoke.manual.ts`: 사용자 PC용 수동 live smoke. 바깥 sandbox 검증 → 등록부 gate → 1 turn → 증거 JSON. `pnpm test`에 들어가지 않는다.
- `tests/tasks/PW-030/gate.test.ts`(unit 5): 보고서 블록과 등록부를 대조한다.
- `reports/p03/PROVIDER_INTEGRATION.md`
- `docs/adr/rfc/RFC-010-providers-inside-sandbox.md`(위임 채택, 구현은 P05 Writer 전): 실제 provider를 sandbox 안에서 실행하고, worker run 경로에 gateway·수명 관리·사용량 기록을 붙인다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-030-A / TST-030A 실제 실행한 provider와 미실행 adapter를 구분한 보고서 | gate: provider마다 한 줄이다(`executed`·`not_run`·`blocked`). executed는 존재하는 증거 파일을 가리킨다. not_run은 이유와 수동 실행 스크립트를 가리킨다 |
| REQ-030-B / TST-030B 미승인 상태를 통과·완료로 기록하지 않음 | gate: 등록부가 승인하지 않은 실제 provider는 executed가 될 수 없다. `v1_provider_integration_complete`는 모든 실제 provider가 승인될 때만 true다. 본문에 완료 주장이 없다. 지금 등록부는 실제 provider를 하나도 승인하지 않았다 |
| 목적(종단 검증) | 대역 Codex 연쇄 통합 3 — 부분 수정 제안, 중단, 재개. 개요 기반 1문단 초안은 P05 PW-042 전이라 blocked |

## RED → GREEN
- RED: 정직하지 않은 보고서와 등록부 7종을 만들어 gate가 거부하는지 확인했다(`red.log`=`mutation.log`, 7종 모두 탐지).
  - Codex·Claude를 executed로 표시
  - v1 완료 주장
  - 본문 완료 문구
  - 증거 없는 executed
  - 이유 없는 not_run
  - 등록부 무단 승인
- GREEN: gate unit 5, 연쇄 통합 3.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 278, integration 233, contracts 17, e2e 80, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- 이 gate는 "통과"를 만들어 내지 않는다. 실제 provider 승인은 사용자 PC의 live 증거와 등록부 RFC로만 바뀐다.
- 연쇄 시험에서도 AI는 proposal만 만든다. 문서 head는 그대로이고, 적용은 사용자가 한다.

## 미실행 / 남은 위험
- Claude·Codex live smoke: not_run(수동 스크립트 제공).
- **adapter는 아직 sandbox 밖에서 provider를 띄운다.** RFC-010을 구현하기 전에는 실제 사용을 승인하지 않는다.
- worker의 실제 provider run 경로가 없다(지금은 모의 provider). RFC-010과 P05 Writer에서 연결한다.
- MCP bridge, `HTTPS_PROXY` 준수, Codex 응답 형식은 실측 전이다.
- 개요 기반 1문단 초안: blocked(P05).

## 다음
P03 gate 보고서(리뷰 반영 뒤) → P04 PW-031
