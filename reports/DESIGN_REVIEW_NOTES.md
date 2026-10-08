# Design review notes — planning pack only

검토일: 2026-10-08

## 반영한 수정
- 개발용 Claude Code와 제품 실행용 provider의 인증·계정·세션을 명확히 분리.
- 기존 대화에서 일반화한 구독 재사용과 quota 조회를 capability/admission gate로 교체.
- 미승인 outline의 AI 새 집필만 차단하고, 메모·수동 편집·기존 원고 import는 허용.
- context 요약과 실제 논문 정본·사용자 승인 상태를 분리.
- 사용량 재개는 proposal 생성까지이며 오래된 사용자 적용 승인을 재사용하지 않음.
- 다중 탭·stale proposal·중복 적용·lease 만료·cancel 이후 늦은 응답에 대한 실패경로 반영.
- P01 scaffold 및 각 Task의 전용 migration 수정범위를 보완.
- Word round-trip, Tiptap Pro 기능, PDF 라이선스, GROBID 추출 깊이의 지원 한계를 명시.
- task/test ID는 계획된 검증이며 제품 기능 테스트 완료가 아님을 모든 주요 문서에 표시.

## 아직 검증하지 않은 것
로컬 provider/SDK 버전, 실제 계정의 허용 인증, subscription quota 관측, OS sandbox, 실행 성능, export rendering, 실제 연구자의 문체 선호 평가, production restore.

## 계약 범위
contracts/는 첫 수직 경로의 시작 schema다. 전체 OpenAPI/DB DDL/실제 ProseMirror schema는 P00 결과를 반영해 P01에서 구현해야 한다. partial schema를 운영 완제품으로 사용할 수 없다.

## 남은 사용자 결정
배포/인증/과금 방식, 운영·백업 경로, 외부 전송 정책, 목표 저널과 평가용 문헌. 안전한 기본값으로 계획을 진행할 수 있으나 미확정 runtime은 disabled/blocked로 남긴다.
