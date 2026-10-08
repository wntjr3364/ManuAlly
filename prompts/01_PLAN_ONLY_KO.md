이 저장소의 START_HERE.md, CLAUDE.md, PROJECT_PLAN_KO.md, PROGRESS.md를 읽어라.
이번 요청은 설계 검토와 P00 준비만이다. 코딩·scaffold·패키지 설치·외부 AI 호출·기존 설정 변경을 하지 마라.

1. 사용자 확정 요구, 설계 기본값, 미정 결정, 실제 검증되지 않은 가정을 구분하라.
2. 특히 Claude/Codex 구독·API 인증·local/private hosted 이용조건을 확인하고, 허용 근거 없는 인증경로를 구현 전제에서 제외하라. 사용자 credential 파일을 읽거나 복사하지 마라.
3. 기존 연구 세션·작업폴더·HOME/config·운영 데이터가 보호되는지 검토하라.
4. Paper 정본/outline 승인/AI proposal 적용/버전/컨텍스트·quota 복구 사이의 모순을 찾아라.
5. Python scripts/validate_pack.py로 패키지 자체를 검증하라. 이것이 웹앱 테스트가 아님을 구분하라.
6. P00에서 확인할 실제 로컬 버전·환경·자료·승인·비용 항목과 PW-001의 실행 계획을 제시하라.
7. 계획의 요구사항을 임의 삭제하거나 스택을 조용히 바꾸지 마라. 변경이 필요하면 RFC로 설명하라.

결과는 핵심 blocker, 수정이 필요한 설계, 결정이 필요한 사항, 첫 Task의 허용범위·시험으로 정리하고 멈춰라. 이후 모든 Phase를 자동 구현하지 마라.
