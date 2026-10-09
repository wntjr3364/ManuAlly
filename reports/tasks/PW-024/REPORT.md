# PW-024 — Claude Agent adapter — REPORT
상태: in_review (2026-10-09)

## 결정: SDK가 아니라 공식 CLI headless 모드
- P00(ADR-013/014, RFC-001) 결정에 따라 사용자 본인 로그인의 Claude Code CLI를 `-p --output-format stream-json`으로 실행한다.
- Agent SDK(`@anthropic-ai/claude-agent-sdk`)는 P00에서 비교 대안으로만 남겼다. 라이선스는 "SEE LICENSE IN README"이고, 구독 로그인 사용 조건이 CLI와 다르다.
- 새 의존성은 없다.

## 변경 파일
- `packages/providers/src/claude/`(새 폴더). P00 spike(PW-002·004, 독립 리뷰 2회 반영)의 Claude 부분을 TypeScript로 옮기고 아래를 더했다.
  - `args.ts`: argv allowlist
    - 들어가는 것: `-p`, stream-json, `--tools ""`, `--restricted`, 실행 폴더 안의 `--mcp-config`만, `--allowedTools mcp__paper`, `--permission-mode dontAsk`, 슬래시 명령 끔
    - 세션 지정: 새 uuid(`--session-id`) 또는 저장된 uuid(`--resume`) 중 정확히 하나
    - `--continue`나 그 밖의 플래그는 거부한다. 프롬프트는 stdin으로만 보낸다.
  - `env.ts`
    - 환경 변수 whitelist: PATH, 실행 폴더의 HOME·TMPDIR, LANG, TZ, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. `ANTHROPIC_API_KEY`·토큰·DB URL은 넘기지 않는다.
    - profile 폴더 검사
      - 개발자의 `~/.claude`, `~/.claude.json`, `~/.codex`, HOME이거나 그 안·별칭(symlink/realpath)이면 거부한다.
      - 다른 사용자 소유, group/world 쓰기 가능, 내부 symlink·hard link도 거부한다.
    - 실행 폴더 위에 에이전트 지시 파일(CLAUDE.md, AGENTS.md, .claude, .mcp.json …)이 있으면 거부한다.
  - `admission.ts`: `decideClaudeCall`. 발급된 결정만 유효하다.
    - paper_work: 등록부 행이 approved이고 live evidence가 있어야 한다.
    - live_smoke: requires_verification에서도 허용한다. 그 evidence를 만드는 용도다.
    - 둘 다 필요한 것
      - 사용자 승인
      - 양수 예산(turn 수, USD)
      - 같은 host에서 24시간 안에 잰 auth sentinel이 isolated
  - `turn.ts`: `startClaudeTurn`
    - 발급된 결정만 받는다.
    - 실행 폴더를 확인하고, argv를 다시 검증한다.
    - 프로세스 그룹을 분리해(detached) 실행한다.
    - stdout을 PW-023 정규화 이벤트로 바꿔 흘려보낸다.
    - 우리가 정한 세션 id가 기준이다. CLI가 다른 id를 보고하면 `sessionMismatch`로 표시하고 채택하지 않는다.
    - 로그인 안 됨을 `authFailed`로 구분한다.
    - `cancel`은 자기 프로세스 그룹에만 SIGINT → SIGTERM → SIGKILL을 보낸다(잔여 정리·재연결은 PW-028).
  - `sessions.ts`: `recordSessionBinding` / `findSessionBinding`. 논문·작업 스레드·provider 버전·auth profile이 모두 같을 때만 저장된 id를 찾는다.
  - `index.ts`
- `db/migrations/pw_024_0001_agent_sessions.sql`
  - `agent_sessions`(spec 07 SessionBinding)는 불변이다.
  - native id는 uuid 형식이고 provider 안에서 유일하다.
  - 작업 스레드·profile id는 형식을 제한한다.
- 시험(`tests/tasks/PW-024/`)
  - `fake-claude.mjs`: 대역 CLI
    - 문서화된 동작을 흉내 낸다: 세션 생성·재개, stdin 프롬프트, 로그인 표시, 모르는 플래그·`--continue` 오류.
    - 본 것(argv, 환경 변수 이름, cwd)을 기록한다.
  - `claude.test.ts` 20
  - `sessions.int.test.ts` 2
  - `live-smoke.manual.ts`: 사용자 머신에서만 수동 실행. `pnpm test`에 포함되지 않는다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-024-A / TST-024A 승인된 합성 live smoke에서 native ID 저장·재개·범위 제한 response 확인 | **live: blocked/not_run.** 이 컨테이너는 실제 provider를 호출하지 않는다(P00 사건 이후 원칙). 사용자 PC에서 `live-smoke.manual.ts`를 실행하면 evidence JSON이 생기고, 그것이 등록부 승인 근거가 된다(PW-030) |
