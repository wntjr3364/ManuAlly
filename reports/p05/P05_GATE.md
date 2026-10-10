# P05 Gate — 과학 글쓰기 엔진 (PW-039 ~ PW-046)
작성: 2026-10-10 · 상태: **사용자 위임에 따라 진행 — 실제 AI 공급자 실행과 사람 blind rubric은 아직 하지 않음**

## 사용자 결정
- 사용자 지시(2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라". 이 gate의 결정은 위임에 따라 권장안으로 기록한다. 사용자는 언제든 되돌릴 수 있다.
- 위임으로 정한 항목
  1. RFC-012(P05 write scope 연결 파일) 채택. Task별 부록에 모두 기록했다.
  2. AI 결과는 모두 제안이다. 스토리 대안, 프로필, 문단, 검토 지적, 고쳐 쓰기 모두 사용자가 채택·적용해야 정본이 된다.
  3. 결정적 과학 gate(PW-043)의 "확인 안 됨"은 통과가 아니다. 실패는 AI 문단을 적용할 수 없게 한다.
  4. 품질 "통과"는 자동 선언하지 않는다. AI 탐지 점수와 자기평가는 쓰지 않는다. 사람 blind rubric과 사용자가 정한 수치 목표가 필요하다(PW-045).
  5. 논문 유형별 섹션은 제안일 뿐이다. 개요가 원고 구조를 정한다(PW-046).
- 다음 phase(P06) 착수는 위임에 따른다.

## 사용자가 직접 해야 하는 일 (위임할 수 없음)
- **사람 blind rubric**: 권리·외부 전송이 확인된 실제 문단 10개 이상과 평가자. 수치 목표는 사용자가 정한다(`evals/HUMAN_RUBRIC.md`, `evals/human-rubric.results.json`은 not_run).
- **실제 공급자 실행**: 사용자 PC·연구실 Linux에서 Claude Code·Codex 로그인으로 Writer·검토자·프로필 생성을 live smoke. 이 컨테이너에서는 자격증명이 없어 not_run이다.
- 결정적 판단 밖의 hard case 5개(그림 번호 글, 누락된 한계, hype, 종 이름, 출처와의 모순)는 실제 검토자와 사용자가 판단한다.

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-039 | 스토리 대안(MOCK): 수치는 기록에서만, 사용자 채택만 | 통합 16, unit 3, 브라우저 1, mutation 31 | approve |
| PW-040 | 개요 영향 추적: 근거가 바뀐 노드만 막고 사용자가 검토 | 통합 13, 브라우저 1, mutation 26 | approve |
| PW-041 | 글쓰기 프로필: 읽은 섹션만 근거, 복사 표시, 사용자 채택 | 통합 9, unit 8, 브라우저 1, mutation 32 | approve |
| PW-042 | ParagraphContract·Writer: 계약 밖 수치·인용 거부, 제안→적용(CAS·STALE) | 통합 12, unit 36, 브라우저 1, mutation 41 | approve |
| PW-043 | 결정적 과학 gate: 수치·단위·그룹·통계·n·인용·주장 강도 | unit 18, 통합 6, 브라우저 1, mutation 33 | approve |
| PW-044 | 검토 지적·사람 결정·한 번의 고쳐 쓰기 | 통합 12, 브라우저 1, mutation 24(+동등 1) | approve |
| PW-045 | hard case 30·human rubric gate: unsafe 0, release not_ready | unit 63, mutation 33 | approve |
| PW-046 | 유형별 섹션 제안, 개요로 원고 골격, 계획의 섹션에 문단 | 통합 7, 브라우저 2, mutation 13 | (리뷰 결과는 PROGRESS) |

최종 회귀는 `reports/tasks/PW-046/REPORT.md`에 적는다.

## 다음 phase로 넘기는 위험 (확인만)
- **모든 AI 경로가 MOCK 기준이다.** 실제 모델의 지시 준수·형식 오류율은 모른다. 형식이 다르면 거부되고 사용자에게 보인다.
- **release quality는 not_ready다.** 사람 평가가 없다.
- 과학 gate는 영어 중심 휴리스틱이다. 동의어·단위 변환이 없어 unknown이나 거짓 실패 쪽으로 기운다(안전한 쪽).
- 섹션 이름은 글자 일치다(번역·동의어 없음). 골격은 level-1 제목만 만든다.
- **이전 phase에서 넘어온 항목은 아직 열려 있다.** 실제 IME, Firefox/Safari, 배포, 실제 provider, 외부 서지 서비스 live, PW-015 브라우저 일회성 실패.

## 다음
P06(PW-047~054): checkpoint·영구 기억 재수화, context 예산, 할당량 대기, 비용 예산, lease fencing 등.
