# PW-041 — WritingProfile 생성·승인 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_041_0001_writing_profile.sql`
  - job intent `propose_profile`
  - `writing_profile_runs`: 제안 실행 기록(생성기, 표지, 입력 hash). 바꿀 수 없다.
  - `writing_profile_revisions`: 버전마다 내용·content hash·읽은 자료 기록(`sources`)·저장하지 않은 것(`removed`). 내용은 바꿀 수 없고 상태만 DRAFT → APPROVED → SUPERSEDED로 간다(trigger). 논문마다 승인본은 하나다(unique index).
  - `writing_profile_feedback`: 사용자 의견. 다음 제안의 후보일 뿐이다. 바꿀 수 없다.
- `packages/domain/src/jobs/index.ts`: `JOB_INTENTS`에 `propose_profile`
- `packages/domain/src/writing-profile/index.ts`
  - `sectionsOf`: 원문 PDF에서 뽑은 글에서 섹션을 찾는다. 제목은 한 줄로 따로 있어야 한다(번호·대문자·콜론 허용; Materials and Methods → Methods, Results and Discussion은 따로).
  - `readWritingSources`: 생성기가 실제로 읽는 것
    - 그 논문의 참고문헌이어야 한다(아니면 404).
    - 원문이 파싱됐고, 보관 근거가 정해졌고(`keep_right`), 외부 AI라면 그 원문을 보낼 수 있고 논문이 그 공급자를 허용해야 글을 준다.
    - 아니면 `METADATA_ONLY`이고 이유(`withheld`)를 남긴다.
    - 읽은 깊이: `FULLTEXT_PARSED`, `ABSTRACT_ONLY`, `UNSECTIONED`(글은 있으나 섹션 제목을 못 찾음), `METADATA_ONLY`
  - `parseProfileContent`: spec 06의 항목을 엄격하게 검사한다(모르는 field 거부). 저널 규정 snapshot(원문·출처·확인일·적용 article type)은 사용자만 쓸 수 있다.
  - `checkAgainstSources`: 규칙·패턴·예시를 읽은 것과 맞춘다.
    - 읽지 않은 섹션에서 나온 규칙: `section_not_read`
    - 다른 섹션을 근거로 든 섹션 규칙(예: 초록으로 Discussion 규칙): `source_section_is_not_the_role_section`
    - 출처 없는 규칙(제안일 때): `no_source`
    - 읽은 원문과 8단어 이상 이어서 같은 문구: `copied_from_source`
    - 요청에 없던 참고문헌을 출처로 들면 답 전체를 거부한다.
  - `requestProfileRun`, `profileView`(승인본, 최근 버전, 버전 목록, 의견)
  - `createOwnRevision`: 사용자가 직접 쓴 버전
    - 최근 버전을 바탕으로 해야 한다(아니면 409).
    - 사용자 선호는 출처 없이 쓸 수 있다. 출처를 들면 그 섹션은 읽은 것이어야 한다.
    - 원문 문구를 옮기면 저장하지 않고 이유를 알려 준다(422).
  - `approveProfileRevision`: 명시 intent `approve_profile`과 읽은 버전의 content hash가 필요하다. 승인하면 이전 승인본은 SUPERSEDED가 된다.
  - `addProfileFeedback`
- `apps/worker/src/writing-profile/index.ts`
  - `profileHandlers`
    - 실제 공급자는 논문이 허용해야 한다. 허용하지 않으면 아무것도 읽기 전에 `WAITING_USER`다.
    - 생성기 답은 `{ profile }`만 받는다. 검사에서 걸리면 실행이 FAILED이고 아무것도 저장하지 않는다.
    - 사용자의 저널 규정은 생성기에 보이지 않고, 새 제안에 그대로 이어진다.
    - 저장은 job 완료와 함께(fenced) 한다.
  - `createMockProfileGenerator`: 읽은 섹션에서만 일반 원칙을 만든다. `[MOCK]` 표지가 있고 원문을 인용하지 않는다.
- 범위 밖(RFC-012 부록)
  - `apps/api/src/writing-profile/index.ts`(route), `apps/api/src/server.ts`
  - `apps/worker/src/main.ts`(handler 등록)
  - `apps/web/src/features/writing-profile/WritingProfilePanel.tsx`, `apps/web/src/features/paper/PaperPage.tsx`("글쓰기 프로필" tab)
  - `tests/e2e/manual-paper/harness.ts`(시험용 worker에 handler 등록)
