# P00 결정 기록 — 사전 타당성·위험 검증 결과

작성: 2026-10-08 / 상태: **승인됨** (사용자 2026-10-08 "작업해": P01 진행, RFC-004·005, ADR-013~015 승인. RFC-003은 P02에서 재확인)
- 근거 보고서: `reports/tasks/PW-001 … PW-006/REPORT.md`
- 독립 리뷰: `reports/phases/P00_REVIEW.md`
- Gate 보고서: `reports/phases/P00_GATE.md`

## 0. 요약
- 핵심 위험 4개(인증, 선택영역·인용·수식 보존, 격리, 출력)를 spike로 확인했다.
- 독립 리뷰가 major 9건을 찾았다. 수정 후 재검토에서 새 major 1건(N1)이 나왔고, 이것도 수정했다(P00_REVIEW 참조).
  - 완전 해결: M1, M4, M8, N1, N2
  - Codex 비활성으로 처리: M7
  - 부분 해결(휴리스틱, 알려진 한계 기록): M2, M3, M5, M6, M9
- 사용자 결정(2026-10-08 추가): Linux에서 **본인 계정**으로 실행, 논문 자료는 AI 사용을 위해 전송 허용.
- **P01(정본·승인·수동 workflow)은 Mock provider만으로 시작할 수 있다.**
- 실제 provider 사용은 아래 5장의 조건을 만족한 사용자 머신에서만 가능하다.
- 측정 환경은 개발용 클라우드 컨테이너다(Linux x86_64, 4 CPU, 15 GB RAM). 테스트 프로세스는 root이고, 가짜 provider는 uid 65534로 실행했다. 사용자 PC와 연구실 서버(모두 Linux)에서는 아직 측정하지 않았다.

## 1. Compatibility matrix
상태 값:
- **measured** = 이 환경에서 실제 실행으로 확인
- **spike-tested** = 우리 코드가 fake/fixture 기반 자동 테스트로 확인(실제 provider 아님)
- **documented** = 공식 문서/설치 버전 help·schema로만 확인
- **unknown** = 근거 없음
- **blocked** = 사용자 머신·로그인 필요

| 항목 | Claude Code CLI 2.1.294 (구독 로그인) | Codex CLI 0.161.0 (ChatGPT 로그인) |
|---|---|---|
| 구조화 실행 | measured¹ (`-p --output-format stream-json`: system/init → assistant → rate_limit_event → result) | measured: stdio JSON-RPC `initialize`, `account/read` 왕복(로그인 없음) |
| 명시 세션 id | measured¹ (`--session-id` 반영) / resume: documented | documented (`thread/start`, `thread/resume`) |
| interrupt | documented (SIGINT = turn 종료, init capabilities에 `interrupt_receipt_v1`) | documented (`turn/interrupt`) |
| 수동 compact | unknown (`--autocompact`만 확인) | documented (`thread/compact/start`) |
| context/usage | measured¹ (result.usage, total_cost_usd 추정치) | documented (`thread/tokenUsage/updated`) |
| quota/reset | unknown (`rate_limit_event` 존재만 확인) | documented (`account/rateLimits/read`: usedPercent, resetsAt) |
| built-in 도구 | measured¹: `--tools ""` → init.tools=[]. `--restricted` 추가는 documented(help) | **shell 차단 불완전**: `shell_tool` 등 15개 feature는 끌 수 있음(measured), **`unified_exec`는 끌 수 없음(measured)**, `approval_policy="untrusted"`는 시작 시 거부(measured) → sandbox 안 읽기 전용 명령은 승인 없이 실행 가능 |
| 설정 표면 | hooks/CLAUDE.md 자동 로드 위험 → `--restricted`(documented, live 미실행) + 상위 폴더 agent-config 금지(준비 시와 실행 직전, spike-tested). managed settings는 여전히 적용(preflight가 존재 기록) | MCP config는 documented |
| **빈 profile auth 격리** | **measured: leak** (이 컨테이너는 호스트 수준 자격증명을 공급) | **measured: isolated** |
| 자격증명 위험 표면 | `ANTHROPIC_API_KEY`가 있으면 구독 대신 사용; OS keychain | 리셋 크레딧 소비·shell·fs 메서드 → RPC deny(spike-tested) |
| admission | requires_verification | requires_verification, **바깥 filesystem sandbox 검증 전 비활성** |

