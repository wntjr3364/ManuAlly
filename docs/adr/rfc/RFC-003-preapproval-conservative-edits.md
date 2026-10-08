# RFC-003 — 개요 승인 전에도 사용자가 쓴 문장의 보수적 AI 교정은 허용
Status: proposed
Trigger task: PW-006
Affected requirements/specs/contracts: REQ-010, REQ-016, REQ-017; docs/specs/03_STORY_AND_OUTLINE.md, 04_EDITOR_AND_INTERACTION.md
Problem and evidence:
Constitution은 "AI의 새 원고 생성"에 승인된 Story/Outline을 요구하고, 수동 편집은 막지 않는다. 하지만 사용자가 직접 쓴 문장을 드래그해 문법·간결화 교정을 받는 것이 승인 전에 허용되는지는 명시돼 있지 않다.
Proposed change:
- 승인 전 허용 범위: 사용자가 쓴 텍스트에 대한 replace_selection의 conservative 모드(문법, 간결화)만. PW-003 보호 규칙(인용·숫자·atom 불변)을 적용한다.
- 승인 전 금지: 새 문단 생성, 학술적 재작성(Scientific Rewrite), 구조 변경, 주장 추가. 서버가 intent별로 gate를 건다.
- 문서에 "승인 전 교정" 표시를 남기고, 개요 승인 후 impact review 대상이 아님을 기록한다.
Alternatives considered:
- 승인 전 모든 AI 기능 금지: 사용자 불편이 크고 Constitution의 의도(새 생성만 차단)를 넘는다.
- 모두 허용: 개요 우선 원칙을 무력화한다.
Security/privacy/budget/provider terms impact: 외부 전송 정책은 동일하게 적용한다.
Data migration / backward compatibility: 없음.
Tests and acceptance criteria: 승인 전 conservative 교정은 proposal 생성, 승인 전 rewrite/new paragraph는 서버가 거부, 숫자·인용 변경 시 거부.
Write scope: PW-016, PW-017 테스트에 추가.
User decision / reviewer:
- 처음에는 사용자 위임으로 accepted 처리했다.
- 독립 리뷰 M2(guard가 그룹값 교환·부등호·단위·부정어·위첨자·인용 locator 변경을 통과시킴)를 반영해 **proposed로 되돌렸다**.
- guard는 bf76f80에서 강화했지만 영어 중심 휴리스틱이므로, P00 gate에서 사용자가 직접 승인해야 한다.
