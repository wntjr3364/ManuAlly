# PW-046 — 개요→집필 연구자 workflow — REPORT
상태: in_review (2026-10-10)

## 무엇을 확인했고 무엇이 비어 있었나
- 확인 전 상태
  - 개요 노드의 `section`은 이미 자유 텍스트였다. IMRaD를 강제하지 않았다.
  - 그러나 개요의 섹션과 역할이 원고 구조로 이어지지 않았다.
    - Writer의 새 문단은 위치를 고르지 않으면 언제나 원고 끝에 붙었다.
    - 원고에 섹션 제목을 만드는 길은 손으로 치는 것뿐이었다.
  - 새 논문 화면은 `research_article`만 만들었다. 소프트웨어·리소스 논문을 만들 수 없었다.
  - 글쓰기 프로필의 섹션 역할은 IMRaD 이름 7개만 받았다. 소프트웨어 논문의 "Implementation" 역할은 거부되었다.
  - prose 신호는 Methods가 아닌 모든 섹션의 번호 목록을 경고했다. Implementation·Installation·Usage의 단계 목록도 "보고서 목록"으로 경고되었다.
- 이 Task는 이 빈틈을 메웠다. 기존 승인·정본 규칙은 그대로다.

## 변경 파일
- 시험(write scope)
  - `tests/tasks/PW-046/workflow.int.test.ts`(통합 7)
  - `tests/e2e/scientific-workflow/workflow.e2e.ts`(브라우저 2: 생물학 연구 논문, 소프트웨어 논문)
