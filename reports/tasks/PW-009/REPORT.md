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
