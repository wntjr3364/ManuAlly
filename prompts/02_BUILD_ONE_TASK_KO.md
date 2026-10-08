이번 구현 대상은 [TASK_ID를 실제 ID로 바꿔 입력] 하나뿐이다.
CLAUDE.md, PROGRESS.md, tasks/해당-ID.md 및 지정된 spec/contract/기존 코드와 테스트를 읽어라.

선행 작업·phase gate 승인·provider admission·실행 예산을 먼저 확인하라. 미충족이면 blocked를 명시하라. 전체 문서/전체 세션 로그를 불필요하게 컨텍스트에 넣지 마라.

인수조건을 failing tests로 만들고 RED를 실제 확인한 다음 최소 구현 → GREEN → refactor → regression을 수행하라. 정책·live provider·사람 판단은 자동시험과 별도로 실제 증거 또는 not_run을 기록하라.

write_scope 밖 변경, 새 의존성, shared schema/DB migration/인증·과금 모델 변경은 승인된 RFC 없이 진행하지 마라. secret·실제 미공개 원고를 test fixture로 사용하지 마라. 외부 AI는 명시 승인 계정·budget 안에서만 호출하라.

완료 후 변경 파일, REQ/AC/TST, 실행 명령·exit code·결과, 미실행, 실패경로/복구 검증, 남은 위험을 보고하고 PROGRESS와 Task 상태를 in_review로 갱신하라. 테스트 삭제/skip으로 통과시키거나 다음 Task를 자동 시작하지 마라.