- 범위 밖 제품 파일(RFC-012 부록, 새 의존성·migration 없음)
  - `packages/domain/src/manuscript-structure/index.ts`(새 파일)
    - `SECTION_TEMPLATES` / `sectionTemplate()`: 유형별 섹션 **제안**(`enforced: false`). 연구 논문은 Introduction·Results·Discussion·Methods다. 소프트웨어·리소스는 Introduction·Implementation·Usage·Validation·Availability다. 방법론은 Introduction·Method·Validation·Protocol이다. 리뷰는 Introduction·Perspectives다. 단보와 기타는 제안이 없다.
    - `scaffoldFromOutline()`: "개요로 원고 골격 만들기"
      - 활성 승인 개요의 섹션(첫 등장 순, 중복 제거)을 원고의 섹션 수준(가장 높은 제목 수준, 없으면 1) 제목으로 넣는다.
      - **없는 섹션만** 넣는다. 같은 이름(대소문자·공백·앞 번호·끝 구두점 무시)의 섹션 수준 제목을 있는 것으로 본다(리뷰 반영).
      - 빠진 섹션은 개요에서 앞선 섹션의 끝 다음에 들어간다(하위 제목 포함). 앞선 섹션이 없으면 뒤따르는 섹션의 제목 앞, 둘 다 없으면 끝이다(리뷰 반영).
      - 사용자가 쓴 글은 바꾸거나 옮기지 않는다.
      - expected head가 맞아야 한다(다르면 409). 활성 승인 개요여야 한다(아니면 409 `outline_not_active`). 원고 문서만 된다(아니면 422).
      - 사용자의 편집이다(revision reason `manual`). 한 트랜잭션 안에서 문서 head를 잠그고 쓴다.
    - `sectionEnd()`: 그 섹션의 마지막 블록. 같거나 높은 수준의 다음 제목 앞까지다.
  - `packages/domain/src/writer/index.ts`: 위치를 고르지 않은 새 문단은 **계획의 섹션 끝**에 들어간다. 원고에 그 제목이 없으면 이전처럼 원고 끝이다. 사용자가 고른 위치는 그대로 따른다. 기본 위치 문단은 섹션 제목을 기억해 적용 때의 섹션 끝에 들어가고, 제목이 바뀌었을 때만 STALE이다(리뷰 반영). 그 밖의 CAS·STALE 규칙(PW-042)은 같다.
  - `packages/domain/src/revisions/index.ts`: `appendRevisionIn`의 reason에 `manual`을 더했다(DB check는 이미 허용).
  - `packages/domain/src/writing-profile/index.ts`: 섹션 역할의 섹션 이름은 그 논문의 것이다(자유 텍스트 1–60자). 근거 출처의 섹션은 여전히 문헌에서 읽은 섹션이다. AI 제안에서는 읽은 섹션이 그 역할을 받치지 않으면 여전히 `section_not_read`로 빠진다.
  - `packages/domain/src/scientific-checks/index.ts` `proseSignals`: 절차를 쓰는 섹션(method, protocol, procedure, implementation, install, usage, availability, tutorial, workflow를 이름에 포함)의 번호 목록은 경고하지 않는다. Discussion 등의 번호 목록은 그대로 경고다.
  - `apps/api/src/manuscript-structure/index.ts`(새 파일), `apps/api/src/server.ts`
    - `GET /api/papers/:paperId/section-template`
    - `POST /api/papers/:paperId/documents/:documentId/scaffold`
  - 화면
    - `apps/web/src/features/paper/PapersPage.tsx`: 새 논문의 **논문 유형** 선택(연구 논문, 소프트웨어·리소스, 방법론, 리뷰, 단보, 기타)
    - `apps/web/src/features/paper/StoryOutlineTab.tsx`: 섹션 입력칸의 제안 목록(datalist)과 "흔한 섹션(제안, 필수 아님)" 안내. 어떤 이름이든 쓸 수 있다.
    - `apps/web/src/features/manuscript-structure/ScaffoldFromOutline.tsx`(새 파일), `apps/web/src/features/paper/ManuscriptTab.tsx`: 원고 tab의 "원고 골격" 카드. 승인된 개요의 섹션을 보여 주고 버튼으로 만든다. 저장되지 않은 편집이 있으면 막는다.
    - `apps/web/src/features/writer/WriterPanel.tsx`: 기본 위치 문구를 "자동: 계획의 섹션 끝(없으면 원고 끝)"으로 바꿨다.

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-046-A / TST-046A: 서로 다른 article type의 outline과 섹션 역할이 원고에 반영된다 | 통합: 연구 논문 개요(Introduction·Results·Discussion)가 그 순서의 제목이 된다. Results 계획의 문단은 Results 아래(Discussion 앞)에, Discussion 계획은 끝에, Introduction 계획은 Results 앞에 들어간다. 사용자가 쓴 "introduction" 제목과 문단은 그대로이고 Results만 더해진다. 하위 제목이 있는 Introduction과 Discussion 사이에 Results가 들어간다. 반복된 섹션은 제목 하나다. 낡은 head·다른 개요는 409, 다른 사용자는 404, 원고 아닌 문서는 422다. 다시 하면 아무것도 더하지 않는다. 소프트웨어 프로필이 "Implementation" 역할을 가진다. 브라우저: 두 유형 모두 같은 흐름이다. 논문 유형 선택 → 유형별 제안 → 승인된 개요 → 골격 → 계획의 문단이 그 섹션 아래(계획의 문헌 발췌는 보낼 수 없어 인용되지 않음) → 교정 요청 뒤에도 그 자리 → 다시 골격은 "모두 있음" |
| REQ-046-B / TST-046B: 모든 유형을 고정 IMRaD나 보고서 목록으로 강제하거나 사용자 승인 없이 novelty를 바꾸지 않는다 | 통합: 소프트웨어 제안에는 Implementation·Availability가 있고 Methods가 없다. 단보는 제안이 거의 없다(`enforced: false`). 소프트웨어 개요(Background·Implementation·Use cases·Availability)의 원고에 Introduction·Methods·Results·Discussion이 더해지지 않는다. Implementation·Installation·Usage·Materials and Methods·Protocol의 단계 목록은 경고가 아니고 Discussion의 목록은 경고다. 골격·Writer 뒤에도 스토리 revision은 1개이고 novelty는 승인한 그대로다. 브라우저: 소프트웨어 논문 원고에 IMRaD 제목이 없다. 두 유형 모두 스토리 revision 1개, novelty 그대로다 |

## RED → GREEN
- RED(`red.log`): 통합 6개 중 5개가 이유 있게 실패했다.
  - scaffold route 없음(404), section-template 없음, 프로필의 "Implementation" 거부(422), prose 신호 목록 경고
  - novelty 시험은 처음부터 통과했다(기존 Writer가 스토리를 바꾸지 않음). 회귀 방지로 남긴다.
