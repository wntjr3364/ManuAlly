# PW-042 — ParagraphContract·Writer — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_042_0001_paragraph_proposals.sql`: `paragraph_proposals`
  - 문단 제안 한 건: 계획(node), 원고 revision과 위치, 계약(contract)과 그 hash, 만든 문단, 검사, 경고, 부족한 근거, 생성기
  - 내용은 바꿀 수 없다. 상태만 PENDING → APPLIED / REJECTED / STALE로 간다(trigger).
  - 그 밖의 상태: CHECK_FAILED, NEEDS_EVIDENCE, NO_CHANGE. 처음부터 그 상태로 저장되고 적용할 수 없다.
- `packages/contracts/src/writing/index.ts`(새 export `@pw/contracts/writing`)
  - `ParagraphContract`(spec 06의 항목)
    - 승인된 story·outline·node, 목적, 허용 해석, 금지 추론, 전환
    - 반드시 담을 승인된 주장, 정확한 검증 사실(수치·n·통계), 근거 위치
    - 빠진 것과 사유
    - 앞뒤 계획과 앞뒤 원고 글
    - profile의 용어, 섹션 원칙·반례, 주장 강도, 영어 변이, 저널 규정
    - 목표 분량
    - 작업(mode, 문서, base revision, 위치, 고칠 문단의 원문)
    - 인용할 수 있는 참고문헌, 요청, 전송 정보
  - `parseWriterAnswer`: 답은 `{status:'draft', paragraph, claim_ids, fact_ids}` 또는 `{status:'needs_evidence', missing}`이다. 아래는 **거부**(실행 FAILED, 저장 없음)다.
    - 모르는 field
    - 계약에 없는 주장·사실 id
    - 이 논문의 참고문헌이 아닌 인용(RFC-008)
    - 글로 쓴 서지: 저자-연도, 번호 괄호, DOI
    - 둘 이상의 문단: 줄바꿈, 제목, 예산의 약 두 배를 넘는 길이
- `packages/domain/src/writer/index.ts`
  - `requestParagraph`
    - draft gate를 통과해야 한다: 승인된 story, 활성 승인 개요, 승인된 node, 미검토 영향 없음.
    - base revision은 지금 head여야 한다(409).
    - 위치 block이 그 revision에 있어야 하고, 고칠 것은 문단이어야 한다(422).
    - 그 뒤 job을 고정해 넣는다.
  - `applyParagraphProposal`
    - intent `apply_paragraph`, 정확한 proposal hash, base revision이 필요하다.
    - gate를 다시 본다(그 사이 생긴 영향이면 409).
    - head가 base가 아니면 STALE로 바꾸고 거부한다(rebase 없음).
    - 한 트랜잭션에서 한다: 새 문단 삽입(지정 문단 뒤, 없으면 끝) 또는 같은 id 문단 교체, `ai_apply` revision, 그 문단을 node에 연결(`outline_node_paragraphs`, origin draft), APPLIED.
  - `rejectParagraphProposal`, 목록과 조회
- `apps/worker/src/writer/index.ts`
  - `writerHandlers`
    - 실행할 때 gate를 다시 본다. 막히면 FAILED이고, 생성기는 부르지 않는다.
    - 실제 공급자는 논문 허용이 필요하다(아니면 WAITING_USER).
    - 계약은 `nodeScopeFor`(그 공급자의 PW-037 gate)로 만든다.
    - 결정적 검사를 한다.
      - 새 문단: 수치는 계약의 사실·승인된 주장에 있는 것만(`number_not_in_contract`), 반드시 담을 주장(`mandatory_claim`), 피할 용어(`avoided_term`)
      - 교정·재작성: PW-017 guard로 원문과 비교한다(수치·부정·방향·인용·보호 atom). 보수적 교정은 순서까지 지키고, 재작성은 절의 순서만 바꿀 수 있다. 피할 용어도 본다.
    - 검사 실패는 CHECK_FAILED로 저장되어 보이지만 적용할 수 없다.
    - 늦은 답(그 사이 원고가 바뀜)은 STALE로 저장한다.
    - 바뀐 것 없는 교정은 NO_CHANGE다.
    - 분량 넘침·모자람은 경고다.
  - `createMockWriter`: 계약의 주장·사실만으로 쓴다(`[MOCK]`). 주장도 사실도 없으면 근거 부족을 답한다. 교정은 공백과 마침표만 고친다.
