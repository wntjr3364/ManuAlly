# 00. Product scope and decisions

## 사용자 확정 요구
논문 한 편 = PaperProject. Scivo UI를 따를 필요 없음. 논문 안에서 manuscript 버전별 확인·비교·복원. 집필 전에 storyline·상세 outline을 충분히 설계하고 연구자가 승인. AI가 보고서식 장문을 쏟아내지 않고 실제 좋은 학술 논문을 참고. 참고할 논문의 탐색·선정·정리도 AI가 보조. 웹 채팅에서 답변·원고 수정이 완결. 선택영역 드래그·하이라이트·comment·짧은 AI 채팅. Claude Code/Codex 연동, 프로젝트별 별도 세션, 기존 작업폴더와 세션 보호. context를 정리·압축·재개하며 quota 소진 시 안전하게 대기·재개.

## 이 계획에서 제안하는 기본값 — 사용자 확정 사실과 구분
개인 단독 사용, 자체 호스팅, 한국어 UI/지시와 영어 원고, 다중 PaperProject, TypeScript 중심 monorepo, PostgreSQL 정본, 사용자 승인 중심 수정. 제품명은 가칭. 첫 버전은 PC 브라우저 우선. 기존 원시 연구자료는 수정하지 않고 검증된 결과표·그림·설명만 논문 증거로 가져온다.

## v1 필수
수동으로도 완결되는 paper/outline/editor; 승인 gate; reference/evidence와 citation/figure 객체; 작업·버전 이력; 웹 AI 선택 편집; Claude와 Codex adapter(허용된 인증모드); context/checkpoint/quota 운영; 문헌 자동 후보 선정; writing profile/과학적 검토; DOCX/PDF 및 machine-readable archive; backup/restore·보안·관측·평가. 실제 인증 미확인인 provider는 disabled 상태로 명시하고 전체 v1 완료로 숨기지 않는다.

## v1 범위 밖
동시 공동편집 CRDT, 실시간 커서, 외부 공동저자 계정 초대, 다중 사용자 SaaS, Zotero 양방향 동기화, 완전한 Word Track Changes round-trip, 모든 저널 템플릿, 자동 투고·이메일 전송, 원시 NGS/통계 파이프라인 실행, AI figure 생성, fine-tuning, 자율 다중에이전트 무한 반복. 이후 기능은 RFC와 별도 phase로 추가한다.

## 완료의 의미
그럴듯한 UI·mock 답변·문서 작성만으로 완료 아님. 한 개의 합성 생물학 논문과 한 개의 software/resource 유형 fixture로 전체 workflow가 동작하고, 실제 사용자 논문은 별도 동의하에 제한된 pilot을 수행한다. 과학적 진실·저널 채택·“AI 탐지 회피”는 제품이 보장하지 않는다.
