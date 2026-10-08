# Coding-agent operating guide

이 프로젝트는 SDD를 상위 계획으로, TDD를 구현 방식으로 사용한다. 코딩 모델에게 “좋은 논문 플랫폼을 알아서 완성해”라고 한 번에 맡기지 않는다.

## 승인 수준
설계 검토 승인과 코드 작성 승인을 구분한다. P00는 위험 검증 phase이고 이 phase도 외부 호출/설치/파일 쓰기는 명시 허용범위에서만 한다. Task는 완료 후 in_review에서 멈춘다. Phase gate 후 사용자 승인으로 다음 phase.

## 선택적 개발 도구
Superpowers/ECC/gstack 등의 workflow skill은 이미 사용자가 설치했고 정확한 동작·범위가 확인될 때만 보조로 사용한다. 본 프로젝트가 특정 skill 설치를 요구하거나 해당 도구가 권한/테스트 검증을 대신한다고 가정하지 않는다. Codex 독립 review는 읽기 전용 세션/별도 worktree에서 수행할 수 있으나 사용자 기존 분석 세션은 재사용하지 않는다.

## Task 범위 조정
처음 규모 추정이 너무 크면 REQ/AC를 보존하며 A/B 하위 Task로 분할한다. 동일 공용 schema나 migration 파일을 여러 agent가 동시에 수정하지 않는다. 기본 작업 순서는 보수적으로 직렬이며 안정된 read-only 작업만 제한적으로 병렬화한다.

## 통과 증거
문서·screenshot·test log는 각자 역할이 있다. UI는 브라우저 상호작용, DB는 실제 PostgreSQL transaction, provider는 실제 허용 계정 smoke, 과학 품질은 fixture+사람 평가, 운영은 복원 실습으로 확인한다. pack checker나 빌드 성공 하나로 모두 통과시키지 않는다.

## P00의 선택지
provider 인증이 확정 안 돼도 Mock 기반 manual/outline/editor 개발은 진행 가능하다. 단, 유료/구독 runtime 완료 여부는 별도 blocked로 남는다. 사용자에게 동의 없이 API 과금으로 바꾸지 않는다. 에디터/export spike가 실패하면 렌더러 지원범위를 줄이거나 ADR을 수정한 뒤 기반 schema를 확정한다.
