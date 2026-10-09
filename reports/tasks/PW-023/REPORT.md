# PW-023 — Provider registry·이벤트 정규화 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `packages/providers/src/core/`(새 폴더)
  - `capabilities.ts`
    - 등록부 검증
      - provider·배포 형태·admission·7개 기능·상태 값 확인
      - mock이 아닌 provider의 approved는 사용자 머신의 live evidence가 필요하다. verified 기능도 같다.
    - `resolveCapability`: 등록부에 없는 버전·인증·배포 형태는 disabled이고 모든 기능은 unknown이다.
    - `displayState`
      - verified / unsupported / unknown 세 가지로 보인다.
      - "documented_not_verified"는 unknown에 "documented, not verified" 메모를 붙인다.
    - `capabilityMatrix`
    - `requireFeature`: verified가 아니면 `CapabilityUnavailable`를 던진다.
  - `registry.json`: P00 등록부(`spikes/provider-admission/registry.json`)를 제품 코드로 옮겼다. 내용은 같다.
  - `events.ts`: 원본 이벤트 → 정규화 이벤트
    - `normalizeClaude`: stream-json의 init, assistant 본문·도구 요청·usage, partial delta, rate_limit_event, result
    - `normalizeCodex`: thread/started, agentMessage delta·완료, tokenUsage, rateLimits, compacted, turn/completed, error
    - 보고되지 않은 값은 null이고 `unknown_fields`/`unknown_reason`에 남는다.
    - 재설정 시각은 ISO 8601만 받는다. 다른 형식은 해석하지 않고 원문으로 둔다.
    - 모르는 이벤트는 `unrecognized`로 남긴다.
  - `index.ts`
- `packages/contracts/src/provider/`(새 폴더)
  - `provider_event.schema.json`
    - kind별 data 구조를 정한다.
    - 재설정 시각이 없으면 이유가 필수다.
    - 퍼센트는 0–100, 토큰은 0 이상 정수다.
  - `index.ts`: 타입과 `validateProviderEvent`
- 범위 밖(RFC-009 부록)
  - `apps/api/src/providers/index.ts`: `GET /api/providers/capabilities`
    - 로그인 필요
    - 활성 provider와 MOCK 표시, 행렬을 보낸다. 근거 메모는 보내지 않는다.
  - `apps/api/src/server.ts`
  - `packages/providers/package.json`: `./core/index.ts` export
- 시험(`tests/tasks/PW-023/`)
  - `registry.test.ts` 6
  - `events.test.ts` 7
  - `capabilities.int.test.ts` 1

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-023-A / TST-023A provider/version/auth별 verified/unsupported/unknown 표시 | unit: 9개 행 × 7개 기능이 모두 세 상태 중 하나다. Claude 구독 로그인의 interrupt는 "unknown(documented, not verified)", compact는 unknown이다. mock만 usable, API key 행은 모두 disabled다 |
| | unit: 등록되지 않은 버전은 disabled에 모두 unknown이다 |
| | 통합: API가 로그인한 owner에게만 행렬을 보이고, 근거 메모(경로·토큰 이름)는 보내지 않는다 |
| REQ-023-B / TST-023B 지원되지 않는 compact/quota 필드를 있는 것으로 가정하지 않음 | unit: Claude의 compact·quota_read는 거부된다. Codex compact(문서에만 있음)도 거부된다 |
| | unit: rate_limit_event에 재설정 시각이 없으면 null+이유이고, epoch 숫자는 단위를 추측하지 않는다. usage가 없으면 0이 아니라 null이고 unknown_fields에 남는다. 범위 밖 퍼센트는 null이다 |
| | unit: 계약이 근거 없는 값(퍼센트 0에 "tomorrow" 시각, 모르는 kind)을 거부한다 |
| | unit: live evidence 없는 approved·verified 등록부는 거부한다 |

## RED → GREEN
- RED: 모듈과 route가 없어 실패했다(`red.log`).
- mutation(`mutation.log`): 10종 모두 탐지했다.
  - 문서만 있는 기능을 verified로 표시
  - 미등록 버전 승인
  - 문서만 있는 기능 사용
  - live evidence 없는 승인
  - 재설정 시각 지어냄
  - 빠진 usage를 0으로
  - epoch를 초로 추측
  - 범위 밖 퍼센트
  - 모르는 이벤트를 본문으로 해석
  - API에 근거 메모 노출
