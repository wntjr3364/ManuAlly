# P06 Gate — 문맥·한도·내구성·재개 (PW-047 ~ PW-054)
작성: 2026-10-10 · 상태: **P06 구현 완료(PW-047~054 독립 리뷰 approve), 사용자 위임에 따라 진행 — 실제 공급자 한도·문맥 값과 실제 장애(전원·파일시스템)는 아직 확인하지 않음**

## 사용자 결정
- 사용자 지시(2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라". 이 gate의 결정은 위임에 따라 권장안으로 기록한다. 사용자는 언제든 되돌릴 수 있다.
- 위임으로 정한 항목
  1. RFC-013(P06 write scope 연결 파일) 채택. Task별 부록에 모두 기록했다(공유 job guard 변경 2건 포함: PW-049 대기 전환, PW-052 미룬 실행).
  2. 재개는 모델 없이 DB checkpoint와 정본에서 다시 만든다. AI 요약은 검증되지 않은 메모이고 승인·사실·완료의 근거가 아니다.
  3. 자동 재개는 사용자가 작업마다 1~72시간 허락할 때만 한다. 재개된 실행도 제안까지만 만든다. 원고 적용은 사용자 행위다.
  4. 공급자 과금은 at-least-once로 보고한다. 정확히 한 번이라고 말하지 않는다.
  5. 디스크 포화는 재시도하지 않고 안전하게 멈춘다. 로그인 문제(401/403)는 한도로 보지 않고 재시도하지 않는다.
- 다음 phase(P07) 착수는 위임에 따른다.

## 사용자가 직접 해야 하는 일 (위임할 수 없음)
- **실제 공급자 live smoke**(사용자 PC·연구실 Linux, 각자의 Claude Code·Codex 로그인)
  - 한도 메시지, 401 메시지, 초기화 시각, 문맥 보고 값이 분류·표시와 맞는지 본다.
  - 맞지 않는 문구는 unknown(FAILED, 재시도 없음)으로 떨어진다(안전한 쪽).
- **자동 재개 허락**은 작업마다 사용자가 한다. 기본은 허락 없음이다.
- 예산을 쓰려면 예산을 직접 정한다(API만 있음, 화면 없음).

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-047 | checkpoint(호출 전, 검증 뒤, 제안 저장)와 재수화. 바뀐 것은 재개를 멈춤 | 통합 13, mutation 29(+동등 2) | approve(재리뷰) |
| PW-048 | 문맥 예산: 마지막 요청 기준, 0.7 검토, 0.8 교체, 모르면 unknown | 통합 21, mutation 34 | approve(재리뷰) |
| PW-049 | 한도 대기: DB 대기, 초기화와 지터, 재검사, 자동 재개 허락(1~72h) | 통합 16, mutation 29(+동등 1) | approve |
| PW-050 | 비용 예산: 실행 전 예약, 정산, unknown은 차단, 실행 5회 상한 | 통합 19, mutation 38 | approve |
| PW-051 | lease fencing, 경합, outbox 회복, at-least-once 과금 보고 | 통합 13, mutation 15 | approve |
| PW-052 | 오류 분류와 bounded retry, circuit breaker(미룸, 시도 소모 없음) | unit 31, 통합 17, 브라우저 1, mutation 34 | approve(재리뷰; MAJOR circuit 반영) |
| PW-053 | 장애 주입: 실제 SIGKILL(호출 중, commit 안), DB 53100, ENOSPC, 문서·승인 변경, 취소 | 통합 13, mutation 7 | approve(결함 2건 수정: 디스크 포화 재시도, 호출 중 계획 변경) |
| PW-054 | 실행 제어 패널, 다시 시작(사용자 행위), unknown 표시, 자동 재개는 제안까지 | unit 7, 통합 9, 브라우저 1, mutation 18 | approve(MINOR 반영: 잠금 순서, 다음 행동, 패널 갱신) |

최종 회귀: `reports/tasks/PW-054/pnpm-test.log`(아래 PW-054 REPORT에 결과).

## 운영 reliability 확인 (spec 08·12)
| 조건 | 상태 | 근거 |
|---|---|---|
| AI 대기·실패 중에도 수동 편집 | 확인 | PW-054 통합·브라우저(대기 중 저장 "저장됨", 자료 열람) |
| 화면 상태 = DB 상태 | 확인(범위 있음) | PW-054 브라우저(대기, 다시 시작, 중지가 DB와 일치, 새로 읽어도 같음), PW-028. 목록은 진행 중 2초, 열린 패널은 5초마다 다시 읽는다. 그 사이의 값은 마지막으로 읽은 값이다 |
| unknown을 0으로 보이지 않음 | 확인 | PW-029, PW-054 unit·통합 |
| 저장 실패를 성공으로 보이지 않음 | 확인 | PW-015 브라우저, PW-053(DB 포화 시 500, 결과 저장 실패는 FAILED "not stored") |
| 오래된 worker가 쓰지 못함 | 확인 | PW-051 fencing, PW-053 SIGKILL 뒤 회복 |
| 취소가 되살아나지 않음 | 확인 | PW-053(회복, 재배달, sweep 뒤에도 CANCELLED) |
| 자동 재개가 원고를 바꾸지 않음 | 확인 | PW-049, PW-054(재개 실행 뒤 제안 PENDING, 원고 그대로) |
| 계정 문제에서 반복 호출 없음 | 확인 | PW-052(401/403은 WAITING_AUTH, 호출 1번) |
| 반복 장애 시 호출 멈춤 | 확인 | PW-052 circuit breaker(미룸 6번 뒤 FAILED, 호출 없음) |
| 실제 전원 차단, FS 포화, PG 서버 사망 | **미확인** | sudo 없는 조건에서 시험하지 않음. DB 내구성은 PostgreSQL과 백업(P07)에 맡김 |
| 운영 관측 화면(반복 실패, orphan, backup age, disk pressure) | **없음** | P07 범위(PW-059 보안 audit, PW-060 백업 drill, PW-061 운영 runbook) |

## 다음 phase로 넘기는 위험 (확인만)
- **문맥 예산 고리(PW-048 `runJobTurns`)는 아직 어떤 handler에도 연결되지 않았다.** 지금 Writer는 한 번 호출이라 문맥 교체가 일어나지 않는다. 패널의 문맥 줄은 늘 "알 수 없음"이다. 여러 차례 대화하는 handler를 만들 때 연결해야 한다.
- **자동 재개는 알려진 초기화 시각이 지난 대기에서만 일어난다.** worker의 가용성 probe가 늘 "모름"을 답한다(확인된 공급자 가용성 확인이 없음). 초기화 시각을 모르는 대기는 사용자가 다시 시작한다.
- **모든 AI 경로가 MOCK 기준이다.** 실제 CLI의 오류 문구, 한도 보고, 문맥 값은 합성 fixture로만 시험했다.
- 다시 시작은 시도 횟수를 되돌리지 않는다. 예산 화면이 없다.
- circuit breaker는 잠금 없이 DB 기록으로 판단한다(동시 worker가 한 번씩 더 부를 수 있음). 앱 시계와 DB 시계를 섞는다(같은 호스트 전제).
- DB 전체 포화(WAL 포함)에서는 "재시도 없음"이 성립하지 않을 수 있다. lease 회복으로 at-least-once 재생성된다.
- 회복 sweep은 local worker 고리에서 돈다. pg-boss 배치를 쓰면 같은 sweep을 따로 돌려야 한다.
- **이전 phase에서 넘어온 항목은 아직 열려 있다.** 실제 IME, Firefox/Safari, 배포, 실제 provider, 외부 서지 서비스 live, 사람 blind rubric, PW-015 브라우저 일회성 실패.

## 다음
P07(PW-055~062): DOCX import·손실 보고, DOCX·CSL export, PDF·재현 source archive, 제출판 freeze, 보안 release audit, 백업·복구·migration drill, 배포 runbook, v1 최종 pilot·추적성 gate.