- GREEN: 통합 7(경계 시험 1개 추가), 브라우저 2
  - 첫 GREEN 시도에서 하나가 실패했다. 계획에 주장이 없는 섹션은 MOCK writer가 근거 부족을 낸다(의도된 동작). fixture가 모든 계획에 주장·사실을 붙이게 고쳤다.
  - 브라우저 시험은 구현 뒤에 썼다. 첫 실행 실패는 tab 이름 오기("구상·개요")였다. 구현 전 브라우저 RED는 따로 남기지 않았다.
- mutation(`mutation.log`): 13종 모두 탐지
  - 섹션 끝(수준 비교 2), 대소문자, 활성 개요 확인, 원고 종류 확인, 없는 것만 더함, 앞 섹션 뒤 위치, 중복 제거, expected head 무시, Writer 기본 위치, prose 예외, 프로필 IMRaD 이름, 유형별 제안
- 첫 전체 회귀(`regression-1-failed.log`): exit 1, 브라우저 2개 실패. 마지막에 이 E2E에 더한 "문단이 계획의 문헌을 인용한다"는 단언이 틀렸다. 위의 이유로 MOCK에서는 발췌가 보류된다(제품의 의도된 동작). 단언을 "인용 없음"으로 고쳤다. 고치기 전 커밋(7c57279)은 이 실패를 품은 채 push되었다.
- 회귀(리뷰 전): `pnpm test` exit 0 — unit 406, integration 458, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- 골격 만들기는 사용자 행위다. AI가 부르지 않는다. 제목만 더하고 본문을 바꾸지 않는다. 낡은 head면 덮어쓰지 않고 409다.
- 섹션 제안은 강제가 아니다. 개요 저장·승인은 어떤 섹션 이름이든 그대로 받는다(기존 규칙).
- Writer 기본 위치가 바뀌어도 제안은 여전히 제안이다. 적용 시 그 자리(앞 블록 hash)가 바뀌었으면 STALE이다(PW-042).
- 스토리·novelty를 바꾸는 길은 이 흐름에 없다. 바꾸려면 사용자가 새 스토리 revision을 승인해야 한다(PW-010·039).

## 미실행 / 남은 위험
- 실제 공급자(Claude Code·Codex)로 이 흐름을 돌리지 않았다(MOCK writer). 사용자 PC live smoke 대상이다.
- 문헌 단계는 서재 참고문헌과 검증된 발췌를 미리 넣은 상태에서 시작한다. 검색→채택 화면(PW-031~033)은 각 Task의 브라우저 시험이 다룬다. 이 시험에서 다시 돌리지 않았다.
- **MOCK writer로는 문헌 인용이 있는 문단을 끝까지 시험할 수 없다.** Writer는 공급자 id로 근거 범위를 정한다(PW-037). `mock`은 논문이 허용할 수 있는 공급자가 아니다(`claude_agent`, `codex`만). 그래서 발췌는 언제나 보류되고, 계획에 연결된 참고문헌(`linked_to_node`)이 생기지 않는다. 브라우저 시험은 이 안전한 결과(인용 없음)를 확인한다. 연결된 참고문헌을 인용하는 경로는 계약 unit 시험(PW-042)만 다룬다. 실제 공급자 live smoke에서 확인할 항목이다.
- 섹션 이름 일치는 정규화한 글자 그대로다. "Methods"와 "Materials and Methods"는 다른 섹션이다. 번역·동의어는 보지 않는다.
- 골격은 섹션 수준 제목만 만든다. 개요의 하위 계층(parent_node_id)은 제목 수준으로 옮기지 않는다.
- prose 예외는 섹션 이름이 절차 섹션 이름 자체일 때만이다(리뷰 반영). 목록에 없는 절차 섹션 이름(예: "Sample preparation")의 단계 목록은 경고된다(경고일 뿐이다).

## 다음
P05 gate 보고(`reports/p05/P05_GATE.md`) → P06(PW-047~054)

