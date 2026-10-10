# Release report — v1 최종 pilot·추적성 gate (PW-062) / P07 gate

작성: 2026-10-10 · 기준 커밋: 이 보고서가 들어 있는 커밋 · 근거 기록: [`capabilities.json`](capabilities.json)

## 판정
판정: **Demo (Mock)** (`demo_mock`)

릴리스 수준(spec 12)
| 수준 | 상태 |
|---|---|
| Demo (Mock) | **도달**: Demo 수준의 capability 10개가 MOCK 공급자로 자동 시험을 통과했다. |
| private alpha | 미도달: 실제 공급자 1개, 실제 sandbox, 사용자 기계 preflight가 필요하다. |
| private beta | 미도달: 두 번째 공급자, 실제 장애·한도 확인이 필요하다. |
| 개인 사용 v1 | 미도달: 보안 gate, 사람 rubric, 실제 배포·복원, 브라우저·IME, 사용자 pilot이 필요하다. |

**MOCK 표시**
- 이 저장소의 모든 AI 결과(문단 초안, 선택 수정, story 대안, 리뷰, curation)는 MOCK 공급자의 것이다.
- 실제 Claude Code·Codex 호출은 한 번도 하지 않았다. PW-004 사고로 승인 없이 `claude -p` 1회($0.00918)가 실행된 일이 있으며, 그 보고서에 기록되어 있다.
- registry는 두 공급자를 `requires_verification`으로 둔다. spec 11 규칙에 따라 live smoke가 없는 adapter는 **미검증·비활성**이다.

## 필수 capability
| ID | 내용 | 종류 | 상태 |
|---|---|---|---|
| CAP-PAPER-CORE | 논문·인증·불변 revision·snapshot·Story/Outline 승인·job·수직 경로·버전 | automated | pass |
| CAP-EDITOR | 편집기·autosave·IME(CDP)·선택 수정·CAS·comment | automated | pass |
| CAP-EVIDENCE-REFS | 주장·사실·근거·문헌·원문 PDF·anchor·그림 version(외부 서비스는 대역) | automated | pass |
| CAP-MOCK-AI | AI 경로 전체를 MOCK으로: adapter 계약, sandbox 규칙, gateway, Writer, Reviewer, workflow | automated | pass |
| CAP-SCIENTIFIC-AUTO | baseline·결정적 과학 gate·합성 hard case 30개 | automated | pass |
| CAP-EXPORT | DOCX 가져오기·DOCX/CSL·PDF·source archive·제출판 freeze | automated | pass |
| CAP-RELIABILITY | checkpoint·예산·quota 대기·lease·재시도·crash 재개(모의 장애) | automated | pass |
| CAP-SECURITY-AUTO | 보안 자동 감사 9개 영역(F-01~F-05 수정) | automated | pass |
| CAP-BACKUP-RESTORE | 백업·복원·migration drill(합성 데이터) | automated | pass |
| CAP-DEPLOY-TOOLS | 배포 확인·pwctl·운영 서버·AI 일시 중지·runbook(컨테이너 drill) | automated | pass |
| CAP-PROVIDER-CLAUDE-LIVE | 실제 Claude Code 실행 | live | not_run |
| CAP-PROVIDER-CODEX-LIVE | 실제 Codex 실행 | live | not_run |
| CAP-SANDBOX-LIVE | 실제 CLI를 bubblewrap sandbox 안에서(MAN-LIVE-SANDBOX) | manual | manual_pending |
| CAP-PREFLIGHT-USER | 사용자 기계 preflight·격리 확인 | manual | manual_pending |
| CAP-RELIABILITY-REAL | 실제 공급자 한도·실제 전원/파일시스템 장애 | manual | not_run |
| CAP-SECURITY-GATE | 보안 release gate(현재 결정 `pending_manual`) | manual | manual_pending |
| CAP-SCIENTIFIC-HUMAN | 사람 blind rubric과 수치 목표 | manual | manual_pending |
| CAP-DEPLOY-REAL | 실제 배포(사용자 systemd·TLS proxy, MAN-DEPLOY-TLS) | manual | manual_pending |
| CAP-RESTORE-REAL | 운영 환경 실제 복원 연습 | manual | manual_pending |
| CAP-BROWSERS-IME | 실제 한국어 IME·Firefox·Safari | manual | not_run |
| CAP-USER-PILOT | 사용자 pilot([PILOT.md](PILOT.md)) | manual | manual_pending |

모든 요구사항 REQ-001~REQ-062가 위 capability 중 하나 이상에 연결되어 있다(`capabilities.json`, 시험 `tests/tasks/PW-062/release.test.ts`).

## 남은 blocker(v1까지)
1. **CAP-PROVIDER-CLAUDE-LIVE**, **CAP-PROVIDER-CODEX-LIVE**
   - 사용자 기계에서 별도 runtime 로그인 프로필로 live smoke를 한다.
   - registry에 live evidence(`ran_inside_sandbox: true`)를 기록한다.
   - 실제 공급자 사용은 아직 사용자 승인 전이다(P03 gate).
