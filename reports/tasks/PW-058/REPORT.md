# PW-058 — Reviewer·제출판 freeze — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
- **리뷰어 의견**(`review_comments`)
  - 사용자가 붙여 넣는다. 차수, 리뷰어, 번호, 본문, 그리고 붙여 넣을 때의 원고 revision(기준)을 저장한다. 불변이다.
- **답**(`review_responses`, 추가만 하고 최신이 유효)
  - 상태는 `addressed`(수정함), `partly_addressed`(일부 수정함), `disagree`, `explained`, `not_addressed`다.
  - **TST-058A** — 수정함·일부 수정함은 링크가 1개 이상 있어야 저장된다. 링크는 `{revision_id, block_id}`이고 서버가 확인한다.
    - 같은 문서의 revision이어야 하고, 의견 기준 revision의 자손(parent 사슬)이며 기준 자신이 아니어야 한다. 아니면 `LINK_NOT_AFTER_COMMENT`다.
    - 그 블록이 기준 revision의 같은 id 블록과 실제로 달라야 한다(바뀜·새 문단·지운 문단). 같거나 둘 다 없으면 `LINK_NOT_A_CHANGE`다.
    - 저장되는 링크에는 바뀜 종류, 절 제목(locator), 전후 블록 해시가 붙는다.
  - 다른 답에는 링크가 없다. DB CHECK가 상태와 링크 개수의 짝을 강제한다.
  - "바뀐 곳" 목록 API: 의견 기준 revision과 현재 head 사이에 바뀐 블록을 절 제목과 전후 글과 함께 준다. 화면은 이 목록에서만 고르게 한다.
  - 목록의 `holds_now`: 수정함 주장이 지금 원고에서도 기준과 다른지 보여 준다. 되돌리면 false다.
- **제출 전 검사**(`checks`)
  - 막는 것(blocking)
    - 내보내기 검사의 오류: 미해결 인용·그림/표 참조(RFC-008, 목록 포함), 글자로 친 인용 번호, 되읽기 불일치
    - 답 없는 의견
    - 지금 원고에 없는 "수정함" 주장(`claimed_change_missing`)
    - 같은 문단에 그대로 남은 과학 검사 FAILED
    - 같은 문단의 미결정 과학 검토 지적
  - 경고(사용자 확인 필요)
    - 내보내기 경고(불완전 문헌, 철회 문헌 등)
    - 반영하지 않음 답
    - 실패나 지적 뒤 바뀐 문단(다시 검사 필요)
    - 판단하지 못한 검사(UNKNOWN). 통과로 치지 않는다.
- **제출판 확정**(`submissions`, 사용자 행위, intent `freeze_submission`)
  - `expected_revision_id`가 현재 head와 다르면 STALE이다.
  - head에서 먼저 검사한다.
    - 제출용(`submission_ready`)인데 막는 문제가 있으면 409 `NOT_SUBMISSION_READY`(목록)이고, 스냅샷도 묶음도 만들지 않는다.
    - 경고가 있는데 `confirm_warnings`가 없으면 409 `CONFIRM_WARNINGS`다.
  - 통과하면 다음 순서로 진행한다.
    1. 이름 붙인 스냅샷을 만든다.
    2. 스냅샷이 확인한 revision을 고정했는지 본다.
    3. 그 스냅샷의 보관용 원본 묶음(PW-057)을 만든다.
    4. **묶음 안의 렌더 보고로 다시 검사한다.** 묶음이 incomplete이거나 자체 검증에 실패하면 막는다.
    5. 저장한다: 스냅샷, 묶음 export, 문서·revision, DOCX SHA-256, 검사 결과, 의견–답–위치 trace(그 시점의 `holds`), 도구 버전, 확정자.
  - 불변이다. 제출용 행은 막는 문제 목록이 비어 있어야 한다(`submissions_ready_clean` CHECK). 뒤의 편집은 제출판을 바꾸지 않는다(시험).
  - 초안(`draft`)은 문제가 있어도 고정할 수 있고, 문제는 함께 기록된다.
  - 자동 투고는 없다.
- **답변표**: `GET …/submissions/:id/response-table`(Markdown 첨부). 표 깨짐(`|`, 줄바꿈)은 escape한다.
- **화면**: 버전 탭의 "리뷰어 의견과 제출판" 패널
  - 의견 붙여 넣기
  - 답하기: 상태, 답변, 그리고 바뀐 문단만 고를 수 있는 목록
  - 주장이 사라지면 경고
  - 제출 전 검사(막는 문제·경고 목록), 경고 확인 체크, 제출용 확정·초안 고정
  - 제출판 목록(DOCX 해시, 원본 묶음, 답변표)

