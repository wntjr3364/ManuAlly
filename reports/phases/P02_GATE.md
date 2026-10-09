# P02 Gate — 선택 편집과 Mock AI 경로 (PW-015 ~ PW-022)
작성: 2026-10-09 · 상태: **사용자 위임에 따라 진행**

## 사용자 결정
- 사용자 지시(2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라"
  - Task마다 독립 리뷰를 거친다.
  - in_review로 기록한다.
  - 다음 Task로 계속 진행한다.
- 이 gate의 결정은 위 위임에 따라 권장안으로 기록한다.
- 사용자는 언제든 이 기록을 보고 되돌릴 수 있다.
- 위임으로 정한 항목
  1. 복구본 임시 보관은 기본으로 켠다(PW-015).
  2. RFC-003 채택(범위 축소)
     - 개요 승인 전에는 질문과 사용자 글의 문법·간결화 교정만 허용한다. 학술적 재작성과 새 내용 생성은 막는다.
     - 교정은 diff로 보이고 사용자가 적용한다.
  3. RFC-007(P02 write scope 연결 파일) 채택. Task별 부록에 모두 기록했다.
  4. RFC-008 채택: 미해결 인용은 제출판 확정을 막는다(PW-058). AI 문단은 이 논문의 문헌만 인용할 수 있다(PW-042).
  5. 실제 provider(Claude Code·Codex) 시험은 이 컨테이너에서 blocked/not_run이다. P00 사건 이후 실제 호출을 하지 않는다. P03 adapter는 계약·mock·sentinel 수준으로 구현하고, 실제 호출은 사용자 PC에서 사용자가 승인해 실행한다.
- P02 완료. P03(PW-023부터) 진행.

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-015 | 자동 저장, 탭별 복구본, IME 안전, 로그아웃 처리 | unit 34, 통합 9, 브라우저 16 | 리뷰·재리뷰·최종 approve |
| PW-016 | 선택 도구 모음·짧은 요청(IME 안전, 단축키) | unit 9, 브라우저 8 | approve(minor 반영) |
| PW-017 | selection handle, 제안 guard(문단 전체 검사), CAS 적용·멱등 | unit 5, 통합 17, 계약 2, 브라우저 6 | 리뷰·재리뷰 approve |
| PW-018 | 코멘트 anchor(확실할 때만 연결, 아니면 ORPHANED) | unit 15, 통합 7, 브라우저 3 | 리뷰·재리뷰·최종 approve |
| PW-019 | 인용·그림/표 참조 노드, 번호 계산, snapshot 고정 | unit 10, 통합 8, 브라우저 2 | approve(minor 반영, RFC-008) |
| PW-020 | 선택 요청 job, 진행 이벤트 SSE, mock provider(MOCK 표시) | unit 16, 통합 15, 브라우저 4 | 리뷰·재리뷰 approve |
| PW-021 | 버전 비교·복원, AI 수정 되돌리기, 텍스트·Markdown 가져오기 | unit 18, 통합 9, 브라우저 3 | 리뷰·재리뷰 approve |
| PW-022 | 선택편집 브라우저 gate(해상도·키보드·복제·emoji·atom·두 탭) | 브라우저 8(5회 반복 통과) | 리뷰 진행 |

최종 회귀 `pnpm test` exit 0: unit 179, integration 195, contracts 15, e2e 76, spikes 70, evals·pack PASS.

## 다음 phase로 넘기는 위험 (확인만)
- **실제 IME·Firefox·Safari·macOS 단축키는 수동 확인이 필요하다.** 컨테이너에는 Chromium만 있다.
- **실제 provider 응답은 미검증이다(blocked/not_run).** mock은 결정론적 규칙만 쓰고, 화면에 늘 "MOCK · 실제 AI 아님"이 보인다.
- **SSE는 DB polling(250 ms)이다.** 동시 스트림이 많으면 부하가 생긴다. reverse proxy를 쓸 때는 버퍼링을 꺼야 한다(P07).
- **worker 상시 실행·서비스 등록은 P07에서 한다.** 지금은 `apps/worker` `dev` 스크립트를 따로 띄운다.
- **P01에서 넘어온 항목은 아직 열려 있다.**
  - 앱 DB 계정이 superuser다. runtime role 분리가 필요하다.
  - 공유 서버 loopback 노출은 P07에서 다룬다.
- **원고 문서 유일성 제약이 없다(PW-009부터).** 동시에 두 원고가 생길 수 있다. P07에서 정리한다.
- **화면 배치.** 1366×768에서 제안 패널은 스크롤이 필요하고, 선택 도구 모음의 위치를 개선해야 한다(P07 사용성).