¹ PW-004의 의도치 않은 1회 호출에서 얻은 값(합성 "ping", 추정 $0.009). 사고 기록은 PW-004 보고서 참조.

| 문서/출력 | 상태 (pandoc 3.1.3, API 1.23.1) |
|---|---|
| 선택 위치 계약 | spike-tested: UTF-16+atom=1, grapheme 분할 거부, handle에 범위 고정, 1회만 적용, STALE |
| AI 보수적 guard | spike-tested **휴리스틱**: 수치 순서·비교기호(기호·단어)·단위·철자 숫자·부정어·방향어·서식·인용 locator·위치 검사. 영어 중심. **알려진 우회**: 그룹 라벨만 바꾸기, 주어 교체, 함축 부정, 주장 강도(suggest→prove) → 의미 판단은 PW-043/044 |
| DOCX 본문 보존 | measured(이 fixture 1개): 블록마다 citeproc 렌더링한 원문과 **정확히 같은지** 비교(인용 제거·교체·locator 변경·단어 삽입을 탐지), 한글·emoji·그리스문자·결합문자, italic/sub/sup, 표, OMML 수식, 참고문헌. 수식 내용 자체는 텍스트 비교에서 제외(OMML 존재만 확인) |
| DOCX 손실 | measured: Word/Zotero 인용 field 없음, block id 없음, figure_ref는 번호 없이 "Figure", comment·track changes 미지원 |
| PDF 출력 / DOCX import | not_run (PW-055, PW-057) |

## 2. ADR — 상태 갱신 (proposed → 승인 요청)
| ID | 결정 | P00 근거 | 제안 상태 |
|---|---|---|---|
| ADR-001 | PaperProject = 논문 1편 | 사용자 확정 | accept |
| ADR-002 | PostgreSQL + immutable revision이 정본 | 변경 없음 | accept |
| ADR-003 | TypeScript monorepo + shared editor-core | PW-003: 위치·hash·guard 로직이 JS에서 동작 → 서버/브라우저 공유 가능 | accept |
| ADR-004 | Tiptap OSS + 자체 comment/proposal | Tiptap 3.31.4 MIT. Pro 기능 미사용 | accept |
| ADR-005 | 단일 owner + optimistic concurrency | 변경 없음 | accept |
| ADR-006 | AI는 proposal만, 서버가 적용 | PW-003 spike: handle 고정·1회 적용·guard 필수. DB revision/idempotency key는 PW-017에서 구현 | accept |
| ADR-007 | provider capability admission | PW-002 registry + auth sentinel 필수화 | accept, RFC-001 반영 |
| ADR-008 | pg-boss + DB job/outbox | 미검증(P01 PW-013) | accept (P01 검증 조건) |
| ADR-009 | checkpoint + compact/새 세션 재수화 | Claude 수동 compact unknown → 새 세션 재수화가 기본 | accept |
| ADR-010 | 문서당 writer 1개, 제한된 review | 변경 없음 | accept |
| ADR-011 | draft export ≠ submission snapshot | 변경 없음 | accept |
| ADR-012 | local/private 배포, multi-user 제외 | S01 문구로 더 강해짐 | accept |
| **ADR-013 (신규)** | 두 provider 모두 같은 **MCP paper tool gateway**를 사용하고, provider 고유 shell/file 도구는 쓰지 않는다 | Claude: `--tools ""` + `--restricted` + MCP. **Codex: unified_exec를 끌 수 없어 바깥 sandbox 필수** | 승인 요청 |
| **ADR-014 (신규)** | 런타임은 **본인 Linux 계정(non-root)** 에서 분리된 CLI profile로 실행. 해당 호스트에서 24시간 안에 측정한 auth sentinel이 isolated일 때만 admission. `startProviderRun`은 `decideModelCall`이 발급한 결정만 받고 전체 argv를 검증. Codex는 bubblewrap 안에서만 실행 | PW-004 leak 실측, 사용자 결정(본인 계정), spike 테스트(발급되지 않은 결정·앞에 끼운 플래그·실행 폴더 밖 mcp-config 거부) | 승인 요청 (RFC-004). 참고: 프로세스 내 발급 확인은 실수 방지용이며, 제품에서는 서버 DB 기록이 권한 근거(PW-023/030) |
| **ADR-015 (신규)** | AI effort를 작업 종류별로 지정, 프로젝트 설정에서 변경 가능. 기본: 문법·간결화=low, 짧은 채팅·학술 재작성=medium, Story/Outline·과학 검토=high | Claude `--effort low…max` 확인(help). Codex 대응은 P03 | 승인 요청 |