| | 대역 CLI 자동 시험: 새 세션 id가 CLI에 전달되고 init에서 그대로 보고된다. 저장한 id로 새 실행 폴더에서 재개하면 이전 대화가 이어진다 |
| | 대역 CLI 자동 시험: 다른 id를 보고하면 mismatch로 표시한다. CLI는 정해진 플래그와 whitelist 환경 변수만 받는다(실제 수신 내용으로 확인). init tools는 []다 |
| | 통합: 바인딩은 같은 논문·스레드·버전·profile에서만 찾는다. 같은 스레드는 최신이 이긴다. 불변이고 id는 유일하다 |
| REQ-024-B / TST-024B 인증·예산 없으면 disabled/blocked, 사용자 기존 Claude 세션·config 재사용 안 함 | unit: 등록부 미승인·disabled·승인 없음·예산 없음·sentinel 없음/leak/다른 host/24시간 초과/미래 시각이면 모두 거부한다 |
| | unit: live smoke는 검증 전에도 되지만 그 용도만이다. 거부되거나 위조된 결정은 실행할 수 없다 |
| | unit: `~/.claude`, HOME, 그 symlink, 쓰기 열린 폴더는 profile이 될 수 없다. `--continue`·uuid 아닌 id·허용되지 않은 플래그는 거부된다 |
| | unit: CLAUDE.md 아래의 실행과 실행 폴더 밖 MCP config는 거부된다. 로그인 안 된 profile은 인증 오류로 끝나고 다른 자격증명(부모의 API key)으로 넘어가지 않는다 |
| | unit: cancel은 자기 프로세스 그룹에 SIGINT부터 보낸다 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- 개발 중 시험 설계 수정
  - 대역 CLI의 시험 제어를 환경 변수로 주려 했으나, adapter가 whitelist 밖의 환경 변수를 넘기지 않았다(의도한 동작이다).
  - 그래서 제어는 profile 안 파일로 바꿨다.
- mutation(`mutation.log`): 13종 모두 탐지했다.
  - 부모 환경 상속, HOME·`~/.claude`·symlink profile 허용
  - 다른 host·오래된 sentinel 허용, 승인 없는 paper work, 예산 없음 허용
  - 위조 결정 허용, 다른 세션 id 조용히 채택, `--continue` 허용, CLAUDE.md 아래 실행
  - 버전·profile이 다른 세션 재개
