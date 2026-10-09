# Progress
- 상태: P00 사전 검증 spike 6개 구현·테스트 완료(in_review). 제품 코드(apps/packages/db)는 아직 없음.
- 현재 단계: **P01 진행 중** (P00 gate 승인: 사용자 2026-10-08 "작업해").
  - 승인으로 기록: P00→P01, RFC-004, RFC-005, ADR-001~015, 분리 profile 로그인 방식.
  - RFC-003은 P02에서 필요할 때 다시 확인한다.
- 승인된 구현 Task: PW-001–PW-006 (사용자 2026-10-08 "적절하게 정해라" 위임 하에 P00 범위만 진행).
- 사용자 결정 (2026-10-08):
  - 런타임 AI = 사용자 본인 로그인의 Claude Code CLI / Codex CLI (API 키 아님) — RFC-001.
  - 배포 = 개인 PC + 연구실 서버 둘 다. 둘 다 **Linux**, **본인 OS 계정**으로 실행, **sudo 없이 동작**해야 함.
  - 논문 자료는 AI 사용을 위해 전송 허용(민감 자료 차단 스위치는 유지) — RFC-004.
  - Codex를 v1에 포함할지, 계획 변경(RFC-002/003)을 할지는 구현자에게 위임. RFC-003은 리뷰 후 proposed로 되돌림.
- 승인된 라이브 AI 실행/예산: 없음.
  - PW-004에서 **의도치 않은 Claude 호출 1회** 발생(합성 "ping", 추정 $0.009, 개발 컨테이너 자격증명). 보고서에 기록함.
- 검증된 운영/공급자 버전: 없음(개발 컨테이너 측정만 있음).
  - claude 2.1.294, codex 0.161.0, pandoc 3.1.3, node 22.22.0.
  - 사용자 PC·서버는 미측정.
- P01 gate 승인: 사용자 2026-10-09 "해라" → 권장안 4개 승인. 내용은 `reports/phases/P01_GATE.md` "사용자 결정".
  - RFC-006 공유 변경 확정
  - 개요 전체 승인 유지
  - SSH 터널 접속
  - P00 임시 폴더 삭제 승인. 개발 컨테이너에서는 권한 검사로 삭제가 거부되어 남아 있다.
- 다음 행동: P02 PW-015(에디터·자동저장·IME)부터 시작한다. 시작 시 RFC-003을 확인한다.
  - 2026-10-09 현재 실행 환경이 모든 Bash 명령을 거부한다. 그래서 이 기록은 아직 commit하지 않았다.
- 사용자 머신 preflight/sentinel 결과는 아직 받지 않음(P03 전까지 필요).

