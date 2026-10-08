# PW-009 — 불변 revision·snapshot 저장 — 보고서

상태: **in_review** / 일자: 2026-10-08

## 변경 파일
- `db/migrations/pw_009_0001_revisions_snapshots.sql`
  - `documents`(head pointer)와 `document_revisions`(parent·restored_from·canonical hash·schema_version·reason)
  - 서지: `reference_works`, `bibliographic_revisions`, `project_references`
  - `asset_revisions`
  - snapshot: `paper_snapshots`와 `snapshot_{document,reference,asset}_revisions`
  - **revision·snapshot 테이블 7개는 trigger로 UPDATE/DELETE/TRUNCATE를 막는다**(`immutable`)
  - 논문 소유 행 사이의 모든 연결은 `(paper_id, …)` 복합 FK다. head는 같은 문서의 revision만 가리킬 수 있다(deferred FK)
- `packages/domain/src/revisions/index.ts`
  - 문서 생성(빈 초기 revision)
  - 저장: CAS. `SELECT … FOR UPDATE`로 동시 저장을 직렬화하고, head가 다르면 CONFLICT
  - 복원: 기존 내용으로 **새** revision 생성
  - snapshot: 모든 문서의 head, 프로젝트 문헌별 최신 서지 revision, asset_key별 최신 asset revision의 id를 고정
- `apps/api/src/routes/revisions/index.ts`: 모든 route가 paper-scoped(소유권 검사·IDOR 공통 테스트에 자동 포함)
- `packages/domain/src/shared/db.ts`: `inTransaction` 이동(PW-008 리뷰 수정과 공유)

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-009-A 복원은 새 revision, 과거 snapshot은 당시 참조 재현 | TST-009A ×4 (복원: 새 id·parent·restored_from·같은 hash, 이력 보존 / snapshot이 이후 수정과 무관하게 당시 내용 반환 / stale 저장 409, 동시 저장 하나만 성공 / 내용 형식·schema_version·허용 reason 검사, 'ai_apply' 직접 요청 거부) | pass |
| REQ-009-B 승인 revision 덮어쓰기·다른 paper 참조를 DB/API가 거절 | TST-009B ×3 (직접 SQL UPDATE/DELETE/TRUNCATE → immutable / 다른 논문 revision을 snapshot·parent·head로 연결하면 FK 오류 / API: 다른 논문 revision으로 복원 404, 다른 문서 경로 404, 다른 owner 404이며 본문 노출 없음) | pass |

RED: route 없음으로 7건 실패(`red.log`). GREEN: 7/7.

## 설계 메모
- `reason`:
  - 클라이언트가 직접 쓸 수 있는 값: manual, autosave, import
  - 내부 전용: initial, restore
  - `ai_apply`: 승인된 proposal 경로(PW-017)에서만 허용, 직접 요청은 422
- "승인된" story/outline revision의 불변성은 PW-010 테이블에도 같은 trigger 함수(`pw_make_immutable`)를 적용한다.
- snapshot의 story/outline 연결은 PW-010에서 `paper_snapshots`에 FK 열로 추가한다.
- autosave revision이 무한히 쌓이는 문제(보존 정책)는 PW-061 운영 범위다.
- content는 아직 "type=doc인 JSON 객체"까지만 검사한다. 편집기 schema 검증은 PW-012에서 붙인다.

## 미실행
- 대용량(20,000단어) 성능은 측정하지 않았다(NFR, P07).
- 서지·asset revision을 만드는 API는 P04에서 제공한다. snapshot은 이 테이블들에 행이 있으면 함께 고정하며, DB 테스트는 문서 쪽을 기준으로 했다.

## 다음 Task
PW-010 수동 Story·Outline 승인.

## 독립 리뷰 결과 반영 (2026-10-08)
리뷰 결론은 changes requested였다(major 3, minor 4). 수정은 새 migration `pw_009_0002_snapshot_seal_reference_owner.sql`과 `revisions/index.ts`로 했다. 회귀 시험은 `tests/tasks/PW-009/review-fixes.int.test.ts`(6건)다.
- M1 snapshot에 나중에 행 추가 가능
  - `paper_snapshots.created_xid`를 두고, 하위 3개 테이블에 AFTER INSERT trigger를 건다.
  - 스냅샷을 만든 트랜잭션에서만 행을 추가할 수 있다.
  - AFTER로 둔 이유: 다른 논문 행은 FK 오류가 먼저 보고되도록 하기 위해서다(기존 TST-009B 유지).
- M2 다른 owner의 문헌 연결 가능
  - `project_references.owner_id`를 추가한다.
  - FK `(paper_id, owner_id)`→paper, `(owner_id, reference_id)`→reference_works.
- M3 snapshot에 쓰인 문헌을 논문에서 제거할 수 없음
  - `removed_at`으로 소프트 제거한다. DELETE·식별자 변경·TRUNCATE는 금지한다.
  - 다음 snapshot은 제거된 문헌을 제외한다.
- minor 4 (500 대신 4xx)
  - content의 NUL·짝 없는 surrogate는 422.
  - 깊이 100 초과는 422.
  - schema_version이 int4 범위를 넘으면 422.
  - label의 NUL은 422.
- minor 7: 문서 잠금에 `ORDER BY id` 추가.
- 보류(기록):
  - minor 5: 문서별 seq 열은 불변 테이블에 열 추가와 백필이 필요하다. P04 이전 RFC로 처리한다.
  - minor 6: DB 수준 created_by=owner, content_hash 검증은 PW-013 audit와 함께 처리한다.
  - 잔여 위험: 앱 DB 계정이 superuser·테이블 owner다. trigger를 끌 수 있으므로 운영용 runtime role을 분리해야 한다(PW-061/P07 배포 전 필수).
  - 잔여 위험: 보존 정책에 따른 프로젝트 영구 삭제 경로는 아직 없다.
- 리뷰 시 테스트 공백(문헌·asset이 든 snapshot, 기존 snapshot에 삽입)은 위 회귀 시험으로 채웠다.
