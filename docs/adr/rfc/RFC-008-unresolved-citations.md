# RFC-008 — 확인되지 않은 인용의 경계: 제출 차단과 AI 인용 범위
Status: accepted (delegated, 2026-10-09)
Trigger task: PW-019 (독립 리뷰 minor 2)
Affected requirements/specs/contracts: REQ-019-B, REQ-042(Writer), REQ-058(제출판 확정); docs/specs/10_EXPORT_AND_REVIEW.md, 06_SCIENTIFIC_WRITING.md

Problem and evidence:
- PW-019는 이 논문의 문헌이 아닌 `referenceId`를 가진 인용을 원고에서 지우지 않는다(붙여넣기·가져오기 보존).
- 대신 번호를 주지 않고, 참고문헌에서 빼고, 경고한다.
- 이것이 "확정 citation으로 저장되지 않는다"(TST-019B)를 끝까지 만족하려면 두 가지가 더 필요하다.
  - 제출판에 들어가지 않을 것
  - AI가 그런 인용을 만들지 않을 것
- 둘 다 아직 Task의 인수 조건이 아니다.

Proposed change:
- REQ-058(제출판 freeze) 추가 인수 조건
  - 미해결 인용(`references-render`의 `unresolved_citations`)이나 미해결 그림/표 참조가 하나라도 있으면 제출판 확정을 거부한다.
  - 거부할 때 목록을 보여 준다.
- REQ-042(ParagraphContract·Writer) 추가 인수 조건
  - AI가 만드는 문단의 인용은 그 논문의 `project_references`(제거되지 않은 것) id만 쓸 수 있다.
  - 그 밖의 id나 서지 문자열은 제안 단계에서 거부한다.
  - 현재 PW-017 guard는 선택 범위 교정에서 인용 추가·변경을 모두 거부한다.

Alternatives considered:
- 저장 시 모르는 id 거부: 붙여넣기·가져오기 내용이 사라지거나 자동 저장이 막힌다.
- 모르는 id를 자동 삭제: 사용자 내용을 몰래 바꾼다.

Security/privacy/budget/provider terms impact: 없음.
Data migration / backward compatibility: 없음.
Tests and acceptance criteria:
- PW-058: 미해결 인용이 있는 원고의 제출판 확정 거부 시험
- PW-042: 다른 논문·없는 reference id를 인용한 AI 문단 제안 거부 시험
Write scope: 해당 Task(PW-042, PW-058)의 시험·구현 범위 안
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- PW-019 독립 리뷰의 제안을 따랐다.
