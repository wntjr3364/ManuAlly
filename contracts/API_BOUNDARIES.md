# API boundary plan
모든 경로는 계획안이다. 아직 실행 가능한 endpoint가 아니다.

| API | 핵심 계약 |
|---|---|
| POST /api/papers | owner는 session에서 결정. 1개=1논문 |
| POST /api/papers/:id/story-revisions | draft 새 revision |
| POST /api/papers/:id/outline-revisions/:rid/approve | 사용자 + exact version/hash + CSRF + audit |
| GET /api/papers/:id/documents/:did | canonical head/explicit revision + ETag |
| POST /api/papers/:id/documents/:did/revisions | expected_revision + schema + owner + scope |
| POST /api/papers/:id/ai-jobs | intent/scope/source versions/budget/auto_resume consent |
| GET /api/papers/:id/ai-jobs/:jid/events | SSE event_id replay; project auth every connection |
| POST /api/papers/:id/ai-jobs/:jid/cancel | durable cancel then adapter interrupt |
| POST /api/papers/:id/ai-jobs/:jid/resume | quota/auth/policy/version再검사 |
| POST /api/papers/:id/proposals/:pid/apply | expected_revision + proposal_hash + idempotency key |
| POST /api/papers/:id/comments | stable anchor, orphan policy |
| POST /api/papers/:id/literature/search | permitted source/limit/cost; draft candidates |
| POST /api/papers/:id/assets | MIME/size/license/sending policy; immutable hash |
| POST /api/papers/:id/snapshots | exact dependency versions freeze |
| POST /api/papers/:id/exports | pinned snapshot + allowed format + report |

409 conflict는 자동 overwrite하지 않는다. 422 schema/evidence errors는 구체 field를 보여준다. 401/403과 provider 인증 오류를 별도 namespace로 정규화한다. 동일 idempotency key의 다른 body는 거절한다. user-visible 오류에는 secret·private provider raw payload를 포함하지 않는다. internal agent tools는 별도 run-token 인증이며 위 사용자 승인 endpoint를 호출할 권한이 없다.