- 범위 밖(RFC-012 부록)
  - `packages/domain/src/writer/**`(도메인 함수)
  - `packages/search/src/retrieval/index.ts` `nodeScopeFor`: PW-040 리뷰 NIT이다. scope는 그 공급자의 settled 집합으로만 만든다. `apps/api/src/outline-impact/index.ts`도 이것을 쓴다.
  - `apps/api/src/writer/**`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`
  - `apps/worker/package.json`(`@pw/contracts` workspace 의존성), `packages/contracts/package.json`(`./writing` export), `pnpm-lock.yaml`
  - `apps/web/src/features/writer/WriterPanel.tsx`, `apps/web/src/features/paper/ManuscriptTab.tsx`
  - `tests/e2e/manual-paper/harness.ts`
- 화면: 원고 tab의 편집기 아래 "문단 작성"
  - 문단 계획(승인된 것만 고를 수 있음), 할 일(새 문단·보수적 교정·재작성), 위치나 고칠 문단, 요청
  - 제안마다 상태, 글, 실패한 검사, 경고, 부족한 근거
  - 적용·거절. 저장되지 않은 편집이 있으면 요청·적용을 막는다.
- 시험
  - `tests/tasks/PW-042/writer.int.test.ts`(통합 9)
  - `contract.test.ts`(unit 19)
  - `writer.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-042-A / TST-042A: 지정 scope/목적/근거/용어를 사용하며 proposal로만 반환 | 생성기가 받은 계약을 확인한다: node 목적·섹션·금지 추론·분량, 승인된 주장 c1, 사실 f1(2.4), 근거 e1, 다음 계획, 앞 문단 글, profile 용어·원칙, 논문 참고문헌, 작업 위치와 요청. 다른 node의 주장은 없다. 제안은 PENDING이고 원고 head는 그대로다. 적용에는 intent(422), hash(409), base(409)가 필요하고 남의 논문은 404다. 적용하면 새 문단이 지정 문단 뒤(둘 사이)에 들어가고 `ai_apply`이며 node에 연결된다. 두 번째 적용은 409다. 보수적 교정은 같은 block을 고치고, 수치를 바꾸면 CHECK_FAILED다. 재작성은 순서는 바꿔도 되지만 결과를 더하면 실패다. 오래된 원고는 STALE이다. gate(초안 개요, 영향)는 요청·실행·적용 때 모두 본다. 실제 공급자는 허용 없이 WAITING_USER이고 호출 0번이다. 브라우저: 요청 → 제안(편집기 1문단) → 적용 → 편집기 2문단 |
| REQ-042-B / TST-042B: missing evidence를 지어내거나 한 문단 요청을 전체 원고로 확장하지 않음 | `needs_evidence`는 NEEDS_EVIDENCE로 남고 적용할 수 없다. 계약에 없는 수치(5.1), 빠진 주장, 피할 용어는 CHECK_FAILED이고 적용 409다. 다른 node의 주장, 없는 사실, 남의 논문 참고문헌·없는 id 인용, "(Smith et al., 2020)", "[12]", DOI, 추가 field는 FAILED이고 저장 없음이다. 두 문단(줄바꿈), 제목, 예산의 두 배를 넘는 길이, `paragraphs` 배열은 FAILED(scope_exceeded)다. 조금 넘으면 경고다. 브라우저: 주장·사실 없는 계획 → "근거 부족", 적용 버튼 없음 |

## RED → GREEN
- RED(`red.log`): 빈 stub으로 시험 8개가 모두 실패했다(route 없음). 9번째 시험(실행·적용 때 gate, 늦은 답 STALE, NO_CHANGE)과 unit 19개는 구현 뒤에 썼고, 아래 mutation으로 보였다.
- GREEN: 통합 9, unit 19, 브라우저 1
- mutation(`mutation.log`): 28종 모두 탐지.
  - 답 거부: 주장, 사실, 인용, 서지 문자열, 줄바꿈, 제목, 길이 상한, 상한 배수, 새 문단의 atom
  - 검사: 수치, 주장, 용어, 원문 guard, 분량 경고, NO_CHANGE
  - 공급자 허용, 실행 때 gate, 늦은 답 STALE
  - 적용: hash, expected revision, STALE, gate, node 연결, 상태, intent, 삽입 위치
  - 요청: 오래된 base, 없는 block
- 회귀: `pnpm test` exit 0 — unit 309, integration 430, contracts 17, 브라우저 91 (`pnpm-test.log`; 첫 실행은 e2e 시험의 타입 오류로 typecheck에서 멈췄고, 고친 뒤 다시 돌렸다)

## 보안·과학적 실패 경로
- AI는 제안만 만든다. 원고는 소유자의 적용(정확한 hash, base, gate)으로만 바뀐다. 바뀐 원고 위에 덮어쓰지 않는다(STALE).
- 수치는 계약의 검증 사실과 승인된 주장에서만 나와야 한다. 인용은 이 논문의 참고문헌만 쓸 수 있다. 근거가 없으면 생성기가 "근거 부족"으로 답할 수 있고, 그것은 적용할 수 없다.
- 계약에는 그 공급자에게 허락된 것만 들어간다(PW-037 gate). 실제 공급자는 논문 허용이 없으면 부르지 않는다.
- 한계(정직하게): 결정적 검사는 의미를 보지 않는다.
  - "주장을 담았다"는 생성기의 선언(`claim_ids`)이다. 문장이 그 주장을 정말 말하는지는 PW-043 scientific reviewer와 사용자 검토의 몫이다.
  - 수치 검사는 값만 비교하고 단위·그룹 매칭은 하지 않는다(PW-043).

