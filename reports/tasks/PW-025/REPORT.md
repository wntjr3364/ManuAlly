# PW-025 — Codex App Server adapter — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `packages/providers/src/codex/`(새 폴더)
  - `rpc-policy.json`: P00 RPC 정책(PW-002)을 제품 코드로 옮겼다. Codex CLI 0.161.0에 고정이고, 생성된 schema inventory 기준이다.
  - `policy.ts`
    - `guardClientRequest`: 허용 목록 12개만. shell, fs, 크레딧, 설정, 플러그인, 삭제와 모르는 메서드는 보내기 전에 거부한다.
    - `serverRequestAnswer`
      - v2 승인 요청은 `{decision: 'decline'}`, 옛 `applyPatchApproval`·`execCommandApproval`은 `{decision: 'denied'}`
      - 자격증명 갱신·attestation·사용자 입력·elicitation은 JSON-RPC 오류 -32000(추측한 "거절" 값 대신)
      - 도구 호출은 tool gateway로만 보낸다
      - 그 밖은 JSON-RPC -32601
  - `args.ts`: `codex app-server --listen stdio://`만 쓴다. 포트·WebSocket은 거부한다. read-only sandbox, approval on-request(모두 거절), shell·browser·computer-use 기능은 끈다.
  - `admission.ts`: `decideCodexCall(registry, {key, …})` — 공용 gate(PW-024 리뷰 반영)에 바깥 filesystem sandbox 조건을 더했다. 같은 host에서 24시간 안에 검증돼야 한다(RFC-004).
  - `server.ts`: `startCodexServer`
    - 발급된 결정, 개인 실행 폴더, 에이전트 지시 파일 없음을 확인한다.
    - 절대 경로 실행 파일의 `--version`이 결정의 버전이자 고정 버전(0.161.0)이어야 한다.
    - 환경 변수 whitelist: `CODEX_HOME`, HOME, TMPDIR, PATH, LANG, TZ. `OPENAI_API_KEY`는 넘기지 않는다.
    - 그 뒤 `initialize`(userAgent 버전 재확인) → `initialized` 순서로 시작한다.
    - 타입이 있는 호출만 둔다
      - `startThread`(read-only, on-request)
      - `resumeThread`: 저장된 thread id만 받는다.
      - `runTurn`: turn마다 승인 turn 하나를 쓰고, 정규화 이벤트를 흘려보낸다. thread 시작 알림은 섞지 않는다.
      - `interrupt`(`turn/interrupt`), `close`
    - 원시 RPC(`request`)는 밖에 내놓지 않는다(리뷰 MAJOR-1). 허용된 메서드라도 매개변수로 sandbox·승인 정책·작업 폴더를 덮어쓸 수 있기 때문이다.
  - `index.ts`
- 시험(`tests/tasks/PW-025/`)
  - `fake-codex.mjs`: stdio JSON-RPC 대역 서버
    - 문서 형태의 응답·알림을 보낸다.
    - turn 중에 명령 승인 요청과 모르는 요청을 보내고, 필요하면 도구 호출도 보낸다.
    - 받은 메시지와 우리의 답을 기록한다.
  - `codex.test.ts` 19

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-025-A / TST-025A initialize→thread→turn 흐름과 normalized event가 contract에 맞음 | unit(대역 서버): initialize·initialized·thread/start·turn/start 순서. delta 2개, 메시지, usage(scope session), 완료가 나온다. turn/started·fs/changed는 해석하지 않는다(unrecognized). 모든 이벤트가 provider_event 계약을 통과한다 |
| | unit: 저장된 thread id로만 재개하고, 모르는 id는 실패한다. interrupt를 보내면 interrupted로 끝난다 |
| REQ-025-B / TST-025B raw server 외부 공개, unknown RPC forwarding, sandbox 밖 shellCommand 노출 차단 | unit: 포트·WebSocket listen은 거부한다. `thread/shellCommand`, `command/exec`, `fs/*`, 크레딧 사용, 설정 쓰기, 플러그인 설치, thread 삭제, 모르는 메서드는 보내기 전에 거부한다(대역 서버 기록에도 없다) |
| | unit: 명령 승인 요청은 decline이고, 서버가 그 답을 받았다. 모르는 서버 요청은 -32601이다 |
| | unit: 도구 호출은 gateway 콜백으로만 가고, gateway가 없으면 -32601이다 |
| | unit: 자식 환경 변수에 API key가 없다 |
| | unit: 다른 CLI 버전과 상대 경로 명령은 거부한다 |
| | unit: 바깥 sandbox가 없거나 미검증이거나 다른 host 것이면 거부한다. 등록부 미승인, 승인·예산·sentinel 문제, 위조 결정도 거부한다. turn은 승인한 수만큼만 쓸 수 있다 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- 개발 중 고친 것
  - thread 시작 알림이 turn 스트림에 섞였다. 이제 turn 스트림에서 뺀다.
  - 허용 목록 거부가 동기 예외로 나왔다. 이제 Promise reject로 나온다.
