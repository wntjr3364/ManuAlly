# PW-017 — 제안·CAS·원자 적용 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_017_0001_proposals.sql`
  - `selection_handles`(불변)
  - `edit_proposals`
    - 내용 불변, 상태는 PENDING→APPLIED/REJECTED/STALE만, DB 시계 기록, 감사 기록
    - 승인 전 제안은 문법·간결화만(CHECK)
    - revision 하나는 제안 하나의 결과
  - `proposal_applies`(멱등 key → 결과, 불변)
- `packages/domain/src/proposals/`
  - `guard.ts`: PW-003 보호 규칙의 TS 이식. 검사 7개: atom·인용·인용 위치·서식·숫자·부정어·방향어
    - 학술적 재작성은 부정어·방향어의 순서 변경만 허용한다(추가·삭제·반전은 불가).
  - `index.ts`
    - 선택 handle 생성: 서버가 저장된 revision에서 다시 계산하고, 하나라도 다르면 거부
    - 제안 생성(worker용), 미리보기, 적용, 거절
- `apps/api/src/proposals/index.ts`
  - `POST …/documents/:id/selection-handles`
  - `GET …/documents/:id/proposals`
  - `GET …/proposals/:id`
  - `POST …/proposals/:id/apply`
  - `POST …/proposals/:id/reject`
  - 제안 생성 API는 두지 않는다(AI worker만 만든다, PW-020).
- `apps/web/src/features/diff/`
  - `diff.ts`: 단어 diff. atom은 [인용] 등으로 표시
  - `ProposalPanel.tsx`: 제안 목록, diff, 검사 결과, 적용/거절, 같은 key로 다시 시도
- 계약: `contracts/edit_proposal.schema.json`
  - `outline_revision_id` null 허용(문법·간결화 + `intent`가 있을 때만, RFC-003)
  - `intent` 추가
  - `packages/contracts` 타입, `contracts/README.md`
- 범위 밖 연결(RFC-007 부록)
  - `apps/api/src/server.ts`(route 등록)
  - `apps/web/src/editor/ManuscriptEditor.tsx`
    - 선택 요청 → 서버 handle 생성
    - 제안 패널 표시
    - 적용 결과 화면 반영과 head 채택
    - 적용 중 편집 잠금
  - `apps/web/src/editor/autosave.ts`: `adopt()`
  - `SelectionChat.tsx`: 요청 전송 결과 표시
  - `styles.css`
- 시험(`tests/tasks/PW-017/`)
  - `guard.test.ts` 5
  - `proposals.int.test.ts` 12
  - `proposal.contract.test.ts` 2
  - `proposals.e2e.ts` 5
  - PW-015 autosave unit 1건 추가(`adopt`)

## 동작
- **선택 → handle**
  - 브라우저가 고정한 선택(PW-016)을 서버가 저장된 revision에서 같은 함수로 다시 계산한다.
  - hash가 하나라도 다르면 409 `SELECTION_MISMATCH`, 글자 중간 경계는 422.
- **제안**
  - AI(PW-020)는 handle id와 교체 내용만 준다. 서버가 EditProposal v2를 만든다.
  - 승인 전(개요 미승인)에는 문법·간결화만 만들 수 있다. 학술적 재작성은 403 `OUTLINE_NOT_APPROVED`.
  - 검사에 실패하면 CHECK_FAILED로 저장한다. 이유가 보이고, 절대 적용되지 않는다.
  - 만드는 시점에 원고가 이미 바뀌었으면(늦은 응답) STALE로 저장한다.
- **적용** (한 트랜잭션)
  - 문서 행 lock 아래에서 다음을 확인한다.
    - 같은 제안 hash
    - 요청의 기대 revision = 제안 기준 = 현재 head
    - handle 재검증
  - 확인되면 새 revision(`ai_apply`, 부모 = 기준)을 만들고 head를 옮긴다. 제안은 APPLIED가 되고, 멱등 key를 기록한다.
  - head가 바뀌었으면 제안을 STALE로 바꾸고 409. 자동 rebase는 하지 않는다(spec 04 v1).
  - 같은 key로 다시 보내면 200으로 같은 결과(`replayed`)를 준다.
  - 다른 key로 다시 적용하면 409 `ALREADY_APPLIED`와 기존 결과 revision을 준다.
  - 동시 적용: 같은 제안이든, 같은 revision의 다른 제안이든 정확히 하나만 성공한다(나머지는 STALE).
- **화면**
  - 적용 버튼은 다음 경우에 비활성이고 이유를 표시한다.
    - 저장됨 상태가 아닐 때
    - 제안 기준이 현재 화면 revision과 다를 때("원고가 바뀌어 적용할 수 없습니다")
  - 적용 요청 중에는 편집을 잠근다.
  - 결과는 서버가 돌려준 문단으로 해당 블록만 바꾼다. 화면이 저장본과 정확히 같을 때만 새 head를 채택한다(추가 자동 저장 없음).
  - 응답을 잃으면 "다시 시도"가 같은 key로 보낸다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-017-A / TST-017A 사용자 apply 한 번으로 해당 범위만 새 revision에 반영 | 통합 "one apply puts only the selected range…"(다른 문단·인용 그대로, 부모·reason·감사) |
| | 브라우저 "one apply changes only the selected range, and no extra autosave follows" |
| REQ-017-B / TST-017B stale·중복 apply·숫자 보호 위반·늦은 응답 | 통합 9건: 같은 key 재전송, 다른 key, 동시 적용(같은 제안 / 다른 제안), STALE, 다른 revision·변경된 제안, 늦은 응답, 숫자·인용 CHECK_FAILED, 승인 전 재작성·거절 후 적용, DB 불변, 다른 owner |
| | 브라우저 3건: STALE, 숫자 검사 실패 표시, 응답 유실 후 같은 key 재시도 |
| | unit `guard.test.ts` 5, 계약 2 |