## 미실행 / 남은 위험
- 실제 Claude/Codex 생성기 연결은 아직이다. RFC-010 실행 경로와 계약 전달은 준비됐지만, provider adapter에 writer prompt를 붙이는 일과 live 시험은 사용자 PC에서 한다(자격 없음 → not_run).
- 앞뒤 원고 글은 각각 1500자까지만 계약에 넣는다.
- 참고문헌이 200개를 넘는 논문은 앞 200개만 인용할 수 있다.
- 적용 때 gate 확인은 적용 트랜잭션 바로 앞에서 따로 한다. 그 사이의 아주 짧은 틈은 남는다.
- 재작성 guard는 수치 순서까지 같아야 한다(PW-017 규칙). 순서를 바꾼 재작성은 검사 실패가 될 수 있다(안전한 쪽).

## 다음
PW-043: scientific reviewer / 검증 층

## 리뷰 반영 (1차, changes requested — MINOR 3, NIT 3)
| 지적 | 수정 | 시험 |
|---|---|---|
| MINOR 1: 인용 locator에 자유 글(지어낸 결과, 서지)이 실려 검사를 빠져나감 | 생성기가 붙이는 locator는 짧은 표지만 허용한다: p./pp./Fig./Figure/Table/Suppl./Sect./Chapter/Eq./para. + 짧은 번호, 30자 이하. 원문 문단에 이미 있던 같은 참고문헌의 locator는 그대로 둘 수 있다. 그 밖은 거부한다(`bad_locator`, FAILED, 저장 없음) | 통합: "Smith et al. 2020 reported a 50-fold rise", 자유 글, DOI → FAILED. "p. 12", "pp. 3–5", "Fig. 2A", "Table S1", "Suppl. 4" → PENDING. unit: 허용 10, 거부 6, 원문 locator 유지 |
| MINOR 2: 철회된 문헌·node와 무관한 문헌을 인용해도 표시 없음 | 계약의 참고문헌에 `retracted`를 붙인다(서재의 철회 표시·고지). 철회된 문헌을 인용하면 `citation_retracted`로 CHECK_FAILED다. node 근거와 연결되지 않은 문헌 인용은 경고 `citation_not_linked_to_node`다(배경 인용일 수 있어 막지 않고 사용자가 판단). `citable_references_truncated`로 200개 넘음을 알린다(NIT 3) | 철회 표시 → 계약에 retracted: true, 제안 CHECK_FAILED. 연결 없는 인용 → 경고. truncated false |
| MINOR 3: 원고 어디든 고치면 모든 제안이 STALE | 제안은 **자기 자리**에만 묶인다. 교정·재작성은 그 문단의 hash, 새 문단은 앞 block의 hash(migration `pw_042_0002`, `after_block_hash`)로 판단한다. 다른 곳이 바뀌어도 적용할 수 있고, 지금 head 위에 적용해 사용자의 다른 편집을 지킨다. 자리가 바뀌거나 없어지면 STALE이다(rebase 없음). worker의 늦은 답도 같은 규칙이다 | 요청 뒤 P2 편집 → 제안 PENDING. 또 P2 편집 → 적용 200, 새 문단은 P1과 P2 사이, P2의 편집 유지. P2 교정 중 P1 편집 → 적용 200. P2 교정 중 P2를 직접 고침 → 409, STALE |
| NIT: gate를 적용 트랜잭션 밖에서 봄 | 적용 트랜잭션 안에서 paper 행을 잡고 본다(`gateHoldsIn`): story 승인, 활성 승인 개요, node 승인, 미검토 영향 없음 | 영향 → 적용 409(reasons에 impact_review_required) |
| NIT: 앞 문단의 수치가 허용되지 않는 이유가 화면에 없음 | 검사 문구: "계획의 사실·주장에 없는 수치(앞 문단에 쓴 수치라도 검증된 사실로 등록되어 있어야 씁니다)" | — |
| NIT: 200개 잘림이 조용함 | `citable_references_truncated` | 통합 |

- RED(`red-review.log`): 43b8f5d 구현으로 새 시험 3개가 실패한다.
- GREEN: 통합 12, unit 36, 브라우저 1.
- mutation(`mutation.log` 하단): 13종 모두 탐지.
- 회귀: `pnpm test` exit 0 — unit 326, integration 433, contracts 17, 브라우저 91 (`pnpm-test-review.log`).
- 남은 위험(추가): 새 문단은 앞 block만 같으면 적용된다. 뒤 문단이 바뀌어 전환이 어색해질 수 있지만, 이것은 사용자가 보고 적용하는 diff 범위다.