- GREEN: unit 20, 통합 2.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`, PW-023 리뷰 반영 포함)
  - unit 219, integration 198, contracts 15, e2e 77, spikes 70
- 개발 실행(`node --experimental-strip-types`)에서도 모듈이 읽히는 것을 확인했다.
- `live-smoke.manual.ts`는 승인 플래그 없이 실행하면 "not run"으로 끝나고(exit 2) 아무것도 호출하지 않는다.

## 보안·과학적 실패 경로
- 자격증명
  - 플랫폼은 자격증명을 읽거나 복사하지 않는다.
  - 사용자가 전용 profile에 직접 로그인한다.
  - API key는 자식 프로세스에 닿지 않는다(구독 대신 과금되는 경로를 차단한다).
- 기존 세션: `--continue`나 "최근 세션"을 쓰지 않는다. 재개는 이 논문·스레드의 DB 바인딩 id로만 한다.
- 도구: CLI 내장 shell·파일 도구는 끈다. 논문 도구는 MCP gateway(PW-027)로만 열린다. 지금 MCP config는 비어 있다.
- 권한 근거: 지금은 프로세스 안의 발급 확인이다. 제품에서 권한의 근거는 서버 DB 기록이다(PW-030 gate에서 job·승인 기록과 연결한다).

## 미실행 / 남은 위험
- **TST-024A live: blocked/not_run.** 실제 CLI·로그인·사용자 승인이 필요하다. 절차는 `live-smoke.manual.ts` 머리말에 있다.
- **커널 수준 격리 없음.** 전용 OS 사용자·sandbox·리소스 한도는 PW-026에서 한다. 지금 보장은 프로세스 수준(환경·폴더·플래그)이다.
- **`--restricted`·`--permission-prompts`는 P00에서 help로만 확인했다(documented).** 실제 CLI가 다르게 동작하면 live smoke가 실패해 드러난다.
- **turn 예산(max_turns·USD)은 결정에 기록만 된다.** 누적 사용량으로 멈추는 것은 PW-029(usage·quota 관측)에서 한다.
- **Claude 수동 compact는 unknown이다.** 새 세션 재수화가 기본이다(ADR-009).

## 다음
PW-025: Codex App Server adapter

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(MAJOR 1, minor 4, nit 2).
- 문제없다고 확인된 것
  - 발급되지 않거나 거부된 결정으로는 실행되지 않는다.
  - argv allowlist, 환경 변수 whitelist(API key 차단), profile 별칭 검사는 spike와 같다.
  - 세션 범위, 프로세스 그룹 취소, live smoke 스크립트의 승인 플래그, TST-024A의 blocked/not_run 기록도 문제없다.

| 지적 | 조치 |
|---|---|
| **MAJOR 유일한 gate가 호출자가 준 capability 객체를 믿음**<br>손으로 만든 `{admission: 'approved', live_evidence: true}`로 paper_work가 허용됐다. 반대로 등록부에서 얻은 capability는 늘 거부됐다 | 공용 gate `packages/providers/src/core/admission.ts`(`decideRun`)를 만들었다. 호출자는 키(버전·인증·배포 형태)만 넘기고, gate가 등록부를 직접 읽는다. paper_work는 approved 행과 PW-023의 구조화된 live evidence(같은 CLI 버전)가 필요하다. 결정에는 키가 기록된다. `decideClaudeCall(registry, {key, …})`. 회귀 시험: 위조 capability를 넘겨도 등록부가 requires_verification이면 거부된다 |
| minor-1 실행 폴더를 확인하지 않아 "자기 MCP config만"이 호출자에게 달려 있었음 | `assertPrivateRunFolder` |
| | 실행 폴더: 본인 소유, mode 700, symlink 아님. 그 상위(runs root)도 본인 소유이고 다른 사람이 쓸 수 없다 |
| | work·home·tmp는 안쪽의 개인 폴더다 |
| | MCP config: 실행 폴더 안의 일반 파일, 본인 소유, 다른 사람이 쓸 수 없음, 내용은 `mcpServers`만 |
| | 회귀 시험 6가지: 공유 폴더, `/`, 쓰기 열린 config, 다른 키, symlink, 밖의 파일 |
| minor-2 아무 프로그램이나 실행할 수 있고 버전을 확인하지 않음 | 제품 API에서 `cmdPrefix`를 없앴다. 명령은 절대 경로의 실행 파일이어야 하고 다른 사람이 쓸 수 없어야 한다. 같은 whitelist 환경에서 `--version`을 읽어 결정의 버전과 다르면 거부한다. 시험용 대역 CLI도 `--version`에 답하는 실행 파일이다 |
| minor-3 승인 예산을 집행하지 않음 | 결정은 기본 1시간 뒤 만료된다. turn마다 하나씩 쓰고(`spendTurn`), 승인한 turn 수가 끝나면 거부한다. provider가 보고한 비용(turn 범위 usage)을 더해 USD 예산에 닿으면 실행을 멈추고, 다음 turn은 거부한다. 회귀 시험 3가지 |
| minor-4 세션 id 불일치를 표시만 함 | init에서 다른 id가 보고되면 그 자리에서 프로세스 그룹을 취소한다. 오류 이벤트 하나만 내고 `stopped: 'session id mismatch'`로 끝낸다. 회귀 시험 |
| nit 리더가 끝난 뒤 남은 자식에게 신호를 보내지 않음 | PW-028(잔여 정리·재연결)에서 spike의 `groupStillOurs` 방식으로 한다 |
| nit live smoke가 결정 전에 `--version`을 실행함 | 모델 호출이나 로그인이 아니어서 유지한다. 대신 절대 경로의 `--claude`를 요구하고, PATH만 넘긴다 |

- mutation(`mutation-review.log`): 9종 모두 탐지했다.
  - 등록부 승인 없는 paper work, turn 수, USD 예산, 만료
  - 바이너리 버전, 상대 경로, 불일치 미중단, 공유 실행 폴더, MCP config 내용
- 실행
  - PW-024: unit 23, 통합 2
  - `pnpm test` exit 0(`pnpm-test-review.log`, PW-025와 함께 실행): unit 241, integration 198, contracts 15, e2e 77, spikes 70
