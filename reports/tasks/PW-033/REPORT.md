# PW-033 — AI 문헌 후보 선정 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_033_0001_curation.sql`
  - `curation_runs`: 누가(assessor, MOCK 표시) 어떤 검색을 어떤 개요(brief hash)로 평가했는지. 바꿀 수 없다.
  - `curation_assessments`: 후보마다 용도(scientific/writing/both/exclude), 주제·논문 유형 적합, 문체 적합, 읽은 범위, 이유, 제외 이유, 시스템 경고. 바뀌는 것은 소유자의 결정(accepted/rejected, 채택 용도) 한 번뿐이다(trigger).
- `apps/worker/src/curation/index.ts`
  - `CurationAssessor` 인터페이스. `createMockAssessor()`는 MOCK으로 표시된다. 일부러 "highly cited → 문체 좋음"이라는 흔한 실수를 한다.
  - `checkAssessments`: 답을 엄격하게 검사한다. 모르는 후보, 빠진 후보, 중복, 허용 밖 값·필드, 이유 없는 제외는 run 전체를 실패시킨다. 일부만 저장하지 않는다.
  - assessor가 바꿀 수 없는 시스템 규칙:
    - 읽은 범위는 시스템이 아는 값이다(검색 후보는 `METADATA_ONLY`). assessor의 주장이 아니다.
    - 본문을 읽지 않았으면 문체 적합은 "알 수 없음"이다. 바꿨다는 경고(`style_needs_full_text`)를 남긴다.
    - 철회된 논문은 과학 근거로 제안하지 않는다(`exclude`로 바꾸고 `retracted`, `role_overridden` 경고).
    - preprint는 경고한다.
  - `curationHandlers`: job payload `{kind:'curate', search_ids}`를 이 논문의 성공한 검색으로만 받는다. 결과는 job 완료 트랜잭션(fencing) 안에서만 저장한다. 취소되거나 빼앗긴 run은 아무것도 남기지 않는다.
- `apps/web/src/features/curation/{CurationTab.tsx, labels.ts}`: "문헌" tab
  - 검색·후보 수, "후보 평가 요청", 평가자와 MOCK 배지, 후보마다 용도·적합·문체·읽은 범위·이유·제외 이유·경고.
  - 채택(용도 선택)·채택 안 함. 철회 논문은 "문체 참고"만 고를 수 있다.
- 범위 밖(RFC-011 부록)
  - `packages/domain/src/curation/index.ts`
    - `curationView`, `listSearches`
    - `requestCuration`: 검색 id 1–20개, 이 논문의 성공한 검색인지 확인, 중복 제거, `literature_search` job 등록(idempotency key)
    - `decideAssessment`: 결정은 한 번. 채택하면 `ingestCandidate`(PW-032)로 서재에 넣고 논문 참고문헌에 용도와 함께 넣는다. 철회 논문은 `writing` 외 용도로 채택하지 못한다(422). 논문에 이미 있던 작품은 기존 용도를 유지하고 응답 `project_use_role`로 알린다.
  - `apps/api/src/curation/index.ts`
    - `GET /api/papers/:paperId/curation`
    - `POST …/curation/runs`
    - `POST …/curation/assessments/:id/decision`
  - `apps/api/src/server.ts`(등록), `apps/worker/src/main.ts`(handler 등록, MOCK), `apps/web/src/features/paper/PaperPage.tsx`(tab), `tests/e2e/manual-paper/harness.ts`(시험 worker에 같은 handler)
- 시험
  - `tests/tasks/PW-033/curation.int.test.ts`(통합 12)
  - `tests/tasks/PW-033/curation.e2e.ts`(브라우저 1)
  - 증거 화면: `curation-tab.png`

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-033-A / TST-033A 용도·적합성·제외 사유가 사용자에게 보인다 | 통합: 모든 후보에 용도, 적합, 읽은 범위, 이유가 있고, 제외된 후보는 이유가 있다. 소유자가 용도와 함께 채택하거나 거절한다. 결정은 한 번이고, 남은 404다. 제외가 아닌 후보의 제외 이유는 버린다 |
| | 통합: 실행 요청 route(잘못된·남의·다른 논문의 검색 id 거부, 중복 제거, idempotent), 검색 목록 |
| | 브라우저: "문헌" tab에서 요청 → MOCK 평가 표시 → 용도·적합·읽은 범위·경고·제외 이유가 보인다 → "문체 참고"로 채택, 다른 하나는 거절. DB에 `use_role = writing` 하나만 생긴다 |
| REQ-033-B / TST-033B 인용수로 문체 품질을 확정하지 않고, 후보 발견만으로 승인 상태를 바꾸지 않는다 | 통합: "highly cited" 제목에 MOCK이 "good"을 주어도 저장값은 `unknown`이고 경고가 남는다. 메타데이터뿐인 후보는 모두 문체 `unknown`이다 |
| | 통합: run은 참고문헌, story/outline, 서재 작품 수를 바꾸지 않는다. 평가 행은 바꿀 수 없다 |
| | 통합: 철회 논문은 과학 근거로 제안되지 않고, 소유자도 scientific/both로 채택할 수 없다(writing만) |
| | 통합: 형식이 틀린 답(모르는 후보, 틀린 값, 이유 없는 제외, 추가 필드 `approve_profile`, 빠진 후보)은 run을 실패시키고 아무것도 저장하지 않는다. 다른 논문의 검색을 담은 payload도 실패한다 |

