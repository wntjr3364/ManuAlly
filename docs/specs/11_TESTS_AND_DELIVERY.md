# 11. SDD + TDD + evidence-based delivery

## 작업 방식
REQ → acceptance criterion → failing test → 최소 구현 → 단위/계약/통합/E2E → 독립 review → 사용자 phase gate. 여러 관련 없는 subsystem을 한 task에 넣지 않는다. 현재 Task write_scope 밖 구조변경·spec 수정·공급자 policy 변경은 RFC. 더 작게 쪼갤 때도 requirement/test 연결은 유지.

## 테스트 층
Unit/property: editor transaction·protected spans·Fact matcher·schema·state machine·budget·time normalization.
Contract: provider versioned event fixtures, explicit session/resume, quota missing, partial JSON, refusal, tool failure, usage cumulative semantics.
Integration: 실제 PostgreSQL transaction/CAS/FK/outbox/job dedup, blob manifest, restore, migrations.
Browser: 실제 selection → short chat → diff → apply → undo → reload, Korean IME, duplicate paragraph, multi-tab conflict, PDF highlight and citation.
Scientific: synthetic hard fixtures + 권리 확인한 수동 blind rubric. 구조/사실 검사와 문체 판단을 구분.
Security/fault: cross-project read/write, prompt injection, key logging, symlink, SSRF, stale worker, SIGTERM/process death, disk full, network loss, quota reset unknown, orphan anchor.

## first complete slice
Paper 생성 → Story와 Outline 수동 작성·승인 → 검증된 사실·reference 등록 → Mock 또는 승인된 실제 provider가 문단 proposal → 웹에서 선택 수정 → CAS 적용 → undo/새로고침 → DOCX 샘플 출력. 이 수직 경로를 먼저 완성하고 확장한다. 실제 과금/인증 미승인 시 Mock 결과는 명확히 표기.

## 완료 기준
모든 필수 REQ에 자동 또는 수동 검증 증거. 모든 critical negative fixture 기대결과 통과. 불필요한 skip/xfail 금지. live provider smoke 미실행이면 해당 adapter는 미검증 disabled. export 렌더와 source manifest 검증. 새 환경 backup restore와 migration rehearsal 성공. 주요 workflow 사용자가 직접 검토. coverage 숫자만으로 대체하지 않음.

## 독립 review
Codex 또는 별도 Claude 세션이 read-only로 actual diff/test evidence 검토. 리뷰어가 구현자의 요약을 정답으로 받지 않음. 오류 수정은 별도 task에 반영. reviewer agent가 자기 판단으로 승인/merge/production 배포하지 않음.

## 개발용 컨텍스트
초기 전체 패키지를 반복 읽지 않음. START_HERE, CLAUDE, PROGRESS, 현재 task, task에 연결된 specs/contracts만. 완료 후 tests/run evidence와 next action 기록. compact 후 파일의 실제 상태와 git diff 재확인. 이전 대화가 완료를 선언했다는 이유로 진행 상태 변경 금지.

## 검증 명령 관리
P01 scaffold에서 lint/typecheck/unit/integration/e2e/contracts/evals/pack-check 명령을 실제 등록한다. 명령명이 문서에 있다고 실행 가능하다고 주장하지 않음. 보고서는 실행 명령·exit code·핵심 log·artifact 경로와 not_run 이유를 포함. screenshot만으로 기능을 검증하거나, API unit test만으로 브라우저 동작 완료를 주장하지 않음.
