# 03. Storyline / Outline first

## 사용자 작업 흐름
Paper 생성 → 연구 질문·자료 정리 → AI와 story 대안 비교 → 연구자 story 승인 → detailed outline → 연구자 범위별 승인 → 문단 생성·편집 → review → named snapshot/export. 선형 wizard를 강제하지 않되 새 원고 생성의 서버 gate는 유지한다.

## 세 층의 작성 의도
1. Paper Brief: 연구 목적, 대상 독자, article type, 알려진 사실, 부족한 자료, 피해야 할 주장.
2. Storyline: 핵심 질문·메시지·근거 연결·경쟁 설명·결과 제시 순서·현재 증거의 한계.
3. Detailed Outline: Section → subsection → paragraph plan. 각 문단이 어떤 역할을 하고 어떤 주장·자료를 써야 하며 무엇을 쓰지 말아야 하는지 기록.

AI는 story 후보를 생성·비교하고 빈 근거와 논리의 비약을 표시할 수 있다. 다만 논문의 목적을 바꾸거나 그럴듯한 방향으로 결과를 맞추지 않는다. 데이터가 원래 가설과 맞지 않으면 대안과 한계를 제시하고 사용자 결정을 받는다. Writing Reference를 찾았다고 자동으로 연구 질문·논리 순서를 바꾸지 않는다.

## 상태
Story/Outline: DRAFT → IN_REVIEW → APPROVED → SUPERSEDED. 새 revision은 이전 승인본을 자동 폐기하지 않는다. approved snapshot은 immutable. 논문은 active_outline_revision을 별도 선택한다.

Outline node: DRAFT, READY_FOR_APPROVAL, APPROVED, EVIDENCE_MISSING, IMPACT_REVIEW_REQUIRED. AI generation 요청 시 paper_id와 active approved version, 관련 node 승인·필수 evidence 상태를 server-side로 검증. parent story 변경과 관련 claim 변경에 대한 impact_review가 해소되지 않은 node는 새 생성 차단. 관계 없는 문단의 문법 편집까지 막지는 않는다.

## 변경 영향
outline reorder, claim 변경, figure version 변경, evidence 철회, writing profile 갱신을 DependencyLink로 기록한다. 변경된 source를 참조하는 문단·abstract·caption·review response를 표시한다. 데이터 변경 → 전 논문 자동 재작성 금지. 사용자가 영향 범위를 보고 proposal 생성을 승인한다.

## 자유 집필과 기존 원고
수동 입력·메모·자료 수집은 개요 승인 전에도 가능하다. 기존 DOCX/텍스트는 원본을 보존해 가져오고 AI가 reverse outline 초안을 제안한다. 사용자가 승인하기 전 기존 문서를 삭제·잠금·재작성하지 않는다. 자유 노트에서 정식 원고로 옮길 때 provenance/개요 연결을 요청하되, 사용자가 직접 작성한 내용을 기계적으로 삭제하지 않는다.

## 예시 계약
Results paragraph: “실제 관측한 군집 차이만 설명”; 근거 table-2-r3, figure-1b; 금지: 통계적으로 뒷받침되지 않은 차이 단정/인과 표현; word budget 100–150은 편집 목표이지 무조건 채울 목표가 아님. 예시 수치는 합성 데이터다. 각 프로젝트 값은 실제 자료에서 지정한다.

## approval UX
비어 있는 필수 field와 근거 누락을 한곳에 표시. 승인 버튼은 문서와 근거 snapshot을 명시한다. chat의 ‘좋다’처럼 모호한 표현만으로 핵심 승인 상태를 바꾸지 않는다. 서버 승인 endpoint는 사용자 UI intent와 exact revision을 요구한다.
