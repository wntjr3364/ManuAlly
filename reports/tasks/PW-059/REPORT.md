# PW-059 — Security release audit — REPORT
상태: in_review (2026-10-10) — 독립 리뷰 1차 changes requested(MAJOR 1, MINOR 5, NIT 3) → 반영. 재리뷰 changes requested(MAJOR 1, MINOR 1) → 반영. 3차 리뷰 **approve**(NIT 2 → 문서 반영)

보안 감사 보고서는 `reports/security/RELEASE_AUDIT.md`, 게이트 기록은 `reports/security/audit.json`이다.
게이트 결정은 `reports/security/audit.json`에 있다. 수동 확인 2건이 남아 있으므로 `pending_manual`이 기대값이다.

## 무엇을 했나
- **전 route sweep**(`tests/security/sweep.int.test.ts`, `routes.ts`, `world.ts`)
  - route는 서버 자신의 route table에서 읽는다(152개). 논문 route 수가 서버의 paper-scoped 목록과 일치하는지도 본다.
  - 두 사용자가 29종 기록을 가진 논문을 만든다. 모든 글에 사용자별 canary를 넣는다.
  - 점검: 세션 없음 401, CSRF·Origin 403, 다른 사용자 논문 404, 자기 논문에 다른 사용자 id(경로·본문·변형).
  - 판정: 유출, 변경, 교차 참조, 500이 없어야 한다.
- **정적 점검**(`static.test.ts`): 비밀 문자열·키 파일, 네트워크 모듈·fetch 사용처, 자식 프로세스 사용처와 환경 명시, 자격증명 파일 처리, 브라우저 저장소. 모두 검토된 목록과 이유가 있고, 새 사용처는 실패한다.
- **egress**(`egress.test.ts`): URL·주소 거부 53+3개, DNS rebinding.
- **prompt injection**(`injection.int.test.ts`): 심은 지시를 따르는 모델 시나리오. 도구 이름 점검.
- **공급망**(`supply-chain.test.ts`): `pnpm licenses`로 운영 의존성 라이선스 허용 목록, 버전 지정 규칙, lockfile
- **F-01 수정**(`credentials.test.ts`, RED → GREEN): 로그인 프로필 검사
- **release gate**(`gate.ts`, `gate.test.ts`, `run-audit.ts`): 시험 실행기 결과로 영역 상태를 만든다. findings 등록부는 `reports/security/findings.json`이다. 결정은 allowed / pending_manual / refused 셋이다.

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-059-A / TST-059A(최소권한·비밀 가림·명시 외부전송 정책 부정 시험과 보고서) | sweep(인증·CSRF·IDOR), static(비밀·egress·spawn env·자격증명·저장소), egress, injection, credentials(F-01), supply-chain, 기존 PW-008·026·027·034·035·052·055·057 묶음; 보고서 `reports/security/RELEASE_AUDIT.md` | 통과(`audit-run.log`) |
| REQ-059-B / TST-059B(critical leak·IDOR·host 접근이 남았거나 시험 미실행을 숨기면 release 거절) | `gate.test.ts`: open critical·high, AI의 위험 수용, 근거 없는 fixed, 실패·미실행·누락·0개·skip 영역, 수동 미확인, 형식 오류. `run-audit.ts`는 실행기 결과만 쓴다. | 통과. 실제 결정 `pending_manual`(exit 2) |

## RED → GREEN
- F-01: `red-F01.log`(2 실패) → 수정 → 통과
- sweep: 처음 실행부터 통과했다. 그래서 IDOR를 심어 시험이 무는 것을 보였다(아래 mutation).
- gate·static·egress·injection·supply-chain은 구현과 함께 썼다. 각 규칙은 mutation으로 확인했다.

## Mutation(`mutation.log`)
- IDOR와 인증 심기
  - export 파일·제출판·리뷰 의견 조회의 논문 필터 제거, 본문 id의 논문 범위 제거, owner check 우회, CSRF 제거
  - 6종 중 5종을 잡았다. 리뷰 의견 조회는 본문 변형을 넣은 뒤 잡혔다(FK가 막아 500으로 드러남).
- 게이트 규칙 7종, F-01, egress 2종(IP 리터럴은 목록 시험 보강 뒤), 정적 점검 심기 4종(API의 fetch, env 없는 spawn, 서버 env 전달, 자격증명 읽기): 모두 잡았다.

## 변경 파일
- write scope
  - `tests/security/{routes.ts, world.ts, sweep.int.test.ts, static.test.ts, egress.test.ts, injection.int.test.ts, credentials.test.ts, supply-chain.test.ts, gate.ts, gate.test.ts, run-audit.ts}`
  - `reports/security/{RELEASE_AUDIT.md, findings.json, audit.json}`
  - `reports/tasks/PW-059/**`
