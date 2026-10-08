# Progress
- 상태: P00 사전 검증 spike 6개 구현·테스트 완료(in_review). 제품 코드(apps/packages/db)는 아직 없음.
- 현재 단계: **P00 gate — 사용자 승인 대기** (`reports/phases/P00_GATE.md`, `docs/adr/P00_DECISION_RECORD.md`).
- 승인된 구현 Task: PW-001–PW-006 (사용자 2026-10-08 "적절하게 정해라" 위임 하에 P00 범위만 진행).
- 사용자 결정 (2026-10-08):
  - 런타임 AI = 사용자 본인 로그인의 Claude Code CLI / Codex CLI (API 키 아님) — RFC-001.
  - 배포 = 개인 PC + 연구실 서버 둘 다.
  - Codex를 v1에 포함할지, 계획 변경(RFC-002/003)을 할지는 구현자에게 위임.
- 승인된 라이브 AI 실행/예산: 없음.
  - PW-004에서 **의도치 않은 Claude 호출 1회** 발생(합성 "ping", 추정 $0.009, 개발 컨테이너 자격증명). 보고서에 기록함.
- 검증된 운영/공급자 버전: 없음(개발 컨테이너 측정만 있음).
  - claude 2.1.294, codex 0.161.0, pandoc 3.1.3, node 22.22.0.
  - 사용자 PC·서버는 미측정.
- 다음 행동: 사용자에게 P00 gate 승인과 결정 기록 6장의 확인 항목을 요청. 승인 후 P01 PW-007(monorepo scaffold).

## Task 기록
| Task | 상태 | commit | REQ·TST | 실행 | 미실행/blocked |
|---|---|---|---|---|---|
| PW-001 | in_review | e89a701 | REQ-001 / TST-001A,B | `node --test 'tests/tasks/PW-001/*.test.mjs'` 7/7 | 사용자 PC·서버 preflight |
| PW-002 | in_review | e89a701 | REQ-002 / TST-002A,B | 7/7, CLI `--version` probe | live smoke (사용자 로그인 필요) |
| PW-003 | in_review | e414ffc | REQ-003 / TST-003A,B | 11/11, DOCX 왕복 손실 보고서 | 브라우저 selection·IME (PW-015/022) |
| PW-004 | in_review | e414ffc | REQ-004 / TST-004A,B | 10/10, 실제 auth sentinel: claude=leak, codex=isolated | 실제 resume/interrupt, OS 사용자·sandbox |
| PW-005 | in_review | c54b009 | REQ-005 / TST-005A,B | 9/9, mutation check | 모델 출력 평가, 실제 문단 gold |
| PW-006 | in_review | (this) | REQ-006 / TST-006A,B | 4/4, P00 회귀 48/48, pack validator PASS | — |

미해결 RFC:
- RFC-004 (전용 런타임 OS 사용자 + auth sentinel): proposed
- RFC-005 (edit_proposal v2): proposed
- RFC-001/002/003: accepted

## 작업 후 기록 양식
Task ID / 상태 / git commit(있는 경우) / REQ·TST / 실제 실행 명령과 결과 / 미실행 / 검토 결과 / 사용자 승인 / 다음 작업 / 미해결 RFC.

Phase 승급은 Gate 보고서와 사용자 승인 후 기록한다. pack validator의 PASS는 제품 테스트 PASS가 아니다.
