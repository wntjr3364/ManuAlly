# RFC-013 — P06 Task 연결 파일(write scope 밖)
Status: accepted (delegated, 2026-10-10)
Trigger task: PW-047 이후 P06 Task
Affected requirements/specs/contracts: REQ-047 … REQ-054; docs/specs/07_AGENT_RUNTIME.md, docs/specs/08_CONTEXT_QUOTA_AND_JOBS.md

Problem and evidence:
- RFC-011·012와 같은 이유다.
- P06 Task의 write scope는 해당 기능의 worker·domain 폴더와 migration만 준다.
- checkpoint·context 예산·할당량 대기·비용 예산은 이미 있는 job handler(Writer 등)의 경계에서 불려야 동작한다. 그래서 그 handler와 등록·화면 파일을 고쳐야 한다.

Proposed change:
- 각 Task가 범위 밖에서 고친 파일을 아래 부록에 Task별로 적는다.
- 공유 표(`jobs` 등)의 CHECK 변경은 그 Task의 migration에서 하고 부록에 적는다.
- 인증·청구 모델 변경은 이 RFC로 덮지 않고 별도 RFC로 한다.

Alternatives considered: RFC-011과 같다.

Security/privacy/budget/provider terms impact:
- checkpoint와 재수화는 모델을 부르지 않는다.
- 요약은 검증되지 않은 메모이고 승인·사실·완료의 근거가 아니다(spec 08).
- 재개 전에 정본과 정책을 다시 검사한다.

Data migration / backward compatibility: 새 표만(기존 표의 데이터는 바꾸지 않음)
Tests and acceptance criteria: 각 Task 시험과 `pnpm test`
Write scope: 아래 부록의 파일
User decision / reviewer:
- 사용자 위임("니가 적절하게 선택해서 프로젝트 완성해라", 2026-10-09)으로 채택한다.
- Task마다 독립 리뷰가 확인한다.

## 부록 — Task별 범위 밖 파일
- PW-047
  - `apps/worker/src/writer/index.ts`: Writer handler의 checkpoint 세 곳(호출 전, 검증 후, 제안 저장 — 마지막은 완료 트랜잭션 안). 두 번째 이후 실행은 마지막 checkpoint를 재검사하고, 바뀐 것이 있으면 WAITING_USER로 보낸다.