## 리뷰 반영 (1차, changes requested — MAJOR 1, MINOR 4, NIT 4)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR 1: 앞선 섹션이 원고에 없으면 빠진 섹션이 원고 끝에 붙음(Results·Discussion만 있는 원고에 Introduction이 맨 뒤) | 빠진 섹션은 개요에서 앞선 섹션의 끝 다음에 들어간다. 앞선 것이 없으면 **개요에서 뒤따르는 첫 섹션의 제목 앞**에 들어간다. 둘 다 없을 때만 끝이다 | Introduction이 Results 앞에 들어간다. Introduction 계획의 문단도 Introduction 아래로 간다 |
| MINOR 1: 같은 이름의 하위 제목(level 2)을 섹션으로 봄 | 섹션은 원고의 **가장 높은 제목 수준**의 제목뿐이다. 새 제목도 그 수준을 받는다. 하위 제목은 섹션이 아니다 | ##Results 하위 제목이 있어도 #Results가 추가되고, ##Limitations는 Discussion 아래에 남는다. level-2로 쓰는 원고는 level-2 섹션을 받는다 |
| MINOR 2: 번호 붙은 제목("1. Introduction")을 못 알아봄 | `sectionKey`가 앞 번호(2., 2.1, IV.)와 끝 구두점(:, ., ;)을 무시한다(골격, 기본 위치, 화면 중복 제거 모두) | "1. Introduction", "2. Results:"가 있으면 아무것도 더하지 않는다. Results 계획의 문단은 "2. Results:" 아래로 간다 |
| MINOR 3: 같은 head에서 요청한 같은 섹션의 문단들이 적용 순서와 거꾸로 들어감 | 기본 위치로 놓인 새 문단은 섹션 제목(id·hash)을 기억한다(`pw_046_0001_section_placement.sql`). 적용 때 **그때의 섹션 끝** 다음에 들어간다. 제목이 바뀌거나 없어졌을 때만 STALE이다 | 같은 head의 두 문단이 적용 순서대로 들어간다. 섹션 마지막 문단을 사용자가 고친 뒤에도 다음 문단이 적용되고 섹션 끝에 들어간다. 제목을 바꾸면 STALE이다 |
| MINOR 4: 프로필 섹션 역할과 계획 섹션의 비교가 정확 일치 | Writer와 검토자가 `sectionKey`로 비교한다. 프로필 섹션 이름은 120자까지 받는다(개요와 같음). 남은 한계는 아래 "남은 위험"에 적었다 | 소문자 "implementation" 역할의 원칙이 "Implementation" 계획의 계약(`style.section_principles`)에 들어간다. 120자 이름이 저장된다 |
| NIT 1: 목록 예외 정규식이 너무 넓음 | 섹션 이름 **자체가** 절차 섹션일 때만 예외다(앞 번호와 "Materials and", "Data" 같은 수식어 허용) | Methodological limitations, Antibiotic usage, Discussion of methods, Nutrient availability의 목록은 경고다. 2. Methods, Data availability, Experimental procedures, Installation and usage는 경고가 아니다 |
| NIT 2: 저장 안내 문구가 동작과 다름 | "저장된 뒤 만들 수 있습니다"로 바꿨다(버튼은 저장 전 비활성) | 문구만 바꿨다 |
| NIT 3: 기본 위치가 새 STALE 원인을 만들었는데 보고서가 "같다"고 함 | MINOR 3의 수정으로 사라졌다. 기본 위치 문단은 섹션 제목만 본다 | MINOR 3 시험 |
| NIT 4: 화면의 중복 제거가 서버와 다름 | 화면도 서버와 같은 비교(공백, 대소문자, 앞 번호)를 쓴다 | 표시만 바꿨다 |

- RED(`red-review.log`): 리뷰한 구현(0c1b842)에서 리뷰 시험 6개가 모두 실패한다.
- GREEN: 통합 13
  - MINOR 3 시험은 처음에 두 가지가 약했다.
    - 적용 응답에 없는 `new_block_id`를 비교해, 순서 비교가 아무것도 확인하지 않았다.
    - "섹션 제목 검사 끔" mutation이 살아남았다.
  - 고친 뒤의 시험: 문단 id는 제안 목록에서 읽는다. 셋째 문단은 둘째가 섹션 끝일 때 요청하고, 사용자는 바로 그 둘째 문단을 고친다. 고친 뒤 mutation은 탐지된다.
