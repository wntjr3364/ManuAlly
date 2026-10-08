# 01. Architecture and boundaries

## 권장안: TypeScript 중심의 모듈형 단일 애플리케이션
UI: React + Vite + TypeScript. Editor: Tiptap OSS / ProseMirror. API: Fastify + TypeScript. DB: PostgreSQL + 명시 SQL migration. Queue: pg-boss(호환 버전은 P00 검증). Worker: TypeScript orchestration. Claude Agent SDK / Codex App Server는 provider adapter 뒤에 둔다. PDF 읽기: PDF.js. 구조 추출: GROBID 선택 서비스. Export: Pandoc + citeproc/CSL + sandboxed PDF engine. 테스트: Vitest + Playwright + 실제 PostgreSQL integration fixture.

Fastify는 공식 TypeScript·검증·테스트 문서를 제공하며 [S16], pg-boss는 PostgreSQL을 이용하는 Node queue다 [S17]. 기술 선택은 제안이다. Django/FastAPI를 기본으로 고집하지 않는 이유는 editor schema/patch 검증과 agent adapter의 TypeScript를 공유해 문서 변환 로직을 두 언어로 중복 구현하지 않기 위해서다. 생물학 분석을 실행하는 플랫폼이 아니므로 Python backend가 필수는 아니다.

## 배포 단위
`web/api` + `job worker` + `PostgreSQL` + `blobs`가 필수다. GROBID/export sandbox는 필요 시 profile로 실행. Redis, Kubernetes, 별도 vector DB, LangGraph, 상시 primary-agent는 초기 필수가 아니다. 개발과 테스트의 데이터 경로/DB를 운영과 분리한다.

## 논리 흐름
Browser → authenticated API → DB transaction + outbox → durable queue → orchestrator → isolated provider child → typed tool gateway → proposal store → browser diff → explicit apply API → revision transaction.

중요: orchestrator에는 DB 접근권한이 있을 수 있으나 provider child에는 DB credential이 없다. child environment는 whitelist로 새로 생성한다. 모델의 paper_id/role/승인 flag를 믿지 않고 run에 묶인 server identity로 권한을 정한다.

## 책임
- API: 권한·schema·version·승인·budget reservation, 정본 쓰기.
- Domain modules: paper/story/outline/document/evidence/literature/review.
- Worker: lease·checkpoint·provider orchestration·event 정규화. 모델 결과를 정본에 직접 쓰지 않음.
- Agent child: 승인 범위 snapshot과 tool gateway만 접근. 임의 shell·file tools 기본 차단.
- Queue: 실행 신호/재시도. Paper state의 정본 또는 문서 commit 여부 판단자가 아님.
- Blob store: immutable content-addressed assets. hash·size·media type 검증. DB reference와 백업 manifest로 묶음.

## 계약
API/worker/UI는 `packages/contracts`와 `packages/editor-core`를 공유한다. 외부 SDK raw event는 `packages/providers/<provider>` 밖으로 노출하지 않는다. SSE는 UI 관측용이다. 브라우저 연결 종료는 job 취소가 아니다. event_id로 재연결하며 최종 상태는 DB 조회로 확인한다.

## 동시성
v1은 원고당 하나의 writer lease를 기본으로 한다. 여러 탭에서도 silent last-write-wins 금지. 모든 정본 변경에는 expected_revision과 idempotency key. AI 읽기 작업은 bounded concurrency 허용. 동일 문서에 두 AI proposal이 있어도 적용은 직렬화한다. 작업 큐 재전달은 정상 실패모델이며 외부 모델 호출 비용까지 exactly-once라 주장하지 않는다.

## repository
apps/web, apps/api, apps/worker; packages/contracts, editor-core, domain, providers, search, exports; db/migrations; tests/unit,integration,e2e,security,fixtures; infra; docs; tasks; evals.

## 운영 기본값
외부 AI disabled, MockProvider. localhost bind. 비밀은 서버 측 secret store/권한 제한 파일(레포 밖). 입력 PDF와 미공개 연구자료는 공개 로그/오류 리포트에 포함하지 않음. 운영 provider process와 개발 Claude Code는 다른 OS 사용자·HOME/config/state/cwd를 갖는다. 원본 데이터는 read-only snapshot/선택 사본만 공유한다.