- 화면 "글쓰기 프로필" tab
  - 참고할 논문 고르기, "프로필 제안 요청"
  - 최근 버전: 상태와 MOCK 표지, 읽은 자료(읽은 깊이·섹션·읽지 못한 이유), 섹션별 역할의 원칙과 피할 것(각각 [논문 · 섹션]), 저장하지 않은 것과 이유
  - "이 버전 승인"
  - 저널 규정(내용·출처·확인 날짜) → 새 초안
  - 의견 남기기
- 시험
  - `tests/tasks/PW-041/profile.int.test.ts`(통합 8)
  - `sections.test.ts`(unit 6)
  - `profile.e2e.ts`(브라우저 1)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-041-A / TST-041A: profile은 근거 reference/섹션/규칙/반례와 승인 상태를 가진다 | 생성기가 받는 자료: 다 읽은 논문은 FULLTEXT_PARSED [Introduction, Discussion], 초록만 있는 논문은 ABSTRACT_ONLY, 원문 없음은 METADATA_ONLY. 제안은 DRAFT이고, 원칙과 반례마다 [참고문헌, 섹션]이 있으며, 버전에 읽은 자료 기록이 남는다. 승인에는 intent(422)와 정확한 hash(409)가 필요하고 남의 논문은 404다. 사용자가 저널 규정을 넣은 초안을 만들어도 승인본은 그대로다. 그 초안을 승인하면 이전 것은 SUPERSEDED이고, 내용 변경은 DB가 막는다. 다음 제안에도 저널 규정이 그대로 이어지며 생성기에는 보이지 않는다. 의견은 candidate로 남아 다음 제안의 입력이 되고 승인본을 바꾸지 않는다. 브라우저: 제안 → 출처 표시 → 승인 → 저널 규정 초안 → 의견 |
| REQ-041-B / TST-041B: abstract-only로 Discussion style을 만들거나 특정 문구를 대량 복사해 profile로 저장하지 않는다 | 초록만 읽은 논문, 서지만 있는 논문을 근거로 든 Discussion 규칙은 `section_not_read`, 초록을 근거로 든 Discussion 규칙은 `source_section_is_not_the_role_section`, 출처가 없으면 `no_source`로 빠진다. 원문 문구를 옮긴 원칙·패턴·예시 3개는 `copied_from_source`로 빠진다. 생성기가 저널 규정, 모르는 field, 요청 밖 참고문헌을 쓰면 실행이 FAILED이고 저장되는 것이 없다. 남의 참고문헌은 404다. 보관 근거가 정해지지 않은 원문은 읽지 않는다. 외부 AI에는 논문 허용(없으면 WAITING_USER, 생성기 호출 0)과 원문별 전송 허용이 필요하다. 거부된 원문의 글은 입력에 없다. 사용자의 직접 수정도 읽지 않은 섹션 출처와 원문 문구 복사는 422, 오래된 바탕은 409다 |

## RED → GREEN
- RED(`red.log`)
  - 1차: 모듈이 없어 실패했다.
  - 2차: 빈 stub으로 8개 모두 실패했다(route 없음 404).
  - unit 6개는 구현 뒤에 썼다. 대신 mutation으로 보였다.
- GREEN: 통합 8, unit 6, 브라우저 1
- mutation(`mutation.log`): 21종 모두 탐지.
  - 섹션: R&D가 두 역할을 맡음, 번호 붙은 제목, 복사 기준 8단어
  - 출처 검사: 역할 섹션, 읽지 않은 섹션, 출처 없음, 규칙 복사, 예시 복사, 요청 밖 참고문헌
  - 저널 규정을 생성기가 씀
  - 읽기 gate: 보관 근거, 원문별 전송, 논문의 공급자 허용
  - 승인: hash, intent, 이전 승인본 교체
  - 사용자 수정: 오래된 바탕, 검사
  - worker: 저널 규정 이어받기, 의견 전달, 답의 모르는 key
- 회귀: `pnpm test` exit 0 — unit 288, integration 420, contracts 17, 브라우저 90 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- profile에는 원문 글이 저장되지 않는다(`sources`에는 참고문헌, 원문 hash, 추출기, 읽은 섹션 이름만 있다). 원문 문구를 옮긴 규칙·예시는 저장되지 않는다. spec 06은 이것을 "source-similarity warning"이라고 부른다. 법적 표절 판정이 아니다.
- 외부 AI에는 논문의 공급자 허용과 원문별 전송 허용을 모두 통과한 글만 간다. 민감 논문은 보내지 않는다.
- 승인, 저널 규정, 의견 반영은 사용자의 행위다. AI가 승인하거나 저널 규정을 만들 수 없다.