## 3. RFC
| RFC | 내용 | 상태 |
|---|---|---|
| RFC-001 | 런타임 = 사용자 본인 로그인의 Claude Code CLI / Codex CLI (API 키 아님), PC·서버 둘 다 | accepted (사용자 결정) |
| RFC-002 | Claude CLI 최소 adapter를 P02(PW-020)로 앞당김 | accepted (위임). 단 **RFC-004 승인과 사용자 머신 sentinel isolated가 선행 조건** |
| RFC-003 | 개요 승인 전 사용자 문장의 보수적 교정 허용, 새 생성·재작성은 차단 | **proposed** (리뷰 M2로 위임 승인 철회. guard는 강화했지만 휴리스틱이라 사용자 확인 필요) |
| RFC-004 | 본인 Linux 계정 + 분리 profile + auth sentinel, reaping init, Codex bubblewrap, 자료 전송 기본 허용 | proposed (사용자 결정 반영) |
| RFC-005 | edit_proposal v2: selection handle 참조(범위 미포함), proposal_id, slice hash, preserve_atom | proposed (spike 구현됨) |

## 4. Version pin 후보와 License
원칙:
- P01(PW-007)에서 lockfile로 정확히 고정한다.
- 공급망 안정성을 위해 **릴리스 후 14일 이상 지난 버전**을 우선한다. 아래 "확인 버전"은 2026-10-08 npm `latest`이며 고정값이 아니다.
- 업그레이드는 contract/eval/export fixture 회귀와 auth sentinel 재실행을 통과한 뒤에만 한다.

| 구성요소 | 확인 버전 (2026-10-08) | License | 비고 |
|---|---|---|---|
| Node.js | 22.22.0 (컨테이너) | MIT | LTS 계열로 고정 |
| pnpm | 10.28.0 | MIT | |
| TypeScript | 7.0.2 latest | Apache-2.0 | 7.x 메이저 전환 직후 → PW-007에서 호환성 확인 후 결정 |
| React / react-dom | 19.3.0 (2026-10-07 릴리스) | MIT | 14일 규칙상 직전 안정 버전 우선 |
| Vite | 8.3.3 (2026-10-06) | MIT | 상동 |
| @tiptap/core, /pm, /starter-kit | 3.31.4 | MIT | OSS만 사용 |
| prosemirror-model / -transform / -state | 1.25.12 / 1.12.2 / 1.4.4 | MIT | PW-003 spike 고정값 |
| fastify | 5.12.5 | MIT | |
| pg-boss | 12.37.0 (2026-10-06) | MIT | 직전 안정 버전 우선 |
| pg (node-postgres) | 8.23.1 | MIT | |
| PostgreSQL | 16.x (컨테이너에는 client 16.15만 있음) | PostgreSQL License | 서버는 docker image digest로 고정 |
| vitest | 5.0.3 | MIT | spike는 node:test 사용 |
| @playwright/test | 1.64.0 (2026-10-08) | Apache-2.0 | 직전 버전 우선, 브라우저는 사전 설치본 |
| pdfjs-dist | 6.4.299 | Apache-2.0 | P04 |
| ajv | 8.20.0 | MIT | JSON Schema 검증 |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | paper tool gateway (ADR-013) |
| pandoc | ≥ 3.1.3 (측정 3.1.3) | GPL-2.0-or-later | 별도 프로세스로 실행(링크 안 함). 사용자 머신 버전은 런타임에 `pandocInfo()`로 확인 |
| claude-code (CLI) | 2.1.294 | Anthropic 상용 약관 | 사용자 설치본. 업그레이드 시 sentinel·플래그 allowlist 재검증 |
| codex (CLI) | 0.161.0 | Apache-2.0 | schema inventory sha256 + feature list로 drift 검사 |
| @anthropic-ai/claude-agent-sdk | 0.3.293 | "SEE LICENSE IN README" (Anthropic 약관) | PW-024 비교 대안. 기본 경로 아님 |
| GROBID | P04에서 확인 | Apache-2.0 | 선택 서비스 |