- mutation(`mutation.log` 하단): 12종 모두 탐지(1종은 시험 보강 뒤)
- 회귀: `pnpm test` exit 0 — unit 406, integration 464, contracts 17, 브라우저 95 (`pnpm-test-review.log`)
- 범위 밖 추가(RFC-012 부록): `apps/worker/src/writer/index.ts`(payload의 섹션 제목, 역할 비교), `apps/worker/src/reviewer/index.ts`(역할 비교), `packages/domain/src/scientific-review/index.ts`(고쳐 쓰기 payload의 빈 섹션 제목). migration은 이 Task 범위다.
- 남은 위험(추가)
  - 프로필 역할의 **근거 출처**는 여전히 문헌에서 읽은 IMRaD 섹션이다. 역할 섹션과 정확히 같아야 출처로 인정된다(`sectionServes`). 그래서 "Implementation", "Materials and Methods" 같은 역할은 출처 없는 사용자 규칙만 가질 수 있다.
  - AI 프로필 제안은 IMRaD 섹션만 낸다. 화면에는 역할 편집이 없고, 소프트웨어 섹션 역할은 API로만 만든다.
  - 섹션이 없는 원고에 넣는 골격은 level 1이다.

## 재리뷰 (727ecd0): changes requested — MAJOR 1(MINOR 1 수정의 회귀), NIT 3
| 지적 | 수정 | 시험 |
|---|---|---|
| R1 MAJOR: "# 제목 / ## 섹션" 원고(Markdown 가져오기의 흔한 꼴)에서 섹션을 못 찾음. 골격이 섹션을 level 1로 중복 추가하고, 기본 위치 문단은 원고 끝에 붙음 | `sectionLevel(doc, sectionNames)`: 맨 앞의 유일한 최상위 제목이 더 낮은 제목들 위에 있으면 **논문 제목**으로 보고, 섹션 수준은 그 아래 수준이다. 다만 그 이름이 알려진 섹션 이름(유형별 제안, Abstract·Background·Methods·Conclusion·References 등)이거나 **개요의 섹션**이면 섹션이다(MINOR 1의 보호 유지). 골격과 Writer 기본 위치 모두 개요의 섹션 이름을 넘긴다 | 제목+##섹션 원고에 ##Discussion만 더해지고, Results 문단은 ##Results 아래로 간다. 맨 앞의 #Discussion은 섹션이다(MINOR 1 시험 유지). 맨 앞의 #Use cases(개요 섹션)는 섹션이므로 ##Availability는 하위 제목이다(골격·기본 위치 모두) |
| NIT 1: "Usage Notes", "Data and code availability", "Methods: …"가 경고됨 | 절차 섹션 이름에 Usage Notes, "A and B availability", 콜론 뒤 부제를 더했다 | 네 이름 모두 경고 없음. 기존 부정 사례(Methodological limitations 등)는 그대로 경고다 |
| NIT 2: 앞 번호 제거가 "1000 Genomes data"의 숫자를 지움 | 구두점 없는 맨 숫자는 두 자리까지만 섹션 번호로 본다(화면도 같음). "V. cholerae"처럼 로마 숫자+마침표로 시작하는 이름은 여전히 번호로 본다(아래 남은 위험) | 개요의 "1000 Genomes data"는 원고의 "Genomes data"와 다른 섹션이다 |
| NIT 3: 섹션 제목을 하위 수준으로 내리면 다음 골격이 그 섹션을 다시 추가 | 동작은 MINOR 1 규칙대로 둔다(하위 제목은 섹션이 아님). 아래 남은 위험에 적었다 | — |

- RED(`red-rereview.log`): R1 제목 시험과 NIT 시험이 727ecd0 구현에서 실패한다. 맨 앞 섹션 이름 시험은 처음부터 통과한다(MINOR 1 보호의 회귀 방지).
- GREEN: 통합 17(맨 앞 제목이 개요 섹션인 경우 1개 추가)
- mutation(`mutation.log` 하단): 8종 모두 탐지
- 회귀: `pnpm test` exit 0 — unit 406, integration 468, contracts 17, 브라우저 95 (`pnpm-test-rereview.log`)
  - 제목 판별, 알려진 이름, 개요 이름, Writer·골격의 개요 이름 전달, 두 자리 숫자, Usage Notes, 콜론 부제
- 남은 위험(추가)
  - 제목 판별은 휴리스틱이다. 섹션처럼 쓴 맨 앞 제목의 이름이 알려진 이름도 개요 섹션도 아니면 제목으로 본다.
  - 사용자가 섹션 제목을 하위 수준으로 내리면 다음 골격이 같은 이름의 섹션을 다시 더한다. 이는 MINOR 1 규칙의 결과다.
  - "V. cholerae colonization"처럼 로마 숫자와 마침표로 시작하는 이름은 앞부분을 번호로 본다.
