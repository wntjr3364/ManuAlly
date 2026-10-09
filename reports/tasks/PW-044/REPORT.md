# PW-044 — 문체·과학 검토와 human review — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_044_0001_reviews.sql`
  - `review_runs`: 읽은 revision·block·block hash, 검토자, 독립성, 입력 hash, 버린 지적. 바꿀 수 없다.
  - `review_findings`: 종류·범주·문구와 위치·이유·근거·확신도·대안·경고. 소유자의 결정(채택·기각, 메모)만 한 번 바뀐다(trigger).
  - `review_repairs`: `run_id` PRIMARY KEY라서 **검토 하나에 고쳐 쓰기 한 번**이 DB에서 보장된다.
- `apps/worker/src/reviewer/index.ts`
  - `reviewerHandlers`(job intent `review`)
    - 검토자가 받는 것: 문단 글, 그 문단이 속한 승인 계획의 섹션·목적·주장·사실·근거(그 공급자의 PW-037 gate를 거친 것), PW-043 결정적 검사 결과(번호 붙음), 글쓰기 프로필(주장 강도, 섹션 원칙, 용어), 범주 목록
    - 실제 공급자는 논문 허용이 필요하다(아니면 WAITING_USER, 호출 0).
  - `checkFindings`: 답은 `{ findings }`뿐이다.
    - **점수**나 다른 field가 있으면 실행이 FAILED이고 저장 없음이다. 확신도는 low/medium/high 낱말뿐이다(숫자 점수 불가).
    - 범주는 정해진 rubric 안에서만 쓸 수 있다.
      - 과학: 과장, 인과 단정, 논리 비약, 반대 근거 누락, 부정, 섹션 역할, 근거 불일치
      - 문체: 반복, 밀도, 연결, 길이, 간결함, 장르, 명료성
    - 버리고 이유를 남기는 지적(`dropped`): 문단에 정확히 한 번 나오지 않는 문구(`span_not_found`, `span_ambiguous`), 주지 않은 근거(`unknown_source`)
    - 대안에 문단·사실에 없는 수치가 있으면 경고로 표시한다.
  - 독립성: 그 문단을 넣은 Writer 제안의 생성기와 검토자가 같으면 `same_model`(독립 검증 아님), 다르면 `different_model`, 사용자가 쓴 문단이면 `human_written`
  - `createMockReviewer`(`[MOCK]`): 관찰 주장 위의 인과 단정, 결정적 검사 실패, 40단어를 넘는 문장만 지적한다. **낱말 목록으로 지적하지 않는다.**
- 범위 밖(RFC-012 부록)
  - `packages/domain/src/scientific-review/index.ts`
    - `requestReview`, `reviewView`
    - `decideFinding`: intent, 한 번만
    - `requestRepair`
      - 채택한 지적이 하나 이상이어야 한다.
      - 그 문단이 활성 승인 계획에 속해야 한다(아니면 422 `paragraph_not_in_plan`). draft gate도 본다.
      - 문단이 검토 때와 같아야 한다(hash, 아니면 409). 다른 곳 편집은 상관없다.
      - 채택한 지적(문구·이유·대안)을 지시로 묶어 Writer rewrite job 하나를 만든다. 결과는 PW-042/043 검사를 모두 거치는 문단 제안이다.
    - 고쳐 쓴 안이 적용될 수 없으면(검사 실패·근거 부족·변화 없음·STALE·job 실패) `needs_user`로 사용자에게 돌아간다. 다시 시도하지 않는다.
  - `packages/domain/src/writer/index.ts` `paragraphHash`(재사용)
  - `apps/worker/src/writer/index.ts`: MOCK writer가 교정·재작성 때 지시의 `"문구" … → 대안`을 적용한다.
  - `apps/api/src/scientific-review/**`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`, `tests/e2e/manual-paper/harness.ts`
  - `apps/web/src/features/paper/ManuscriptTab.tsx`(검토 panel, 고쳐 쓰기 뒤 제안 목록 새로 고침), `apps/web/src/features/writer/WriterPanel.tsx`(`refreshKey`)
- 화면 `apps/web/src/features/scientific-review/ReviewPanel.tsx`(원고 tab "문단 검토")
  - 문단 고르기와 검토 요청
  - 독립성 표시(같은 모델이면 "독립적인 사실 검증이 아닙니다")
  - 지적마다 종류·범주, 문구(강조), 이유, 근거 종류, 확신도, 대안, 수치 경고, 채택·기각
  - 버린 지적 수와 이유
  - "채택한 지적으로 고쳐 쓰기 (한 번)"과 그 상태. 실패하면 다시 하지 않는다는 안내가 나온다.
- 시험
  - `tests/tasks/PW-044/review.int.test.ts`(통합 9)
  - `review.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-044-A / TST-044A: 구체 span·이유·근거·대안으로 findings를 제시하고 사용자가 최종 채택 | 검토자 입력에 문단, 섹션·목적, 계획의 주장·사실, gate VERIFIED가 있다. 지적은 정확한 문구와 위치(start/end), 근거(claim id), 확신도, 대안, 결정 open으로 저장되고 원고는 그대로다. 문구 없음·두 번 나옴·모르는 근거는 이유와 함께 버려지고, 대안의 새 수치(5)는 경고된다. 채택·기각은 intent가 필요하고(422), 값이 정해져 있으며(422), 남의 논문은 404, 한 번만(409), 메모를 남길 수 있다. 원고는 그대로다. 채택이 없으면 고쳐 쓰기 422다. 채택하면 고쳐 쓰기 → Writer가 받은 지시에 문구와 대안이 있다 → rewrite 제안 PENDING → 사용자가 적용한다. 브라우저: 지적(인과 단정, 문구, 근거, 확신도, 대안) → 채택 → 고쳐 쓰기 → 제안 적용 → 편집기에 새 글 |