- 범위 밖(RFC-014 부록 PW-059)
  - `apps/worker/src/provider-runs/index.ts`(F-01·F-03·n2)
  - `infra/sandbox/sandbox.ts`(F-04)
  - `tests/rfc/RFC-010/provider-runs.int.test.ts`(허용 공급자 명시)
- 추가 시험: `tests/security/{schema.int.test.ts, send-policy.int.test.ts}`, `reports/security/manual-checks.json`

## 보안·과학 경계
- 게이트는 skip이나 미실행을 통과로 치지 않는다.
- 위험 수용은 사용자만 한다.
- 수동 확인은 근거 없이 통과시키지 않는다.

## 미검증·남은 위험
- 수동 2건(실제 CLI sandbox, 배포 TLS·헤더)은 사용자 기계에서 해야 한다.
- F-02(low, 헤더)는 PW-061에서 다룬다.
- sweep은 각 route의 첫 검증을 넘는 깊이가 제한적이다. 깊은 경로는 각 Task 시험이 맡는다(SEC 묶음에 포함).
- 브라우저 XSS 자동 탐색, 경합 공격, 외부 침투 시험은 하지 않았다.

## 독립 리뷰 1차(changes requested) — 반영
- **M1**: sweep이 닿지 않는 route를 통과로 셌다.
  - fixture가 모든 경로 매개변수 종류를 만든다(PDF anchor, story alternative, curation assessment, figure flag 추가). 두 사용자 모두 각 종류의 기록이 없으면 실패한다.
  - query string id(`asset_id`, `block_id`, `document_id`, `reference_id`)도 보낸다. 대조군이 candidates route의 빈틈을 찾아냈다.
  - positive control
    - 읽기 route 62개가 모두 소유자에게 2xx로 답한다(예외 1개는 이유 기록).
    - 바꾸기 route는 sweep이 닿는 17개와 닿지 않는 63개를 `sweep-stats.json`에 나눠 기록한다. 감사 보고서에 그대로 적었다.
  - 닿지 않는 본문 깊이는 둘로 덮는다.
    - 구조 시험(`schema.int.test.ts`): 논문 범위 외래 키 113개 중 88개에 `paper_id`가 있다. 25개 예외는 이유가 검토되어 있고 목록이 정확해야 한다.
    - 요청이 주는 비복합 참조 6종의 표적 시험: 상대 id → 4xx, 자기 id → 2xx 또는 gate 409, 남은 id 없음.
- **m1**
  - 답에 상대 id가 있으면 실패한다(요청에 넣은 것은 제외). ids만 새는 job 목록을 심어 확인했다.
  - 본문에 중첩 id를 넣고, 소유자 범위 POST도 시도한다.
  - PDF 등 ZIP 밖 이진 형식은 풀지 않는다. 남은 위험이다(sweep fixture에는 PDF export가 없다).
- **m2**
  - 모듈 이름을 어떤 형태든 찾는다(양쪽 따옴표, `import()`, require, createRequire, 여러 줄).
  - fetch는 호출이나 값 사용을 찾고, 속성·경로·다른 객체의 메서드는 제외한다. 이 형태들의 판별 자체도 시험한다.
  - `.js/.mjs/.cjs`, `infra/`, `scripts/`를 포함하고, 주석과 type import는 뺀다.
  - `process.env`를 펼치거나 `Object.assign`·`structuredClone`으로 복사하면 금지한다.
  - eval·new Function·vm을 금지한다.
  - 새로 잡힌 것
    - sandbox 가용성 확인이 worker 환경을 받았다(**F-04**, 수정).
    - sandbox 안 상속 2곳은 검토 목록에 넣었다.
- **m3**: 수동 확인은 사용자가 관리하는 `reports/security/manual-checks.json`에서 읽는다. 통과에는 `checked_by: "user"`, 날짜, 근거가 필요하다.
- **m4**
  - SEC-SEND-POLICY 영역을 추가했다.
  - 점검 중 **F-03(high)**을 찾았다. 실제 전송 지점 `runProviderTurn`이 전송 정책을 확인하지 않았고, 선택 수정·curation worker에는 자체 확인이 없었다. 수정했다(RED `red-F03.log`).
  - RFC-010 시험 논문은 허용 공급자를 명시한다.
- **m5**: `RELEASE_AUDIT.md`에 spec 09 대조표를 넣었다. "부분"과 "없음"도 적었다(credential 교체 재인증, 로그 내용 자동 시험, SBOM, parser 패치 정책).
- **n1**: 감사 기록에 `dirty`를 넣었다. 커밋되지 않은 트리의 감사는 게이트가 거절한다.
- **n2**: 옮겨 둔 개발자 CLI 상태(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG)도 로그인 프로필로 거부한다.
- 반영 확인 mutation: n2, gate dirty, gate 수동 기록자, Object.assign env 복사, F-03, ids만 새는 목록 — 모두 잡았다. 잘못 만든 mutant 1개는 무효로 기록했다.

