# Progress
- 상태: P00·P01 완료(gate 승인). P02 진행 중: PW-015 in_review.
- 이전 단계 기록: P00 gate 승인(사용자 2026-10-08 "작업해").
  - 승인으로 기록: P00→P01, RFC-004, RFC-005, ADR-001~015, 분리 profile 로그인 방식.
  - RFC-003은 P02에서 필요할 때 다시 확인한다.
- 승인된 구현 범위: P00(PW-001–006), P01(PW-007–014), P02(PW-015–022; P01 gate 승인 2026-10-09).
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
- 현재 단계: **P03 완료(사용자 위임), P04 진행**. PW-015~033 in_review. Gate: `reports/phases/P02_GATE.md`, `reports/phases/P03_GATE.md`(RFC-010은 사용자 확인 대상). P04 연결 파일은 RFC-011(위임 채택). PW-031 nit·PW-032·PW-033 리뷰 반영 완료(재리뷰 대기). 다음은 PW-034.
- 사용자 지시 (2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라"
  - 남은 Task(PW-016~062)를 순서대로 계속 구현한다. Task마다 in_review로 기록하고 독립 리뷰를 받되, 다음 Task를 이어서 시작한다.
  - phase gate의 사용자 결정은 위임으로 처리하고 gate 보고서에 "위임 결정"으로 기록한다(사용자가 나중에 뒤집을 수 있게).
  - 위임 결정: 임시 복구본 기본 켜짐 유지. RFC-003 좁혀 채택(승인 전 문법·간결화 교정만, diff 후 사용자 apply).
  - 위임 밖으로 남기는 것: 개발 컨테이너에서 실제 Claude/Codex 호출(P00 사고). 실제 provider 시험은 사용자 PC·서버에서 blocked/not_run으로 남긴다.
  - 삭제 거부 직후 실행 환경이 한동안 모든 Bash 명령을 거부했다. 지금은 다시 실행된다.
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
| PW-015 | in_review | (P02) | REQ-015 / TST-015A,B | unit 34, 통합 9, 브라우저 16(CDP 한글 IME), RED(구현 전·리뷰 전·재리뷰 전 코드), mutation 31종 중 30 탐지(1 동등), 독립 리뷰(major 1·minor 7)·재리뷰(minor 4·nit 3) 반영, 최종 확인 approve(nit 2 반영), `pnpm test` exit 0 | 실제 IME·Firefox/Safari(PW-022), 인용 입력 UI(PW-019), revision 누적(PW-021/P07), 복구본 기본값 켜짐 사용자 확인 |
| PW-016 | in_review | (P02) | REQ-016 / TST-016A,B | unit 9, 브라우저 8(CDP 한글 지시), RED(구현 전·이전 앱), mutation 7종 탐지, 독립 리뷰 approve(minor 3·nit 4 반영), `pnpm test` exit 0 | 서버 전송(PW-017/020), 단축키 설정, 해상도·실제 IME(PW-022) |
| PW-017 | in_review | (P02) | REQ-017 / TST-017A,B | unit 5, 통합 17, 계약 2, 브라우저 6, mutation 18종 탐지(1개는 시험 추가 후), 계약 RED, 독립 리뷰(major 1·minor 3)·재리뷰(approve, minor 1) 반영, `pnpm test` exit 0 | 제안 생성 AI(PW-020), undo(PW-021), 실시간 갱신·다른 탭 알림(PW-020/022), 재작성 의미 검사(PW-043/044) |
| PW-018 | in_review | (P02) | REQ-018 / TST-018A,B | unit 15, 통합 7, 브라우저 3, mutation 7종 탐지, 독립 리뷰·재리뷰·최종 확인(approve) 반영, `pnpm test` exit 0 | PDF highlight(PW-035), 실시간 공유, 문단 분할·병합 시 재연결 필요 |
| PW-019 | in_review | (P02) | REQ-019 / TST-019A,B | unit 10, 통합 8, 브라우저 2, mutation 8종 탐지, 독립 리뷰 approve(minor 2·nit 반영, RFC-008), `pnpm test` exit 0 | CSL/citeproc 고정(PW-056), 문헌 검색(P04), 연속 인용 묶기, 그림 파일(PW-036) |
| PW-020 | in_review | (P02) | REQ-020 / TST-020A,B | unit 15, 통합 15, 브라우저 4, mutation 16종 탐지, 독립 리뷰(major 1·minor 1·nit 4) 반영, `pnpm test` exit 0 | 실제 provider(P03, blocked/not_run), SSE polling 부하, 프록시 버퍼링·worker 서비스화(P07) |
| PW-021 | in_review | (P02) | REQ-021 / TST-021A,B | unit 16, 통합 9, 브라우저 3, mutation 17종 탐지, 독립 리뷰(major 1·minor 3·nit 6) 반영, `pnpm test` exit 0 | DOCX 가져오기(P05/P07), 표 편집, 문단 분할·병합 lineage, 원고 문서 유일성 제약(P07) |
| PW-022 | in_review | (P02) | REQ-022 / TST-022A,B | 브라우저 9(반복 27/27), 두 해상도 스크린샷, 찾은 제품 결함 4건(배경 재로딩 transaction, 탭 id 확보 전 입력 무시·Tiptap 옵션 재적용, 다른 탭 로그아웃 경쟁) 수정, 독립 리뷰(minor 2·nit 2) 반영, `pnpm test` exit 0 | 실제 IME·Firefox·Safari 수동 확인, 1 ms 간격 연속 키(ProseMirror 선택 동기화), 화면 배치(P07) |
| PW-023 | in_review | (P03) | REQ-023 / TST-023A,B | unit 19, 통합 1, mutation 16종 탐지, 독립 리뷰(minor 3·nit 2) 반영, `pnpm test` exit 0 | Claude·Codex 필드 경로 실측(PW-030), capability 설정 화면(PW-030) |
| PW-024 | in_review | (P03) | REQ-024 / TST-024A,B | unit 23(대역 CLI), 통합 2, mutation 22종 탐지, 독립 리뷰(MAJOR 1·minor 4) 반영, `pnpm test` exit 0. **TST-024A live: blocked/not_run**(사용자 PC 수동 smoke 스크립트 제공) | 실제 CLI live smoke, 커널 격리(PW-026), 잔여 프로세스 정리(PW-028), 서버 DB 기반 승인 근거(PW-030) |
| PW-025 | in_review | (P03) | REQ-025 / TST-025A,B | unit 27(대역 app-server), mutation 19종 탐지, 독립 리뷰(MAJOR 2·minor 5·PW-024 nit) 반영, `pnpm test` exit 0. **live: blocked/not_run**(바깥 sandbox·로그인 필요) | decline 응답·매개변수 실측(PW-030), 도구 호출 형태(PW-027), bubblewrap 검증(PW-026) |
| PW-026 | in_review | (P03) | REQ-026 / TST-026A,B | unit 18(unshare backend 실제 실행, bwrap argv 정적), mutation 26종 탐지, chroot 탈출 발견·수정, 독립 리뷰(MAJOR 1: abstract socket → 사설 network namespace + egress proxy, minor 5, nit 1) 반영, `pnpm test` exit 0. **bwrap 실행: not_run**(미설치) | CLI의 HTTPS_PROXY 준수 실측(PW-030), 공급자 허용 목록(PW-028/030), 커널 공격면 |
| PW-027 | in_review | (P03) | REQ-027 / TST-027A,B | 통합 11, contract 2(ajv와 검증기 일치), mutation 16종 탐지(시험 공백 2건 보완), `pnpm test` exit 0. **실제 CLI의 MCP·tool call 실측: not_run** | worker 연결(token 발급·socket·폐기, PW-028/030), MCP·Codex tool call 형식 실측(PW-030) |
| PW-028 | in_review | (P03) | REQ-028 / TST-028A,B | 통합 12, unit 2, 브라우저 2(새로고침·오프라인 재연결), mutation 17종 탐지, 독립 리뷰(MAJOR 1: 취소 뒤 gateway 제안 → run token을 fencing에 묶음, MINOR 2) 반영, `pnpm test` exit 0(첫 실행의 PW-015 1회 실패는 18회 반복에도 재현 안 됨, 원인 미확인). **실제 provider 연결: not_run** | adapter interrupt·sandbox 연결(PW-030), bwrap 안쪽 종료 확인, 원고 화면 진행 표시 재부착(PW-054) |
| PW-029 | in_review | (P03) | REQ-029 / TST-029A,B | 통합 7, unit 2, 브라우저 1, mutation 10종 탐지(1종 같은 동작), `pnpm test` exit 0. 구현을 시험보다 먼저 씀(기록) | 실제 이벤트 기록 연결(PW-030), 예산 예약(PW-050), 실행 중 갱신(PW-054) |
| PW-030 | in_review | (P03) | REQ-030 / TST-030A,B | gate unit 5(보고서↔등록부), 대역 Codex 연쇄 통합 3, 정직하지 않은 보고서 7종 거부, `pnpm test` exit 0. **실제 Claude·Codex: not_run**(수동 스크립트 제공) | RFC-010(provider를 sandbox 안에서, worker 연결), live smoke(사용자 PC) |
| PW-031 | in_review | (P04) | REQ-031 / TST-031A,B | 통합 16(대역 서버·합성 fixture), mutation 12종 탐지(시험 공백 2건 보완), `pnpm test` exit 0. **실제 Crossref·PubMed: not_run**(수동 계약 스크립트) | OpenAlex(조건 미확인), 다중 worker 출처 한도(PW-049/050) |
| PW-032 | in_review | (P04) | REQ-032 / TST-032A,B | 통합 16(리뷰 반영 +9), mutation 25종 탐지(+동치 1), `pnpm test` exit 0 | Crossref `updated-by`(PW-031 리뷰), 철회 인용 경고(PW-036/058) |
| PW-033 | in_review | (P04) | REQ-033 / TST-033A,B | 통합 18(리뷰 반영 +6), 브라우저 1, mutation 30종 탐지, `pnpm test` exit 0 | MOCK assessor만(실제 provider는 RFC-010 뒤), 본문을 읽은 문체 평가는 PW-034/035 뒤 |

독립 리뷰: 2회 (`reports/phases/P00_REVIEW.md`). Gate: `reports/phases/P00_GATE.md`.
P01 gate: `reports/phases/P01_GATE.md` — **사용자 승인 대기** (P02는 승인 전 시작하지 않음).

미해결 RFC:
- RFC-003 (승인 전 보수적 교정): proposed (리뷰 후 되돌림)
- RFC-001/002/004/005: accepted
- RFC-006 (P01 write scope 보완): accepted (delegated) — P01 gate에서 사용자 확인

## 작업 후 기록 양식
Task ID / 상태 / git commit(있는 경우) / REQ·TST / 실제 실행 명령과 결과 / 미실행 / 검토 결과 / 사용자 승인 / 다음 작업 / 미해결 RFC.

Phase 승급은 Gate 보고서와 사용자 승인 후 기록한다. pack validator의 PASS는 제품 테스트 PASS가 아니다.
