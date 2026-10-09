# PW-040 — Detailed outline·영향 추적 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_040_0001_outline_impact.sql`
  - `outline_impact_resolutions`: 소유자가 영향 하나를 검토한 기록. 바꿀 수 없다.
  - `outline_node_paragraphs`: 문단 계획과 원고 문단의 연결(사용자·초안). 해제할 수 있다.
- `packages/domain/src/outline-impact/index.ts`
  - 영향은 **지금 상태에서 계산**한다(추측 없음). 문단 계획(node)이 기대는 것이 바뀌면 영향이 생긴다.
    - 주장: 철회됨·거절됨, 또는 없어짐
    - 근거: 철회됨·거절됨, 또는 없어짐
    - 그 근거에서 읽은 사실: 철회됨
    - 그 근거가 읽은 그림 버전: 더 새 버전이 생김. 현재 버전으로 key를 만들어, 새 버전마다 새 영향이 된다.
    - 인용한 문헌: 논문에서 빠짐, 또는 서재가 철회로 앎
  - 영향 목록에는 연결된 원고 문단이 함께 나온다. 소유자가 검토하면(`resolve_impact`) 그 영향은 닫힌다.
  - `unresolvedNodes`: 검토하지 않은 영향이 있는 node
  - `nodeScope`: **승인된 node 하나**의 생성 범위
    - 들어가는 것: 목적·허용 해석·제외·전환, 승인된 주장, 검증된 근거와 거기서 읽은 검증된 사실, 같은 부모의 앞뒤 계획(목적·전환), 연결된 문단
    - 빠지는 것(사유와 함께): 승인 안 된 주장(`not_approved`), 철회된 것(`withdrawn`), 없는 것(`missing`)
    - 승인되지 않은 node에는 범위가 없다(409).
  - `linkParagraph`, `unlinkParagraph`
- 범위 밖(RFC-012 부록)
  - `packages/domain/src/outlines/index.ts`
    - draft gate: 그 node에 검토 안 한 영향이 있으면 `impact_review_required`. 다른 node는 그대로다.
    - node 상태: 같은 경우 `IMPACT_REVIEW_REQUIRED`
  - `packages/domain/src/evidence/index.ts` `retractRecord` 추가
    - 승인된 주장, 검증된 근거·사실의 **철회**. 명시 intent와 검토한 content hash가 필요하다.
    - 지금까지 DB만 허용하고 길이 없었다.
  - `apps/api/src/routes/evidence/index.ts`(철회 route), 새 `apps/api/src/outline-impact/index.ts`와 `server.ts`
  - 화면 연결
    - `EvidenceTab.tsx`: 근거·사실 철회 버튼(확인 창)
    - `TracePanel.tsx`: 주장 상태와 철회 버튼
    - `StoryOutlineTab.tsx`: 영향 panel 붙임
- 화면 `apps/web/src/features/outline-impact/OutlineImpactPanel.tsx`(승인된 개요 아래 "변경 영향")
  - 열린 영향의 수
  - 영향마다 문단 계획(절과 목적), 바뀐 것, 자세한 내용, 연결된 원고 문단 수
  - "검토함 — 이 계획대로 진행" 버튼