## 재리뷰(changes requested) — 반영
- **M1'**: 외래 키가 없는 id 배열은 schema 시험도 sweep도 덮지 않았다. 리뷰어가 다른 사용자의 주장·근거 id로 개요를 저장·승인했다(201/200).
  - **F-05(medium)**: 개요 노드의 `claim_ids`·`evidence_ids`가 형식만 확인되었다. 다른 논문의 근거가 "근거 필요"를 채웠다. 내용 유출은 없었다(읽는 쪽이 논문으로 거른다).
  - 수정: 개요 저장 시 UUID 형태 id는 이 논문의 주장·근거여야 한다(`not_in_paper` 422). PW-010의 자유 계획 이름표는 허용한다. RED `red-F05.log` → GREEN.
  - `schema.int.test.ts`: 모든 배열 열을 분류한다. id 배열 7개에는 누가 쓰는지, 어디서 논문을 확인하는지를 적었다. 나머지 13개는 id가 아니다. 새 열이나 사라진 열은 실패한다.
    - run token handle: 발급 시 논문·문서 확인.
    - curation search: worker가 저장 전 확인.
    - paragraph proposal claim/fact: contract 안의 id만 받고, contract는 논문으로 거른다.
    - repair finding: 서버가 이 논문의 리뷰에서 고른다(요청은 id를 주지 않음).
  - 표적 시험에 개요 2종(다른 논문의 주장 id, 근거 id)을 더했다(대조군 포함).
  - 원고 안의 id(인용·그림 참조)
    - 수동 편집이라 저장은 막지 않는다.
    - 다른 논문의 것은 내보내기에서 `unresolved_citation`·`unresolved_figure` 오류가 된다. 제출판 freeze를 막는다.
    - 그 내용은 보고서와 파일 어디에도 나오지 않는다(새 시험).
  - 감사 보고서의 "어떤 route나 worker로도…" 문장을 외래 키에 한정했다. id 배열과 원고 안 id는 3·4항으로 따로 적었다.
- **m1**: 수동 확인을 `manual-checks.json`에서 지우면 게이트가 allowed가 되었다. `REQUIRED_MANUAL`(MAN-LIVE-SANDBOX, MAN-DEPLOY-TLS)이 빠지거나 필수가 아니면 거절한다. 시험을 추가했다.
- mutation 6종: 5종을 잡았다. 무효 1종(시험 자신의 단정을 바꾼 것)은 소스 쪽 심기(검토 목록에서 열 하나 제거)로 대신했고, 그것도 잡았다.

## 3차 리뷰(approve) — NIT 반영
- n1: 자유 계획 이름표(PW-010 설계, UUID가 아닌 글)는 여전히 "근거 필요"를 채운다. F-05 기록에 무결성 보장이 아니라 계획 표시라고 적었다(`findings.json`, `RELEASE_AUDIT.md`).
- n2: story의 `evidence_links`는 사용자가 쓴 글이다. 어디서도 id로 풀지 않는다고 감사 보고서 4항에 적었다.
- 문서만 바뀌었다(코드·시험 변경 없음). pack-check로 확인했다.

## 감사 실행과 회귀(리뷰 반영 후)
- 감사: 깨끗한 커밋 `199bf58`에서 `node --experimental-strip-types tests/security/run-audit.ts` → exit 2(`pending_manual`), `dirty: false`, 자동 9개 영역 통과. 기록 `audit-run.log`, `reports/security/audit.json`.
- `pnpm test` 1회차(`test-run2-failed.log`): TST-014A 1건 실패.
  - 원인: PW-057의 묶음 내보내기 스냅샷 선택에 같은 스냅샷 이름이 option으로 나온다. 목록 갱신이 확인보다 먼저 끝나면 `getByText`가 두 요소를 잡는다(경합).
  - 수정: 시험이 이름을 `exact`로 찾는다(시험만, RFC-014 부록). 해당 파일 3회 반복 통과.
- `pnpm test` 2회차(`test.log`): exit 0. unit 617, 통합 639, contracts 17, 브라우저 101, spikes·evals·pack-check 통과.
- `sweep-stats.json`의 상태 개수는 실행마다 몇 개씩 다르다(예: 200 265↔268). id 목록의 순서가 무작위 uuid를 따르기 때문이다. 판정(유출·변경·교차 참조·500 없음)과 route 분류 개수는 같다.

- 재리뷰 반영 후: 깨끗한 커밋 `0048e33`의 감사 → exit 2(`pending_manual`), `dirty: false`, 9개 영역 통과(IDOR-AUTH 12). `pnpm test` exit 0(unit 618, 통합 641, contracts 17, 브라우저 101; `test.log`).

## 다음
PW-060(백업·복구 drill)
