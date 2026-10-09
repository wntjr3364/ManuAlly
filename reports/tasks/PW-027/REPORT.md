# PW-027 — Typed tool gateway·scope — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_027_0001_tool_gateway.sql`
  - `agent_run_tokens`
    - run 하나의 범위: 소유자, 논문, 문서, 수정 가능한 selection handle, 쓸 수 있는 도구, provider, 만료.
    - token의 SHA-256만 저장한다.
    - 행은 폐기(`revoked_at`)만 바꿀 수 있고, 나머지는 trigger가 막는다.
    - (논문, 문서)는 복합 FK로 묶는다.
  - `agent_tool_calls`: 호출마다 token, 도구 이름, 결과(ok/refused/error), 사유, 인자의 SHA-256. 인자 자체는 저장하지 않는다(원고 문장이 들어 있을 수 있음). 행은 바꿀 수 없다.
- `packages/domain/src/tool-policy/`
  - `schema.ts`: 닫힌 JSON-schema 부분집합 검증기. 새 의존성을 피했다. 모든 object는 `additionalProperties: false`이고, 모르는 schema 형식은 실패한다.
  - `index.ts`
    - 도구
      - 읽기: `get_approved_outline`, `get_document_slice`(run의 selection 또는 run 문서의 문단 하나), `get_fact_records`(사용자가 VERIFIED로 확인한 사실만), `get_reference_excerpt`(저장된 메타데이터. 발췌는 P04 전까지 null), `get_figure_metadata`(현재 번호)
      - 제안: `propose_manuscript_edit` → PW-017 `createProposal`. 결과는 PENDING proposal뿐이고, 적용은 사용자가 한다.
    - `FORBIDDEN_TOOLS`: 승인, 적용, 사실 검증, 소유자 변경, snapshot 삭제, 예산 변경, 제출, http, shell, 파일 읽기·쓰기. 도구로 존재하지 않는다.
    - `LATER_TOOLS`: 문헌 검색(PW-031/037), 개요 제안(PW-040), profile 제안(PW-041), 후보 문헌(PW-033), 검토 의견(PW-044). 이름은 알지만 `not_available_yet`으로 답한다.
    - `issueRunToken`
      - 32바이트 무작위 token을 만든다.
      - 확인: 소유자의 논문, 그 논문의 문서, 그 문서의 handle, 알려진 도구, TTL 24시간 이하.
    - `revokeRunToken`
    - `toolDefinitions`: token이 허용한 도구와 공개 schema.
    - `callTool` 검사 순서: token → 금지 → 나중 → 모름 → token 허용 목록 → 인자 크기(64 KiB) → schema → 실행. 범위는 실행 중에 token에서만 가져온다.
    - 감사 기록에서는 제어·zero-width·bidi 문자를 `?`로 보여 준다.
- `apps/api/src/agent-tools/`
  - `index.ts`: `serveToolSocket`
    - run 폴더 안의 Unix socket(0600)이고, run token에 묶인다. token은 sandbox에 들어가지 않는다.
    - 줄 단위 JSON으로 `tools/list`, `tools/call`을 받는다.
    - 한 줄은 256 KiB 이하다. 줄바꿈 없는 대량 입력도 끊는다.
    - 동시 연결은 8개, 답은 요청 순서대로 보낸다.
    - `close()`는 socket이 바뀌어 있어도 예외를 던지지 않는다(PW-026 재리뷰와 같은 처리).
  - `mcp-bridge.mjs`
    - Claude Code용 MCP stdio 서버다: `initialize`, `ping`, `tools/list`, `tools/call`. 나머지(resources, prompts, sampling)는 -32601.
    - 도구 호출을 gateway socket으로 넘기기만 하고, 판단은 하지 않는다.
- 시험
  - `tests/tasks/PW-027/gateway.int.test.ts`(통합 11)
  - `tests/tasks/PW-027/schemas.contract.test.ts`(contract 2): 공개 schema가 ajv strict에서 compile되고 닫혀 있다. gateway 검증기와 ajv가 표본 30개에서 같은 판정을 낸다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-027-A / TST-027A 허용된 개요·문단·증거 조회와 proposal만 생성 | 읽기 도구는 이 논문의 승인된 개요, run selection의 글자, run 문서의 문단, VERIFIED 사실만(후보 값 9.9는 나오지 않음), 참고문헌 메타데이터, 그림 번호를 돌려준다 |