2. **CAP-SANDBOX-LIVE**, **CAP-SECURITY-GATE**
   - 수동 확인 MAN-LIVE-SANDBOX와 MAN-DEPLOY-TLS를 `reports/security/manual-checks.json`에 사용자가 기록한다.
   - 그 뒤 감사를 다시 실행한다(`tests/security/run-audit.ts`).
   - 지금 감사 결정은 `pending_manual`이다(자동 9개 영역은 통과).
3. **CAP-PREFLIGHT-USER**: 사용자 PC와 연구실 서버에서 preflight와 격리 확인을 한다. data root, 백업 위치, runtime 사용자를 정한다.
4. **CAP-RELIABILITY-REAL**: 실제 공급자의 quota·문맥 값을 관측한다(지금은 UNKNOWN). 실제 장애 확인은 가능한 범위에서 한다.
5. **CAP-SCIENTIFIC-HUMAN**: 권리를 확인한 실제 문단으로 사람 blind rubric을 하고, 수치 목표를 사용자가 정한다.
6. **CAP-DEPLOY-REAL**, **CAP-RESTORE-REAL**: [DEPLOY.md](../../docs/runbooks/DEPLOY.md)대로 배포하고, 운영 백업을 다른 곳에 복원해 본다.
7. **CAP-BROWSERS-IME**: 실제 한국어 입력기와 사용하는 브라우저로 편집기를 확인한다.
8. **CAP-USER-PILOT**: [PILOT.md](PILOT.md)의 workflow를 사용자가 직접 하고 `pilot.json`에 기록한다.

## 사용자 승인 범위
| phase | 기록된 결정 | 범위 |
|---|---|---|
| P00 | 사용자 승인(2026-10-08) | 조건부 GO: Mock 전용 P01 |
| P01 | 사용자 승인(2026-10-09) | 수동 논문 작업 기반 |
| P02 | 사용자 위임 | 선택 편집과 Mock AI 경로 |
| P03 | 사용자 위임 | adapter·격리·gateway. **실제 provider 사용은 승인하지 않음** |
| P04 | 사용자 위임 | 문헌·원문·근거. 외부 서비스 실제 호출 없음 |
| P05 | 사용자 위임 | 과학 글쓰기 엔진. 실제 AI 실행과 사람 rubric 없음 |
| P06 | 사용자 위임 | 문맥·한도·내구성. 실제 한도·장애 미확인 |
| P07 | 사용자 결정 대기 | 이 보고서. PW-055~062 구현과 독립 리뷰는 끝났다. 위 blocker는 사용자 기계와 사용자 결정이 필요하다. |

그 밖의 사용자 결정
- 런타임 AI는 API 키가 아니라 사용자의 Claude Code·Codex 로그인이다.
- 개인 PC와 연구실 서버에 자기 계정으로 설치한다. sudo는 쓰지 않는다.
- AI를 쓰려면 논문 자료가 공급자에게 보내진다.
- 세부 결정은 위임되었다.

## P07 구현 요약(PW-055~062)
| Task | 내용 | 리뷰 |
|---|---|---|
| PW-055 | DOCX 가져오기와 손실 보고 | approve(5차) |
| PW-056 | DOCX·CSL 내보내기 | approve |
| PW-057 | PDF·재현 source archive | approve(재리뷰) |
| PW-058 | 리뷰 응답·제출판 freeze | approve |
| PW-059 | 보안 release 감사 | approve(3차) |
| PW-060 | 백업·복원·migration drill | approve |
| PW-061 | 배포·storage·upgrade runbook | approve |
| PW-062 | 이 gate | 리뷰 대기 |

## 알려진 과정상 문제(정직 기록)
- 일부 Task는 구현을 먼저 쓰고 시험을 나중에 썼다(PW-012, 029, 061, 041·042·052 일부). 각 보고서에 RED 재현과 함께 기록했다.
- 시험이 실패한 상태로 push한 커밋이 있었다(d6080be, 7c57279, PW-059·061 각 1회). 곧바로 고쳤고 보고서에 남겼다.
- PW-015·016 브라우저 시험의 일회성 실패는 원인을 확정하지 못했다.
- 앱의 DB 계정은 아직 superuser다. 별도 runtime role은 열린 과제다.
- budget, `run_errors`, 자동 재개 허가 화면은 API만 있다.
- 공급자 가용성 probe는 늘 unknown이다. 문맥 예산 반복(`runJobTurns`)은 아직 handler에 연결되지 않았다.

## 검증
- 전체 회귀(`pnpm test`)의 결과는 `reports/tasks/PW-062/test.log`에 있다. 실행 명령과 exit code가 들어 있다.
- 이 gate의 시험: `tests/tasks/PW-062/release.test.ts`.
  - 추적성, 승인 범위, 판정과 blocker의 일치를 본다.
  - 과장도 막는다: mock을 live로, 사용자 기록 없는 수동 pass, 증거 없는 pass, 빠진 capability.