- 시험: `tests/tasks/PW-040/impact.int.test.ts`(통합 9), `impact.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-040-A / TST-040A 승인된 node에서 필요한 범위만 생성하고, 변경된 source의 영향을 추적 | 생성 범위는 n1의 목적, 승인된 주장, 근거, 사실, 다음 계획뿐이다. 다른 node의 주장·근거는 없고, 초안 주장은 `not_approved`로 빠진다. 승인 안 된 node는 409다. 주장 철회 → n1만 영향(연결된 문단 포함), n1 gate 차단, n2 통과, 상태는 [IMPACT_REVIEW_REQUIRED, APPROVED, APPROVED]. 검토(intent 필요, 남의 논문 404, 없는 영향 422) → n1 gate 통과, 철회된 주장은 범위에서 `withdrawn`. 사실 철회, 근거 철회, 그림 새 버전 → 해당 node만. 검토 뒤 또 새 버전 → 다시 영향. 인용 문헌 제거·철회 → 그 문헌을 인용한 node. 철회는 intent와 hash가 필요하고, 승인·검증된 것만 할 수 있다. 브라우저: 자료 tab에서 주장 철회 → 개요의 영향 1(그 계획만) → 검토 → 0 |
| REQ-040-B / TST-040B 새 draft outline을 승인본 대신 쓰지 않고, 관련 없는 문법 수정까지 잠그지 않음 | 새 draft 개요가 있어도 gate는 승인본으로 통과하고, draft id로는 `outline_not_active`다. 영향 있는 node에 연결된 문단도 수동 저장은 된다(201). 문단 연결은 그 논문의 node·문서만(404) |

## RED → GREEN
- RED
  - `red.log`: 구현 전 5개가 실패했다(scope·impacts·retract route 없음). B 세 개는 기존 동작으로 통과했다. 새 코드가 그것을 깨지 않는지는 mutation으로 보였다(gate·상태·연결 검사).
  - `red-e2e.log`: panel이 없으면 실패한다.
- GREEN: 통합 9, 브라우저 1
- mutation(`mutation.log`): 18종 모두 탐지.
  - 영향 7종: 주장·근거·사실 철회, 그림 버전, 버전별 key, 문헌 제거, 문헌 철회
  - 검토: intent, 열린 영향만
  - 범위: 승인된 주장만, 승인된 node만, 앞뒤 계획
  - 연결: node 확인
  - gate의 영향, node 상태
  - 철회: 승인·검증된 것만, hash
  - 화면 검토
- 회귀: `pnpm test` exit 0 — unit 282, integration 408, contracts 17, 브라우저 89 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 영향은 계산 결과이고, 소유자만 검토로 닫을 수 있다. AI가 영향을 닫거나 범위를 넓히지 못한다.
- 검토한 node의 생성 범위에서는 철회된 것이 빠진다. 그래서 철회된 주장으로 새 문단이 생성되지 않는다.
- 영향은 AI 생성만 그 node에서 멈춘다. 사용자의 직접 편집이나 다른 문단은 막지 않는다(spec 03).

## 미실행 / 남은 위험
- 문단과 node의 연결은 지금 사용자가 API로 하거나, PW-042 Writer가 초안을 적용할 때 기록한다(PW-042에서 연결). 연결 화면은 아직 없다.
- "outline 재정렬", "writing profile 갱신"의 영향은 다루지 않는다. 재정렬은 새 개요 revision이고 그 승인이 대상이다. profile은 PW-041 뒤에 한다.
- 영향 계산은 읽을 때마다 한다. node가 아주 많은 개요에서는 비용이 커질 수 있다(MAX_NODES 안).

## 다음
PW-041: WritingProfile 생성·승인

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 2, NIT 3)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 주장의 근거를 철회해도 주장은 APPROVED로 남고, 주장만 적은 node는 영향이 없다. 그 주장이 generation scope·PW-039·PW-037에 계속 쓰였다 | (1) 지지 근거 중 검증된 것이 하나도 남지 않은 승인된 관찰 주장은 **계산상 unsupported**다. 따로 저장하지 않는다. PW-037 `candidatePool`은 이를 `claim_unsupported`로 보류한다(`RETRIEVAL_VERSION` pw-retrieval-3). 그래서 `settledMaterial`(PW-039)과 node scope에서도 빠진다. (2) `derive()`는 node가 적은 주장의 근거(그리고 그 근거의 사실·그림·인용 문헌)도 의존으로 본다. key에 `via-claim:<id>`로 경로를 적는다. 주장 자체에는 `claim_unsupported` 영향이 생긴다. 철회는 막지 않는다. 잘못된 측정을 거두는 것은 사용자의 권리다 | 주장만 적은 n4: 근거 철회 → `claim_unsupported`, `evidence_withdrawn`(via-claim key), gate 차단, scope 제외(`claim_unsupported`), settledMaterial에서 빠짐 |
| MINOR 1: 보관된 그림은 영향이 아님 | `figure_archived`(보관 시각을 key에 넣음) | 보관 → n3 영향 |
| MINOR 2: nodeScope가 PW-037 gate를 거치지 않음 | `nodeScope`가 호출자에게 `settledMaterial`을 받는다(search가 domain에 의존하므로 반대 방향 import는 못 함). gate가 막은 주장·사실·원문 인용은 사유와 함께 `excluded`에 남긴다. API는 `?provider=`로 공급자를 정한다(기본 MOCK, 모르는 값은 422) | 그림 새 버전 → 이전 버전에서 읽은 사실이 `read_from_older_figure_version`으로 빠짐 |
| NIT: 동시 검토가 500 | `ON CONFLICT DO NOTHING` | 다른 트랜잭션이 같은 검토를 커밋하지 않은 채 있는 동안 검토 → 201(결정적 재현) |
| NIT: 두 번째 제거가 가려짐 | `source_removed` key에 제거 시각을 넣음 | 제거 → 검토 → 다시 넣음 → 다시 제거 → gate 차단 |
| NIT: 읽을 때마다 계산 | 지금 그대로다. 개요가 커지면 요청 단위 cache를 남은 위험으로 둔다 | — |

- 범위 밖 추가: `packages/search/src/retrieval/index.ts`
  - 근거 없는 관찰 주장 보류, `settledMaterial`에 `excerptIds`
  - PW-037 module이다. RFC-012 부록에 적었다.
- RED(`red-review.log`): 9f909b6 구현으로 새·바뀐 시험 5개가 실패한다.
- GREEN: 통합 13, 브라우저 1.
- mutation(`mutation.log` 하단): 8종 모두 탐지.
  - 근거 없는 주장, 주장 경유 의존, 보관 그림, 제거 시각 key
  - 동시 검토: 결정적 재현으로 바꾼 뒤 탐지
  - scope의 주장·사실 gate, retrieval 보류
- 회귀: `pnpm test` exit 0 — unit 282, integration 412, contracts 17, 브라우저 89 (`pnpm-test-review.log`)
