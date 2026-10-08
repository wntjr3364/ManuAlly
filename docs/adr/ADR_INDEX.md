# Architecture decisions — proposed, not yet user-approved
| ID | 제안 | 이유 / 변경 시 필요한 검증 |
|---|---|---|
| ADR-001 | PaperProject가 하나의 논문 | 사용자 확정 요구. 여러 논문 묶음으로 바꾸지 않음 |
| ADR-002 | PostgreSQL + immutable revisions가 정본 | session/PDF/Markdown 중복 정본 방지 |
| ADR-003 | TypeScript monorepo와 shared editor-core | editor position/patch validation을 양쪽에서 공유. P00 검증 후 확정 |
| ADR-004 | Tiptap OSS, 자체 제한된 comments/proposals | Pro/Cloud 요금·종속 최소화. 비용·난이도 검증 후 조정 |
| ADR-005 | 단일 owner + optimistic concurrency | v1 CRDT 제외. 복수 탭은 충돌을 명시 |
| ADR-006 | AI가 proposal 생성, server가 적용 | 저자 승인·version·evidence를 runtime 밖에서 강제 |
| ADR-007 | provider/auth/deployment capability admission | 구독 약관·SDK 지원을 추정하지 않음 |
| ADR-008 | pg-boss + DB job/outbox | 운영 구성 최소화. 외부 side effects는 별도 idempotency |
| ADR-009 | checkpoint + compact/new session hydration | agent의 기억이 과학적 정본이 되지 않음 |
| ADR-010 | one writer per document, bounded review | quota/문서경합/복잡한 multi-agent 방지 |
| ADR-011 | draft export와 submission snapshot 구분 | 작성 중 편의와 최종 검증을 모두 보존 |
| ADR-012 | local/private deployment, hosted auth 별도 검토 | SaaS·계정 공유를 개인 도구와 혼동하지 않음 |

확정 시 각 ADR을 독립 문서로 승격해 status/context/decision/alternatives/consequences/source evidence를 기록한다. 본 표는 사용자 확정 제품 요구를 제외하면 설계 제안이다.