## 결정(위임) — RFC-014 부록 PW-058
- domain(`packages/domain/src/submissions`)은 렌더·스냅샷·묶음을 주입받는다(exports가 domain에 의존하므로 순환을 피함). API glue가 PW-056·009·057 함수를 넘긴다.
- 무엇이 제출용을 막고 무엇이 경고인지는 위와 같다. 철회 문헌 인용은 경고(확인 필요)로 두었다. 철회를 논의하려고 인용하는 경우가 있기 때문이다.
- "수정함"의 판정은 블록 단위다(같은 id 블록의 내용 해시). 의견이 정말 그 문장에 반영됐는지(의미)는 판단하지 않는다. 사용자가 고른 블록이 실제로 바뀌었는지만 보장한다.

## 변경 파일
- write scope
  - `packages/domain/src/submissions/index.ts`
  - `apps/web/src/features/submission/SubmissionPanel.tsx`
  - `db/migrations/pw_058_0001_submissions.sql`
  - `tests/tasks/PW-058/{submission.int.test.ts(통합 9), table.test.ts(unit 2), submission.e2e.ts(브라우저 1)}`
  - `reports/tasks/PW-058/**`
- 범위 밖(RFC-014 부록): `apps/api/src/submissions/index.ts`, `apps/api/src/server.ts`, `apps/web/src/features/versions/VersionsTab.tsx`

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-058-A / TST-058A | 통합: 기준 revision 기록, 링크 없음·기준 revision·바뀌지 않은 블록·없는 블록·이전 revision·다른 논문 revision 거부, 바뀐 곳 목록(절 제목·전후), 확정 → 스냅샷 revision·묶음 DOCX 해시·trace·뒤 편집 무관·UPDATE/DELETE 거부, 답변표 | 통과 |
| | 브라우저: 바뀐 문단만 고를 수 있음, 답 저장, 제출용 확정, 답변표·DOCX 해시 | 통과 |
| REQ-058-B / TST-058B | 통합: 답 없는 의견 → 409(스냅샷 미생성) / 초안은 기록과 함께 고정, 되돌린 수정 → `claimed_change_missing`·`holds_now=false`, RFC-008 미해결 인용·그림 목록, 과학 검사 FAILED·미결정 과학 지적 → 막음 / 문단 변경 뒤 경고, 경고 확인 필요, STALE·intent 없음·잘못된 상태·다른 사용자 거부, DB CHECK | 통과 |
| | 브라우저: 답 없는 의견으로 제출용 확정 거부·사유 표시, 바뀐 문단 없으면 "수정함" 저장 불가 | 통과 |

## RED → GREEN
- RED: `red.log` — 9개 모두 실패(라우트 없음)
- GREEN: 통합 9, unit 2, 브라우저 1
- 시험 하나의 기대값을 바꿨다. 의견을 받은 그 revision에 거는 링크는 "바뀌지 않음"보다 정확한 "의견 뒤 revision이 아님"으로 거부된다.

## 보안·과학적 실패 경로
- 사용자가 실제로 고치지 않은 곳을 "수정함"으로 답하면 서버가 거부한다. 고친 뒤 되돌리면 확정 시점에 잡힌다.
- 막는 문제가 남은 원고는 API, domain, DB CHECK 어디에서도 제출용으로 저장되지 않는다.
- 확정 사이에 원고가 바뀌면 STALE(expected revision, 스냅샷 고정 revision 확인)이다.
- head 검사와 묶음 검사 사이에 문헌이 바뀌어도 묶음 자체 렌더로 다시 검사한다.
- 답변표는 Markdown 첨부(`nosniff`)이고 표 구분자를 escape한다. HTML로 보여 주지 않는다.

## 미검증·남은 위험
- 의견이 의미상 반영됐는지는 판단하지 않는다(블록 변경만 보장).
- 문단을 나누거나 합쳐 블록 id가 바뀌면 "지운 문단 + 새 문단"으로 보인다. 링크는 새 문단에 걸면 된다.
- 의견의 기준은 붙여 넣을 때의 head다. 예전 제출판에 대한 의견도 지금 head 기준으로 비교된다.
- 리뷰어 의견 가져오기(파일)와 Word 변경 추적 왕복은 없다(spec 10: 동일하지 않음 명시).
- 확정 중 head 검사는 통과했는데 묶음 재검사에서 거절되면 스냅샷과 묶음이 남는다(드묾. 기록으로 남는 것은 해가 없다).
- 학술지 CSL 양식은 여전히 없다(PW-056 결정).

## 다음
PW-059(보안 감사)