| REQ-044-B / TST-044B: 단어 blacklist나 model 자체 점수로 품질을 보장하거나 repair loop가 무한 실행되지 않음 | `quality_score`, 지적의 `score`, 숫자 확신도, rubric 밖 범주(`banned_word`)는 실행 FAILED, 저장 없음이다. "Furthermore"로 시작하는 문단은 MOCK 지적 0이고, 인과 단정만 지적된다. Writer(MOCK)가 쓴 문단을 MOCK이 검토하면 `same_model`이다. 고쳐 쓰기 두 번째는 409다. 고쳐 쓴 안이 수치를 바꾸면 CHECK_FAILED → `needs_user`, draft job은 1개뿐이고 다시 요청해도 409다. 검토 뒤 문단을 손으로 고치면 고쳐 쓰기 409, 계획에서 뗀 문단은 422(paragraph_not_in_plan), 실제 공급자는 허용 없이 WAITING_USER(호출 0)다 |

## RED → GREEN
- RED(`red.log`): 빈 stub으로 9개가 모두 실패했다(route 없음).
- GREEN: 통합 9, 브라우저 1
- mutation(`mutation.log`): 18종 탐지, 동등 변이 1종.
  - 탐지
    - 점수·추가 field·숫자 확신도·rubric 밖 범주
    - 문구 없음·중복·모르는 근거, 대안 수치 경고
    - 독립성, 공급자 허용
    - 결정 intent·한 번
    - 고쳐 쓰기: 채택 필요, 바뀐 문단, 계획 없음, 실패 반환, 지시 내용, 사전 검사와 충돌 변환을 함께 없앰
  - 동등: 고쳐 쓰기 사전 검사만 없애도 DB의 `run_id` 유일성과 409 변환이 그대로 막는다(제한이 DB에 있음).
- 회귀: `pnpm test` exit 0 — unit 344, integration 448, contracts 17, 브라우저 93 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- AI 검토는 지적(finding+source+confidence)만 남긴다. 원고·기록을 바꾸지 않고, 점수로 품질을 보증하지 않는다.
- 같은 모델의 검토는 그렇게 표시한다. 독립적 사실 검증이라고 부르지 않는다(spec 06). 사실 검증은 PW-043 결정적 검사와 사용자의 몫이다.
- 고쳐 쓰기는 검토 하나에 한 번이고(DB 유일성), 결과는 모든 검사를 거친 제안이다. 실패하면 사용자에게 돌아간다(spec 06: 최대 repair 1회).
- 검토자에게는 그 공급자가 볼 수 있는 것만 간다. 실제 공급자는 논문 허용이 필요하다.

## 미실행 / 남은 위험
- 실제 Claude/Codex 검토자는 연결하지 않았다(MOCK만; PW-042와 같은 이유).
- 독립성은 "그 block을 넣은 Writer 제안"으로 판단한다. 그 뒤 사용자가 문단을 크게 고쳤어도 `same_model`로 남는다(보수적).
- 검토 지적의 의미가 맞는지는 판단하지 않는다(범주·문구·근거 형식만 검사). 품질 평가(블라인드 pairwise, gold set)는 PW-045 범위다.
- 계획에 연결되지 않은 문단은 검토할 수 있지만 고쳐 쓰기는 할 수 없다(Writer 계약이 없음).

## 다음
PW-045: 과학적 부정 fixture·rubric gate