## 5. Go / No-go
**판정: CONDITIONAL GO** — P01 진행 가능. 조건:
1. P01은 Mock provider만 사용한다(외부 AI 호출 0회).
2. PW-012(editor-core)는 PW-003 spike의 handle 고정·1회 적용·guard·블록별 손실 검사를 계약으로 옮긴다. 실제 원고에 쓰기 전 브라우저 selection으로 재검증한다(PW-015/022).
3. 실제 provider 연결(RFC-002의 PW-020 최소 adapter 포함)은 아래 조건을 모두 만족한 머신에서만 활성화한다.
   - RFC-004 승인
   - 그 머신에서 분리 profile로 로그인한 뒤, sentinel을 실행해 isolated 확인(24시간 유효)
   - 해당 provider의 live smoke 통과
4. **Codex**는 바깥 filesystem sandbox(실행 폴더만 보이는 bubblewrap/컨테이너/VM)가 검증될 때까지 admission하지 않는다.
5. writing baseline(PW-005)은 결정적 오류(수치·인용 깊이·그룹·null 결과·인과 표현)만 판정한다. 문체(장문·보고서식)는 사람/모델 검토 대상이며 점수화에 쓰기 전 PW-044/045 rubric이 필요하다.
6. 미검증 항목(PDF, DOCX import, 실제 resume/interrupt/quota, 브라우저 IME)은 해당 Task에서 blocked로 관리하며 "지원됨"으로 표시하지 않는다.

No-go가 되는 경우:
- 사용자 머신에서 sentinel이 isolated가 될 수 없고(전용 OS 사용자 불가), 대안(VM/WSL2)도 거부되는 경우 → Claude provider는 disabled 유지.
- 사용자 요금제 약관상 개인 headless 사용이 허용되지 않는 경우 → 해당 provider disabled.

진행 방식 기록:
- 사용자가 2026-10-08 "니가 적절하게 정해라"로 판단을 위임했다. 이에 따라 P00 6개 Task를 연속 진행하고, 독립 리뷰는 phase 끝에 한 번 받았다.
- 계획서는 Task마다 리뷰를 받도록 되어 있다. P01부터는 Task 단위로 리뷰를 받는 것을 기본으로 제안한다.
- 독립 리뷰는 두 번 받았다(1차 → 수정 → 2차). 2차가 지적한 새 결함(N1, N2)과 부정확한 문장 3개도 수정했다. 다만 그 수정에 대한 3차 리뷰는 받지 않았다.

## 6. 사용자 승인·확인 항목
확정된 것(2026-10-08): 실행 OS는 Linux, 본인 계정으로 실행, **sudo 없이 동작**, 논문 자료는 선택한 provider로 전송 허용(민감 자료 차단 스위치는 유지).

1. **분리 로그인 동의**: 본인 계정 안의 플랫폼 전용 폴더(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`)에서 `claude`와 `codex login`을 한 번씩 다시 로그인하는 데 동의하는지. 같은 구독 계정이어도 된다(RFC-004).
2. ~~연구실 서버 sudo 여부~~ → **불필요(사용자 결정 반영)**. 실행 폴더는 `$XDG_RUNTIME_DIR` 또는 `/tmp` 아래 본인 전용 폴더를 쓴다. Codex sandbox는 codex에 들어 있는 bwrap을 쓴다. 남은 확인은 각 머신의 비특권 user namespace 허용 여부(preflight가 확인).
3. **사용자 머신에서 실행할 확인**(모델 호출 없음):
   - `node spikes/preflight/preflight.mjs --data-root <경로> --protect <연구폴더>`
   - `node spikes/isolation/tools/auth-sentinel.mjs` (분리 로그인 전·후 각 1회; runsRoot 생략 시 sudo 없는 기본 위치)
4. **data root / 백업 위치**: 운영 데이터 경로와 오프호스트 백업 대상.
5. **민감 자료 범위**: 전송 차단 스위치를 켜야 할 자료가 있는지(예: 개인식별·인체 유래 데이터).
6. **승인 요청**:
   - RFC-003, RFC-004, RFC-005와 ADR-013~015
   - RFC-002는 위임 결정으로 accepted 처리했으며, 이견이 있으면 알려주세요.
7. **평가용 실제 문단**: COLLECTION_PROCEDURE에 따라 tune 10 + held-out 10 제공 가능 여부(P05까지 필요).
8. **사고 증거 정리**: 의도치 않은 호출의 임시 profile 폴더(`/tmp/pw004-live-neg-*`, 이 컨테이너 안)를 삭제해도 되는지.