- GREEN: unit 13, 통합 1.
- 회귀
  - `pnpm test` exit 0(`pnpm-test.log`, PW-022 리뷰 반영과 함께 실행)
    - unit 193, integration 196, contracts 15, e2e 77, spikes 70
  - 처음 실행에서 `runtime-load` 시험(PW-014)이 결함 1건을 찾아 고쳤다.
    - TypeScript 생성자 매개변수 속성은 `node --experimental-strip-types`(개발 실행)에서 동작하지 않는다.
    - `CapabilityUnavailable`을 일반 필드로 바꿨다.

## 보안·과학적 실패 경로
- 실제 provider는 여전히 "requires_verification"이다. live evidence가 없으면 등록부 검증이 승인·verified를 거부한다. 파일을 고쳐 approved로 바꾸면 서버가 시작할 때 실패한다.
- 정규화는 값을 만들지 않는다(constitution "관측 불가한 usage·context·reset 시간은 UNKNOWN").
- 도구 요청은 `tool_requested`로 전달될 뿐이다. 실행 여부는 PW-027 gateway가 정한다.

## 미실행 / 남은 위험
- **필드 경로 검증 수준이 다르다.**
  - Claude: init → assistant → rate_limit_event → result 순서만 P00에서 실측했다.
  - Codex: 생성된 schema의 이름을 문서 기준으로 맞췄다.
  - 실제 출력과 다르면 해당 값은 null/unrecognized로 떨어진다(안전한 쪽). 실측은 PW-030(사용자 PC).
- **Codex 생성 schema 원본은 저장소에 없다(hash만 있음).** 필드 경로를 schema로 자동 대조하는 시험은 사용자 PC에서 schema를 생성할 때 추가한다(PW-025).
- **capability 화면(UI)은 아직 없다.** API로 제공하고, 설정 화면은 PW-030 gate에서 함께 만든다.

## 다음
PW-024: Claude Agent adapter

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(minor 3, nit 2). MAJOR 없음.
- 문제없다고 확인된 것
  - 문서만 있는 기능이 verified로 표시되거나 쓰이는 경로가 없다.
  - 정규화가 값을 지어내지 않는다.
  - API가 근거 메모를 보내지 않는다.
  - strip-types 실행에서 JSON import가 동작한다.

| 지적 | 조치 |
|---|---|
| minor-1 등록부 검사가 v1 정책을 강제하지 않고, live_evidence는 아무 값이나 받음 | 구조화된 live evidence를 요구한다: `checked_at`, `cli_version`(행 버전과 같아야 함), `host`, `tests[]`, `passed: true`. `MULTIUSER_HOSTED`·`api_key` 행은 disabled만 허용한다. 같은 키가 두 번 나오면 거부한다. unit 시험 3개 |
| minor-2 Claude 사용량에 캐시된 입력이 빠져 context 사용량이 거의 0으로 보임. message/turn 사용량이 구분되지 않음 | 입력 크기 = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`. 캐시 필드가 알 수 없는 형식이면 입력은 unknown이다. usage 이벤트에 `scope`(message·turn·session)를 더했다. unit 시험 |
| minor-3 계약이 null 필드와 `unknown_fields`를 묶지 않음 | 각 필드가 null이면 `unknown_fields`에 있어야 하고, 아니면 없어야 한다(if/then/else). unit 시험 |
| nit 활성 provider 행을 id만으로 찾음 | 서버의 전체 키(mock: `spike`/`none`/`PERSONAL_LOCAL`)로 `resolveCapability`한다 |
| nit 통합 시험이 근거 미노출을 넓게만 봄 | 행에 `evidence` 필드가 없음을 확인한다. 로그인 요구(401)는 이미 시험한다 |

- mutation(`mutation-review.log`): 6종 모두 탐지했다.
- 실행
  - PW-023: unit 19, 통합 1
  - `pnpm test` exit 0(PW-024와 함께 실행, `reports/tasks/PW-024/pnpm-test.log`)
