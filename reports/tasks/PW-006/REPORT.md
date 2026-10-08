# PW-006 — P00 검토·ADR·버전 고정안 — 보고서

상태: **in_review**
일자: 2026-10-08

## 변경 파일
- `docs/adr/P00_DECISION_RECORD.md` — compatibility matrix(measured/documented/unknown/blocked 구분), ADR-001~012 상태 제안, 신규 ADR-013(MCP gateway)·014(전용 OS 사용자)·015(effort 정책), RFC 요약, 버전·라이선스 후보, CONDITIONAL GO 판정, 사용자 승인 항목.
- `docs/adr/rfc/RFC-001 … RFC-005` — RFC_TEMPLATE 필드 준수.
- `tests/tasks/PW-006/gate.test.mjs` — 4개 테스트.
- 공통 예외: `PROGRESS.md`, P00 Task 상태(`tasks/TASK_MANIFEST.json`, `tasks/tasks.csv`, `tasks/PW-00[1-6].md`)를 `in_review`로 갱신.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-006-A matrix, ADR, license/version pin, go/no-go, 사용자 승인 항목 | TST-006A ×2 (결정 기록 필수 장·라이브러리·License, RFC 템플릿 필드·상태) | pass |
| REQ-006-B 미검증을 검증됨으로 보고 금지, 승인 전 scaffold 금지 | TST-006B ×2 (registry에 verified/approved 없음 + matrix에 provider verified 없음 + CONDITIONAL GO, apps/packages/db/infra/package.json 부재) | pass |

- RED: 3 fail / 1 pass(scaffold 부재는 처음부터 참) — `red.log`
- GREEN: 4/4 — `green.log`

## 회귀
- P00 전체: `node --test --test-timeout=30000 'tests/tasks/PW-00*/*.test.mjs'` → 48/48 pass, skip 0 (`p00-regression.log`).
- `python3 -I scripts/validate_pack.py` → PASS. 이것은 계획 문서 정합성 검사이지 제품 테스트가 아니다.
- 참고: `MANIFEST_SHA256.json`은 원본 pack의 무결성 기록이다. 이번에 `PROGRESS.md`와 task 상태 파일을 수정했으므로 해당 항목의 hash는 원본과 다르다(의도된 변경이며, validator는 이 파일을 검사하지 않는다).

## 버전 고정에서 주의할 점
- 다음은 최근 2주 내 릴리스다: React 19.3.0, Vite 8.3.3, pg-boss 12.37.0, Playwright 1.64.0. → PW-007에서 직전 안정 버전을 우선 검토한다.
- TypeScript 7.x는 메이저 전환이다. PW-007에서 Vite/Vitest/Tiptap 호환을 확인한 뒤 5.x/6.x/7.x 중에서 결정한다.
- pandoc은 GPL이다. 라이브러리로 링크하지 않고 별도 프로세스로만 실행한다.

## 다음
독립 review 결과를 반영해 `reports/phases/P00_GATE.md`를 작성하고 사용자 승인을 기다린다. P01을 자동으로 시작하지 않는다.