## Task 기록
| Task | 상태 | commit | REQ·TST | 실행 | 미실행/blocked |
|---|---|---|---|---|---|
| PW-001 | in_review | 5de9421 | REQ-001 / TST-001A,B | `node --test 'tests/tasks/PW-001/*.test.mjs'` 7/7 | 사용자 PC·서버 preflight |
| PW-002 | in_review | 5de9421 | REQ-002 / TST-002A,B | 10/10, CLI `--version` probe | live smoke (사용자 로그인 필요) |
| PW-003 | in_review | 5de9421 | REQ-003 / TST-003A,B | 17/17, DOCX 블록별 손실 보고서 | 브라우저 selection·IME (PW-015/022) |
| PW-004 | in_review | 5de9421 | REQ-004 / TST-004A,B | 15/15, 실제 auth sentinel: claude=leak, codex=isolated | 실제 resume/interrupt, bubblewrap, 사용자 머신 sentinel |
| PW-005 | in_review | 5de9421 | REQ-005 / TST-005A,B | 14/14, mutation check | 모델 출력 평가, 실제 문단 gold |
| PW-006 | in_review | 5de9421 | REQ-006 / TST-006A,B | 4/4, P00 회귀 70/70, pack validator PASS | — |
| PW-007 | in_review | (P01) | REQ-007 / TST-007A,B | `pnpm test` exit 0, 깨끗한 clone exit 0, 리뷰 1회 반영 | GitHub CI 실제 실행 |
| PW-008 | in_review | (P01) | REQ-008 / TST-008A,B | 통합 21/21(리뷰 회귀 10 포함), mutation 2종 탐지, 리뷰 1회 반영, 재리뷰 approve(minor 1·2 반영) | 브라우저 로그인 UI(PW-014), public allowlist·csrf_hash 정리 |
| PW-009 | in_review | (P01) | REQ-009 / TST-009A,B | 통합 7/7 + 리뷰 회귀 6/6, 리뷰 major 3·minor 4·7 반영 | 대용량 성능, 서지·asset API(P04), seq 열(minor 5), runtime DB role 분리 |
| PW-010 | in_review | (P01) | REQ-010 / TST-010A,B | 통합 26/26(리뷰 회귀 12 포함), mutation 3종 탐지, 리뷰·재리뷰 반영(재리뷰 approve), `pnpm test` exit 0 | outline 웹 UI(PW-014 shell과 함께), claim 변경 impact(PW-011+), 범위별 승인 방식 사용자 결정 |
| PW-011 | in_review | (P01) | REQ-011 / TST-011A,B | 통합 33/33(리뷰 회귀 23 포함), mutation 5종 탐지, 리뷰·재리뷰 반영(재리뷰 approve), `pnpm test` exit 0 | evidence 웹 UI(PW-014), outline evidence_ids 실제 연결(RFC 필요), CSV 파서·철회 API(P04) |
| PW-012 | in_review | (P01) | REQ-012 / TST-012A,B | unit 43(리뷰 회귀 22 포함), Chromium↔Node parity 1, contracts 13, mutation 3종 탐지, 리뷰·재리뷰 반영(재리뷰 approve), `pnpm test` exit 0 | 저장 경로 연결·붙여넣기 U+FFFC 처리(PW-014/015), Firefox/Safari, IME, apply 엔진(PW-017), https 필요(secure context) |
| PW-013 | in_review | (P01) | REQ-013 / TST-013A,B | 통합 31/31(리뷰 회귀 16 포함, PostgreSQL+pg-boss), mutation 7종 탐지, 리뷰·재리뷰 반영(재리뷰 approve), `pnpm test` exit 0 | 기능 경로 연결(draft request→job, PW-014/P02), 승인 actor 기록(PW-014), worker 상시 루프·recoverJobs 호출·재발행 상한(P02/P03) |
| PW-014 | in_review | (P01) | REQ-014 / TST-014A,B | E2E 25/25(Chromium·실제 API·PostgreSQL, 2회 반복 42/42, 불안정했던 시험 60회 반복 60/60), unit 19, 통합 1, 리뷰 4회 반영, 실제 dev 실행 smoke, `pnpm test` exit 0 | IME·자동저장(PW-015/022), asset/reference 입력(P04), 배포·공유 서버 격리(P07) |

독립 리뷰: 2회 (`reports/phases/P00_REVIEW.md`). Gate: `reports/phases/P00_GATE.md`.
P01 gate: `reports/phases/P01_GATE.md` — **사용자 승인 대기** (P02는 승인 전 시작하지 않음).

미해결 RFC:
- RFC-003 (승인 전 보수적 교정): proposed (리뷰 후 되돌림)
- RFC-001/002/004/005: accepted
- RFC-006 (P01 write scope 보완): accepted (delegated) — P01 gate에서 사용자 확인

## 작업 후 기록 양식
Task ID / 상태 / git commit(있는 경우) / REQ·TST / 실제 실행 명령과 결과 / 미실행 / 검토 결과 / 사용자 승인 / 다음 작업 / 미해결 RFC.

Phase 승급은 Gate 보고서와 사용자 승인 후 기록한다. pack validator의 PASS는 제품 테스트 PASS가 아니다.