## RED → GREEN
- 시험과 구현을 함께 썼다. 그래서 RED는 mutation으로 보였다(`mutation.log`).
  - 도메인·DB·guard 14개, 웹 4개, 모두 탐지
  - "문서 lock 제거"는 처음에 살아남았다. 같은 제안의 동시 적용은 제안 행 lock이 막았기 때문이다.
  - "같은 revision의 다른 제안 동시 적용" 시험을 추가했다. lock 없이 3회 모두 실패한다.
- 계약 시험: 이전 schema에서 2건 실패(`contract-red.log`)
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - unit 120, integration 151, contracts 15, e2e 54, spikes 70
  - typecheck·lint, evals/pack PASS

## 보안·과학적 실패 경로
- 정본 변경은 사용자의 apply 요청과 서버 검증(소유권·기대 revision·제안 hash·handle 재검증·검사 결과) 뒤 한 트랜잭션에서만 일어난다.
- AI 응답은 위치·hash·승인 필드를 줄 수 없다. 모두 저장된 handle에서 가져온다.
- 숫자·단위·비교어·인용·인용 위치·서식·부정어·방향어 변경은 CHECK_FAILED다.
  - 알려진 우회(그룹 라벨 교환, 주장 강도 변화, 목록 밖 단위, 영어 외 언어)는 RFC-003에 남아 있다.
  - 마지막 방어선은 사용자의 diff 확인이다.
- 다른 owner의 제안은 읽거나 적용·거절할 수 없다(404).
- DB는 제안 내용 변경, 결정된 제안 재개, handle·적용 기록 변경을 거부한다.

## 미실행 / 남은 위험
- 제안을 만드는 AI는 아직 없다. 시험은 domain 함수로 제안을 만든다(mock AI는 PW-020).
- 적용된 AI 수정의 undo는 PW-021에서 한다.
- 제안 목록은 "새로고침"으로 갱신한다. 실시간 알림은 PW-020(SSE)에서 한다.
- 다른 탭이 같은 원고를 열고 있으면, 적용 뒤 그 탭은 다음 저장에서 충돌(409)로 멈춘다(PW-015 규칙). 다른 탭에 알리는 일은 PW-020/022에서 한다.
- 학술적 재작성의 의미 변화(주장 강도 등)는 guard가 못 잡는다(PW-043/044).

## 다음
PW-018: 하이라이트·코멘트 anchor

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 1, minor 3, nit 2).
- 리뷰어가 문제없다고 확인한 것
  - 기준 revision의 두 번째 자식이 생기는 경로가 없다(`/saves`·`/revisions`·restore·apply 모두 문서 행 lock).
  - 동시 적용, 멱등 key 범위, 제안 행 trigger, owner 격리
  - diff XSS 없음

| 지적 | 조치 |
|---|---|
| **MAJOR 숫자 검사가 선택 부분만 봄**<br>"2.5"의 "."만 지우면 25 mg, "mg"의 "m"만 바꾸면 2.5 µg가 PENDING이 되고 적용됨(PW-003 spike도 같은 결함) | 검사를 **문단 전체의 전·후**로 비교한다. 리뷰어 사례 2건 회귀 시험(CHECK_FAILED), 숫자를 그대로 둔 넓은 선택은 PENDING |
| m1 틀린 `expected_revision_id` 하나로 멀쩡한 제안이 STALE로 굳고 이유도 틀림 | 기대 revision이 기준과 다르면 상태를 바꾸지 않고 409 `EXPECTED_REVISION_MISMATCH`. STALE은 head가 실제로 움직였을 때만. 회귀 시험 |
| m2 적용 응답 유실·5xx 뒤 편집기가 풀리고 "저장됨"인데 서버 head는 이미 이동 → 충돌로 막힘(502면 재시도 경로도 사라짐) | 응답 유실과 5xx는 "적용 여부 모름"으로 처리한다. key와 제안 표시를 유지하고, 편집기는 잠근 채 "다시 시도"(같은 key)만 허용한다. 서버가 첫 결과를 돌려주거나 한 번 적용한다. 브라우저 시험 2건(유실·502) |
| m3 새 스토리 승인 뒤 영향 검토가 필요한 개요에서도 학술적 재작성 허용 | 승인된 개요는 draft gate와 같은 조건이다. 개요 APPROVED이고 그 스토리가 활성 승인 스토리여야 한다. 서버와 화면(PaperPage) 모두. 회귀 시험 |
| nit: 결과를 모르는 제안의 key가 남음 | 결과를 모르는 동안에는 의도적으로 유지한다(재시도에 필요). 결과가 확인되면 지운다 |
| nit: 유실 시험이 편집기 잠금 해제를 요구함 | 잠긴 채 유지되는지 확인하도록 바꿨다 |

- 함께 바꾼 것
  - 선택 검증을 `verifySelection`으로 분리했다(PW-018 코멘트가 같은 검증을 쓴다).
  - 동작 변화는 없다(PW-017 시험이 그대로 통과).
- RED: 리뷰 전 코드에서 회귀 시험이 실패했다.
  - 도메인 4건(`review-red.log`)
  - 브라우저 2건(`review-red-web.log`)
- 실행: PW-017 통합 17, 브라우저 6. `pnpm test` exit 0(`pnpm-test-review.log`, 작업 중이던 PW-018 파일 포함): unit 129, integration 162, contracts 15, e2e 55, spikes 70