- mutation(`mutation.log`): 9종 모두 탐지했다.
  - 모르는 메서드 전달, 승인 수락, 모르는 서버 요청 응답, 공개 listen
  - gateway 없이 도구 호출 응답, 버전 미확인, turn 미소모, 바깥 sandbox 없이 허용, 환경 상속
- GREEN: unit 19.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 241, integration 198, contracts 15, e2e 77, spikes 70.
- 개발 실행(strip-types)에서도 모듈이 읽히는 것을 확인했다.

## 보안·과학적 실패 경로
- **Codex는 여전히 실행되지 않는다.**
  - 등록부 행이 requires_verification이다.
  - 바깥 filesystem sandbox(bubblewrap)가 검증되기 전에는 gate가 거부한다.
  - 0.161.0의 `unified_exec`는 끌 수 없어서, sandbox 안의 읽기 명령은 승인 없이 실행될 수 있다(P00 측정).
- **App Server는 사적 stdio이고, 브라우저·API로 노출하지 않는다.** 원본 RPC를 그대로 전달하는 경로가 없다.
- 크레딧 사용(`account/rateLimitResetCredit/consume`)과 로그인·로그아웃은 사용자 행위다. 허용 목록에 없다.

## 미실행 / 남은 위험
- **실제 Codex app-server: blocked/not_run.** 바깥 sandbox와 사용자 로그인·승인이 필요하다.
- **decline 응답 형식과 `thread/start`·`turn/start` 매개변수는 문서와 생성 schema 기준이다(documented_not_verified).** 실측은 PW-030(사용자 PC)에서 한다. 형식이 다르면 서버가 답을 거부하거나 turn이 시작되지 않는다. 그때 서버가 승인 없이 진행하지 않는다는 보장은 실측 전에는 없다. 그래서 실측 전에는 등록부가 Codex를 허용하지 않는다.
- **도구 호출 매개변수(`tool`, `arguments`)는 가정이다.** 실제 형태와 gateway 연결은 PW-027에서 한다.
- **Codex는 비용을 보고하지 않는다.** USD 예산은 집행할 수 없고, turn 수와 만료로만 제한한다.
- **바깥 sandbox 검증 절차(bubblewrap)는 PW-026에서 만든다.**

## 독립 리뷰 반영 (2026-10-09)
리뷰: MAJOR 2, minor 5, PW-024 nit 1. 시험을 먼저 썼다. 옛 구현에서는 9개가 실패했다(`review-red.log`). 고친 뒤 모두 통과한다.
- MAJOR-1: 원시 `request`를 없앴다. 서버 객체에는 `startThread`, `resumeThread`, `runTurn`, `interrupt`, `close`만 있다.
- MAJOR-2: 한 서버에서 turn은 한 번에 하나만 돈다. 알림에 믿을 만한 소유자 표시가 없어서, 두 번째 turn이 첫 turn의 답을 받을 수 있었다. 진행 중이면 두 번째 turn을 거부한다.
- minor
  - turn 시간 제한(기본 10분)이 지나면 `turn/interrupt`를 보내고 오류 이벤트로 끝낸다.
  - turn 중에 서버가 멈추면 조용히 끝내지 않고 오류 이벤트를 낸다.
  - profile에 `AGENTS.md`·`AGENTS.override.md`나 주석 아닌 `config.toml`이 있으면 거부한다. 인자에 `-c mcp_servers={}`도 넣는다.
  - `close()`: stdin을 닫고 → SIGTERM → SIGKILL. 각 단계 2초를 기다린다. 시험은 프로세스가 실제로 사라졌는지 확인한다.
  - 보고서 표현: decline 형식은 실측 전이라 "안전하게 실패한다"를 뺐다. 승인 요청 종류별로 schema가 받는 답을 쓰고, 승인이 아닌 요청은 오류로 답한다.
- PW-024 nit: 결정 검사(`checkDecision`: 발급, 허용, 공급자, 만료, 남은 turn·예산)를 `--version` 실행보다 먼저 한다. Claude와 Codex 둘 다. 거부된 결정으로는 아무 프로그램도 실행되지 않는다.
- mutation(`mutation.log` 아래쪽): 10종 모두 탐지했다. close의 SIGKILL 제거는 처음에 살아남았다. 시험이 시간만 봤기 때문이다. 프로세스 존재 확인을 더한 뒤 탐지했다.
- unit: PW-025 27, PW-024 24.

## 다음
PW-026: 격리 runner·입출력 mount
