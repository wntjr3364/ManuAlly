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
  - `codex-pipeline.int.test.ts`(통합 4, 리뷰 반영 후)
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

## 독립 리뷰 반영 (2026-10-09)
리뷰 결론: 변경 요청. MAJOR 없음, minor 4·nit 4. 보고서의 정직성("adapter가 sandbox 밖에서 실행")은 확인됨.
- MINOR-1: gate가 수동 스크립트 없는 not_run 줄을 통과시켰다(`path.resolve('')`는 항상 존재). 증거 경로도 저장소 밖(`/etc/hostname`)을 받았다.
  - 고침: 인용 경로는 저장소의 `tests/`나 `reports/` 아래 상대 경로이고, 실제 파일이어야 한다.
- MINOR-2: 두 provider가 승인되면 "완료"를 강제했다. 초안 기능이 blocked이고 RFC-010이 미구현이어도 마찬가지였다. 본문 검사 단어 목록도 좁았다.
  - 고침: 블록에 `open_items`(sandbox 안 실행, worker 연결, 개요 기반 초안)를 두었다. 완료는 모든 provider 승인 + 모든 항목 done일 때만 허용한다. 본문 검사는 "연동·통합·integration" 근처의 "완료·끝났·complete·done"을 넓게 찾는다.
- MINOR-3: live smoke 증거에 `sandbox.verified: true`가 남아, sandbox 안에서 실행한 것처럼 보였다. 그 증거로 Codex를 승인하는 것도 막는 코드가 없었다.
  - 고침
    - 증거에 `ran_inside_sandbox: false`와 `host_sandbox_checked`를 남긴다. 머리말을 바로잡았다.
    - 등록부가 실제 provider(Claude·Codex)를 승인하려면 live 증거에 `ran_inside_sandbox: true`가 있어야 한다(`liveEvidenceOk`, 범위 밖 수정은 RFC-009 부록). PW-023 시험에 거부 사례를 더했다.
    - 보고서 3단계에 RFC-010 전제를 적었다.
- MINOR-4: 연쇄 시험이 취소 경로를 대충 다뤘다.
  - interrupt 전송을 `seen.json`으로 확인한다.
  - 주석을 바로잡았다(도구 호출은 중지와 비슷한 때 도착한다. 어느 쪽이 먼저든 취소 뒤에는 아무것도 생기지 않는다).
  - 시험 머리말에 supervisor·sandbox가 빠졌다고 적었다.
  - "취소 전에 만든 제안" 시험을 더했다: 제안은 PENDING으로 남고, 작업은 CANCELLED, 완료는 거부, 문서는 그대로다.
  - 이 경우 "취소됨 — 결과 없음"은 틀린 말이다. 실행 화면 문구를 "취소됨 — 취소 뒤 결과는 반영되지 않음"으로 바꿨다(PW-028 파일).
- nit
  - RFC-010: "auth profile 사본"을 "전용 격리 profile bind, 자격증명 복사 금지"로 고쳤다. 로그인 갱신 host와 bwrap 종료 시험을 더했다. 상태는 "P03 gate에서 사용자 확인 대상"으로 표시했다.
  - 보고서에 연쇄 시험의 한계(시험이 만든 등록부·sandbox 값, event key 형식)를 적었다.
  - mock 줄의 증거가 시험 파일이라고 적었다.
- 증거: `mutation.log` 아래쪽 8종 탐지(수동 스크립트 누락, 저장소 밖 증거, 미결 항목이 있는데 완료 주장, 본문 "통합 완료"·"integration done", 등록부의 실행 위치 무시, 취소 문구, interrupt 미전송).

## 다음
P03 gate 보고서 → P04 PW-032