## RED → GREEN
- RED(`red.log`): 구현(migration, domain·worker·api 모듈)을 빼고 실행했다. 모듈이 없어 시험 파일 전체가 실패했다.
  - 행동 단위 RED는 mutation이 맡는다.
- GREEN: 통합 12, 브라우저 1.
- mutation(`mutation.log`): 17종.
  - 처음 실행에서 5종이 살아남았다(빠진 후보 허용, 제외 아닌 후보의 제외 이유, worker 쪽 검색 범위, 결정 전 사전 검사, 이미 있던 용도). 시험 5개를 더했다.
  - 그 뒤에도 2종이 다른 이유로 가려져 있었다. 하나는 후보가 없어 실패한 경우, 다른 하나는 앞 시험이 이미 서재에 넣은 DOI였다. 시험을 좁혀 모두 탐지했다.
- 회귀: `pnpm test` exit 0 — unit 278, integration 274, contracts 17, 브라우저 81, spikes·evals·pack PASS(`pnpm-test.log`).

## 보안·과학적 실패 경로
- AI는 제안만 한다. 서재·논문 참고문헌에 들어가는 것은 소유자의 채택뿐이고, 서버가 결정 한 번, 소유권, 용도 값, 철회 규칙을 검사한다.
- 문체 품질은 본문 없이 확정하지 않는다. 인용수·학술지 이름은 근거가 아니다.
- 철회 논문은 근거로 쓰이지 않는다. assessor 제안에서도, 사용자 채택에서도 막는다.
- 읽은 범위는 시스템이 기록한다. assessor가 "본문을 읽었다"고 주장할 수 없다.
- 형식이 틀리거나 범위를 벗어난 답(승인 같은 추가 필드 포함)은 run 전체를 실패시킨다.

## 미실행 / 남은 위험
- 실제 provider assessor는 없다. MOCK만 등록했고 화면에 MOCK으로 보인다. 실제 연결은 RFC-010(sandbox 안 실행) 구현 뒤다.
- 지금 후보는 모두 `METADATA_ONLY`라서 문체 평가는 늘 "알 수 없음"이다. 초록·본문은 PW-034(원문 권리·업로드)와 PW-035 뒤에 들어온다.
- 채택 시 서재 등록(`ingestCandidate`)은 결정 트랜잭션 전에 따로 커밋된다. 동시에 같은 평가를 두 번 결정하면 한쪽은 409지만, 서재에 작품이 이미 들어가 있을 수 있다. 서재는 논문 상태가 아니고 같은 작품은 식별자로 합쳐지므로 해는 작다.
- 화면은 새로 고침 버튼으로 결과를 다시 읽는다(실시간 알림 없음).

## 다음
PW-032 리뷰 반영(식별자 등록, 버전 중복, 철회 고지 역방향) → PW-031 nit → PW-034: 원문 권리·안전한 업로드

## 리뷰 반영 (2026-10-09, 리뷰: changes requested — MINOR 3, NIT 5)
- MINOR 1: 본문을 읽지 않았으면 문체 참고 제안도 바꾼다(`writing` → `exclude`, `both` → `scientific`, 경고 `writing_role_needs_full_text`). 인용이 많다는 이유로 "문체 참고 후보"가 되지 않는다.
- MINOR 2: 작품 상태는 시스템이 모은다. 다음 세 곳을 본다.
  - 후보 자신의 flag
  - 같은 run 안에 있는 고지가 가리키는 DOI
  - 서재가 이미 아는 고지·flag(`noticesForDoi`, 아직 서재에 없는 DOI도 포함)
  - 처리
    - 철회된 작품은 제외한다.
    - 고지 기록 자체(철회·정정 고지)는 근거가 아니므로 제외하고 `notice_record` 경고를 단다.
    - 정정·우려 표명·갱신은 경고(`corrected`, `expression_of_concern`, `updated`)로 보이고, 용도는 바꾸지 않는다.
  - assessor 입력에도 `status`·`is_notice`를 넘긴다.
- MINOR 3: 결정은 한 트랜잭션이다. 평가 행을 `FOR UPDATE`로 잡고 → 결정 → (채택이면) `ingestCandidateIn` → 논문 참고문헌. 경쟁에서 진 요청은 409이고 서재에 흔적이 남지 않는다(시험: 동시 채택·거절 6회).
- nit
  - 철회 논문은 용도가 미리 선택되지 않는다. 고르기 전에는 "채택"이 비활성이다.
  - 논문에 이미 과학 근거로 든 철회 논문을 채택하면 응답 `warnings: ['retracted_work_used_as_scientific']`로 알리고 화면에 보인다.
  - `literature_search` job은 `kind`로 나눠 처리한다(`literatureSearchHandler`). 모르는 kind는 분명한 메시지로 실패한다.
  - 평가 → 후보는 복합 FK `(paper_id, candidate_id)`라서 다른 논문 후보를 가리킬 수 없다(`pw_033_0002`).
  - 외부 텍스트를 데이터로 넘기는 요구는 RFC-010에 추가했다(실제 provider 연결 시).
- 시험: 통합 18(+6), 브라우저 1(갱신). RED는 `review-red.log`. mutation은 `mutation.log`에 13종을 추가했고 모두 탐지했다. 1종은 시험을 더한 뒤 탐지됐다.
- 남은 위험 갱신: 결정 경쟁 문제는 해결했다(위 항목 대체).
- 회귀(리뷰 반영 후): `pnpm test` exit 0 — unit 278, integration 291, contracts 17, 브라우저 81(`reports/tasks/PW-033/pnpm-test-review.log`).