| | `propose_manuscript_edit`는 PENDING proposal(origin `worker:tool-gateway:codex`)을 만든다. 문서 head는 바뀌지 않는다 |
| | run이 보는 도구 목록은 허용된 도구뿐이고, 모든 schema가 닫혀 있으며, 금지 도구는 없다 |
| REQ-027-B / TST-027B paper_id·approved_by·tool 이름을 바꿔도 다른 논문·정본 적용·승인을 얻지 못함 | 인자에 `paper_id`, `approved_by`, `owner_id`, `document_id`, `status`, `apply`를 넣으면 `invalid_arguments`이고, proposal 수가 그대로다 |
| | 다른 논문의 handle·문단·참고문헌·사실 id로는 아무것도 나오지 않는다(BOB-SECRET 비노출). 같은 논문이라도 run에 주지 않은 handle은 `not_in_scope`다(읽기·제안 모두) |
| | 금지 이름 14개, 대소문자·공백·zero-width 변형, `__proto__`, `constructor`, 모르는 이름은 거부한다. token에 없는 도구는 `tool_not_allowed`다 |
| | token: 모름·만료·폐기는 `invalid_token`이다. DB에 평문이 없다. 남의 논문, 다른 논문의 handle, 금지 도구, 24시간 초과 TTL로는 발급되지 않는다 |
| | 모든 호출은 감사 기록에 남고(인자는 hash만), 감사 기록은 바꿀 수 없다 |
| | 나중 Task의 도구는 `not_available_yet`이다 |
| | 전송: socket은 token 없이 run 도구만 제공한다. JSON이 아닌 입력, 금지 도구, 256 KiB 초과, 줄바꿈 없는 대량 입력은 거부한다. MCP bridge는 initialize·tools/list·tools/call에 답하고, 거부는 `isError: true`, 모르는 메서드는 -32601이다 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- GREEN: 통합 11, contract 2.
- mutation(`mutation.log`): 18번 실행했다. 처음에 2종이 살아남았다(시험 공백).
  - proposal의 handle 범위 검사 제거: 다른 논문 handle로만 시험해서, 범위 검사 없이도 handle 조회가 실패했다. → 같은 논문이지만 run에 주지 않은 handle로 시험을 더했다.
  - socket 크기 제한 제거: 한 줄 검사가 같은 경우를 막았다. → 줄바꿈 없는 대량 입력 시험을 더했다.
  - 다시 돌려 둘 다 탐지했다. 최종 16종 모두 탐지.
- lint가 감사용 제어 문자 정규식을 거부했다(no-control-regex). → code point 함수로 바꿨다.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 269, integration 209, contracts 17, e2e 77, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- **권한은 token만 정한다.** 모델이 보낸 id는 token 범위 안에서 찾는 열쇠일 뿐이다. 범위 밖이면 "없음"과 같은 답이고, 다른 논문의 존재 여부를 알려 주지 않는다.
- **정본 변경 경로가 없다.** 쓰기 도구는 proposal을 만들 뿐이다. 적용·승인·사실 검증은 사용자의 브라우저 요청(PW-017/010/011)으로만 한다.
- **모델이 숫자를 사실로 만들 수 없다.** 사실 조회는 사용자가 VERIFIED로 확인한 값만 준다. proposal의 숫자 변경은 PW-017 검사(guard)가 막는다.
- **injection:** 문헌·원고 속 문장은 데이터로 돌려줄 뿐이다. 그 안의 "approve_outline을 불러라" 같은 지시는 위의 금지·schema·scope 검사를 그대로 통과하지 못한다(별도 합성 fixture는 PW-045 rubric에서 다룬다).

## 미실행 / 남은 위험
- **실제 Claude CLI가 MCP bridge를 쓰는 동작: not_run**(live 금지). MCP 메시지 형식은 공개 명세 기준이다(documented_not_verified). 실측은 PW-030에서 한다.
- **Codex의 `item/tool/call` 형식(`tool`, `arguments`)도 가정이다.** worker에서 `callTool`로 잇는 일과 실측은 PW-028/030에서 한다.
- **worker 연결(run마다 token 발급 → socket 시작 → `--mcp-config`/onToolCall → 끝나면 폐기)은 아직 없다.** 이 Task는 gateway와 전송만 만든다. 실제 run 경로는 PW-028(취소·재연결)과 PW-030(통합 gate)에서 붙인다.
- 같은 token을 가진 run 안의 모든 프로세스는 같은 범위를 쓴다(run 단위 격리). 여러 run 사이의 격리는 run마다 token과 socket을 따로 두는 것으로 지킨다.
- 도구 결과 크기: 문단 20,000자, 사실 200개, 참고문헌 20개로 자른다. 개요 노드 수는 개요 자체의 제한을 따른다.

## 다음
PW-028: Interrupt·취소·재연결