## 미실행 / 남은 위험
- 섹션 찾기는 한 줄짜리 제목만 본다. 제목이 본문과 같은 줄에 붙거나 표준과 다른 이름이면 그 섹션은 "읽지 않음"이 된다(안전한 쪽: 규칙이 빠진다).
- 복사 검사는 단어 8개가 이어서 같은지만 본다. 말을 바꾼 재현은 잡지 못한다.
- 사용자의 직접 수정에서 원문이 그 사이 바뀌었으면(hash 다름) 복사 검사는 기록된 읽은 섹션 이름으로만 하고 글은 비교하지 못한다.
- 실제 공급자 생성기는 PW-042와 함께 연결한다. 지금은 MOCK만 등록돼 있다.
- 용어집 편집 화면은 없다(API로만).

## 다음
PW-042: Writer(문단 생성)

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 2, NIT 3)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 검사하지 않는 글 field(섹션 역할 설명, claim_strength_policy, target_audience, 용어 메모)로 원문 문구와 읽지 않은 섹션의 style이 저장됨. 규칙이 모두 빠진 섹션 역할도 남음 | 제안과 사용자 수정 모두 **모든 글 field**에 복사 검사를 한다. <br>• audience·policy: 비우고 기록 <br>• 용어 항목: 어느 칸이든 복사면 항목째 빼고 기록 <br>• 섹션 역할 설명: 복사면 역할째 뺌 <br>• article type: 복사면 답 전체 거부 <br>제안에서 어떤 자료도 읽지 않은 섹션의 역할은 `section_not_read`로 빠진다. 근거 있는 규칙이 하나도 남지 않은 역할은 `no_rule_left`로 빠진다. 사용자 수정에서는 출처 없는 역할도 선호로 허용한다 | 리뷰어 probe를 시험으로 만들었다: audience·policy 비움, 용어 1개 빠짐, 복사한 역할·Methods(아무도 안 읽음)·규칙이 다 빠진 Introduction 역할 빠짐, 읽은 역할만 남음. 복사한 article type은 FAILED. 사용자 수정의 policy 복사는 422 |
| MINOR 1: 빠진 복사 문구가 `removed`에 그대로 저장·표시됨 | `maskCopied`: 앞 세 단어, 단어 수, sha256 앞 12자리만 남긴다. 다른 사유로 빠진 항목도 복사 문구를 담고 있으면 같은 방식으로 남긴다. 사용자 수정 거부 응답도 같다 | 저장된 버전 전체와 422 응답에 원문 구절이 없다. unit: mask 형식 |
| MINOR 2: References·감사의 글 등이 마지막 섹션 글로 읽힘 | References, Bibliography, Literature Cited, Acknowledg(e)ments, Funding, Author contributions, Competing interests, Conflict of interest, Declarations, Data availability, Supplementary, Supporting information이 앞 섹션을 끝낸다. 그 뒤 글은 다음 섹션 제목까지 읽지 않는다 | unit: 리뷰어 probe와 back matter 제목 9종 |
| NIT: 이전 draft를 승인하면 더 새 승인본(저널 규정)이 밀려남 | 그대로 둔다. 정확한 hash에 대한 사용자의 명시 행위다. 화면의 승인 버튼은 최근 버전에만 있다 | — |
| NIT: 바탕이 없는데 parent를 주면 오해할 메시지 | "parent_revision_id must be null: there is no profile version yet" | 통합 |
| NIT: 복사 검사는 말 바꾼 재현을 못 잡음 | 화면 문구를 "여덟 단어 이상 그대로 옮긴 글"로 바꾸고, 말을 바꾼 재현은 못 찾는다고 적었다 | — |

- RED(`red-review.log`): 2a6af9e 구현으로 새·바뀐 시험 4개가 실패한다(통합 2, unit 2).
- GREEN: 통합 9, unit 8, 브라우저 1.
- mutation(`mutation.log` 하단): 11종 모두 탐지.
- 회귀: `pnpm test` exit 0 — unit 290, integration 421, contracts 17, 브라우저 90 (`pnpm-test-review.log`).
