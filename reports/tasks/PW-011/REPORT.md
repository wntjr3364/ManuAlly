# PW-011 — Claim·Fact·Evidence 최소 모델 — REPORT
Status: in_review (독립 리뷰 대기) / Phase: P01 / Requirement: REQ-011

## 변경 파일
- `db/migrations/pw_011_0001_claims_facts_evidence.sql`
  - `evidence_records`
    - kind: experiment, figure_panel, table_cell, literature_excerpt, method_record
    - 출처: 같은 논문의 asset revision 또는 project reference(복합 FK)
    - figure/table은 asset 필수, 문헌 발췌는 reference 필수(CHECK)
    - locator 필수
  - `fact_records`
    - 원문 숫자 텍스트 `value_text`와 numeric `value`를 함께 저장
    - unit, group_label, comparison, n, extraction_method, origin
  - `fact_statistics`
    - 통계 종류별 1행(PK `(fact_id, kind)`)
    - p_value, adjusted_p_value, q_value를 별개 종류로 둔다
    - 확률 종류는 0–1(CHECK), adjusted p는 보정 방법 필수
    - 사실을 만든 트랜잭션 밖에서는 추가 불가(created_xid seal), 이후 불변
  - `claims`(observation/interpretation/hypothesis/background), `claim_evidence_links`(supports/contradicts/unclear/needs_check, 불변)
  - 공통 trigger `pw_review_guard`
    - 행은 CANDIDATE/DRAFT로만 생성되고, 내용은 불변
    - 상태: CANDIDATE→VERIFIED→RETRACTED, CANDIDATE→REJECTED(claim은 DRAFT/APPROVED)
    - 검증·승인자는 논문 owner만
    - 삭제·TRUNCATE 금지
  - 사실은 출처 evidence가 VERIFIED일 때만 VERIFIED가 될 수 있다(DB trigger)
- `packages/domain/src/evidence/index.ts`
  - `createFactCandidates`: 수동 입력, import, 이후 AI 추출이 모두 쓰는 단일 입구
    - 모든 행을 먼저 검증하고, 한 행이라도 틀리면 전체를 거부
    - 서버 전용 필드(verified_by, verification_state, origin 등)가 오면 필드명을 밝혀 422
  - 통계 종류는 정확한 이름만 받는다. "p", "q", "FDR" 같은 라벨은 해석하지 않고 422
  - 같은 종류가 두 번 오면 422
  - `mergeStatistics`: 종류를 합치지 않는다. 같은 종류에 값이 다르면 conflict(사용자 결정)
  - 검증 전 필수 항목: unit, group, n, comparison(비교 지표이거나 p/q가 있을 때). 없으면 422 `{missing}`
  - observation claim은 VERIFIED이고 supports 관계인 evidence가 있어야 승인
- `apps/api/src/routes/evidence/index.ts`
  - `/evidence`, `/facts`, `/facts/import`, `/claims` 및 verify/reject/approve/evidence-links
  - 모두 paper-scoped
- 범위 밖 연결(RFC-006 부록 기록)
  - `apps/api/src/server.ts`: route 등록
  - `packages/domain/src/shared/db.ts`: DomainError에 `details`
  - `apps/api/src/auth/plugin.ts`: 오류 응답에 details 포함
  - `packages/domain/src/outlines/index.ts`: OutlineError가 공용 details 사용

## 요구사항-시험 매핑 (`tests/tasks/PW-011/evidence.int.test.ts`)
| AC | Test | 결과 |
|---|---|---|
| REQ-011-A 값·단위·그룹·출처·검증 주체 연결 | TST-011A ×5: 검증된 사실이 값/단위/그룹/대조/n/통계/evidence locator·asset/검증자=세션 owner를 반환; evidence 미검증 시 409, 필수 항목 누락 시 `missing`; 원문 숫자 텍스트 보존('2.40'), 단어·범위·단위 없음·p>1 거부, 없는 evidence 404; kind별 locator 검사, 다른 논문 asset 404; observation claim은 검증된 지지 evidence가 있어야 승인, 관계 값 검사 | pass |
| REQ-011-B 검증 주체 위조 불가, p·q 병합 불가 | TST-011B ×5: 요청 본문의 verified_by/verification_state/origin/approval_state 422; import 한 행에 verified_by가 있으면 전체 거부(아무것도 저장 안 됨), import·AI 추출은 CANDIDATE와 origin 기록, 도메인 입구도 verified_by 거부; p와 q 공존 시 별개 저장, "p"/"q"/"FDR" 별칭·중복 종류·보정법 없는 adjusted p 거부, merge는 종류를 합치지 않고 같은 종류의 다른 값은 conflict; 직접 SQL로 owner 아닌 검증자, 통계 종류 변경, 값 변경, 삭제, VERIFIED로 바로 삽입, 사후 통계 추가 → 거부; 다른 owner·다른 논문 404 | pass |

- RED: route 없음으로 10/10 실패(`red.log`)
- GREEN: 10/10(`green.log`)
- Mutation 5종 모두 탐지(각 1건 실패)
  - 검증자=owner 검사 제거
  - 통계 종류 중복 검사 제거
  - comparison 필수 제거
  - adjusted p 보정법 검사 제거
  - observation 근거 검사 제거
- 회귀: `pnpm test` exit 0
  - unit 9, integration 74, contracts 6, e2e 1, spikes 70
  - evals PASS, pack-check PASS

## 보안·과학적 실패 경로
- 검증 위조
  - 요청은 검증자·상태를 실을 수 없다.
  - DB는 owner 아닌 검증자, 단계 건너뛰기, 검증 전 생성을 막는다.
  - 승인·검증은 사용자가 본 content_hash를 요구한다.
- p/q 혼동: 별칭을 추측하지 않고, 종류별로 분리 저장하며, 병합 시 종류를 합치지 않는다.
- 숫자 변형: ~~원문 텍스트를 그대로 저장한다~~ — **최초 커밋(8c80932)에서는 거짓이었다**(리뷰 M1, 아래). 수정 후 원문 텍스트를 그대로 저장하고, DB가 `value = value_text::numeric`을 검사한다. 범위·말로 쓴 값은 사실로 받지 않는다.
- 근거 없는 관찰 주장: 검증된 지지 근거 없이 승인할 수 없다.

## 미실행 / 남은 위험 / 이월
- **웹 UI(`apps/web/src/features/evidence/**`) 미구현**: PW-014의 웹 shell과 함께 만든다.
- **outline node의 `evidence_ids`/`claim_ids` 연결**
  - 아직 PW-010의 자유 문자열이며, 실제 evidence_records/claims 존재 검사가 없다.
  - PW-010 계약(문자열 id)을 바꾸는 일이라 별도 Task/RFC로 제안한다.
  - 연결 후에는 AI gate가 "필수 evidence가 VERIFIED인지"까지 확인해야 한다.
- **evidence 철회(RETRACTED) API는 아직 없다.** DB 전이는 허용된다. 철회 시 관련 claim/fact/문단의 impact review는 P04(DependencyLink)다.
- **CSV/TSV에서 후보를 만드는 파서는 없다.** 현재 import는 JSON 행이다. 파일 파서는 P04 범위다.
- **그래프에서 읽은 숫자(`extraction_method=figure_reading`)를 추가 확인하는 UX는 없다.** 현재는 기록만 하고 검증 단계는 동일하다.
- **asset 업로드 API가 없다(P04).** 시험은 asset 행을 직접 만든다.
- **앱 DB 계정이 superuser라 trigger를 끌 수 있다.** runtime role 분리는 이월(PW-009 기록과 동일).

## 다음 Task
PW-012 공유 editor schema + contracts(자동 시작하지 않음, 리뷰 후).

## 독립 리뷰 결과 반영 (2026-10-09)
결론: changes requested(major 1, minor 6). 모두 수정했다. 재리뷰(2026-10-09): approve. minor 3건도 반영했다(아래).
- 수정 위치: `pw_011_0002_review_fixes.sql`, `evidence/index.ts`, `routes/outlines/index.ts`(오류 응답을 공용 sender로 통일)
- 회귀 시험: `tests/tasks/PW-011/review-fixes.int.test.ts` 22건. 수정 전 18건 실패(`review-red.log`). 4건은 이미 맞게 동작하던 경로의 보강이다.

| 지적 | 조치 |
|---|---|
| **M1 원문 숫자 텍스트가 정규화되어 저장됨**(`2.4E3`→`2400`, `1.0e-5`→`0.000010`), content_hash와 저장값 불일치 | 같은 parameter를 numeric과 text에 함께 써서 생긴 문제다. 두 값을 따로 bind한다. DB CHECK `value = value_text::numeric`(fact·통계). 7가지 표기를 왕복 시험 |
| m1 지수 overflow·`1.00000000000000000001` 같은 p → 500 | 지수 ±300 제한. 확률은 float 대신 정확한 10진 비교. 남는 DB 오류(22003/23514/22P02)는 422로 변환 |
| m2 보정된 값을 `p_value`로 저장 가능, merge가 종류 검사 안 함 | `p_value`에 adjustment가 있으면 거부(API·DB CHECK). merge도 종류를 검사 |
| m3 observation 근거 규칙이 API에만 있음, 검토 시각을 SQL로 임의 지정 가능 | claims trigger 추가. 검토 시각은 trigger가 서버 시계로 기록 |
| m4 시험 공백 | 잘못된 hash로 검증·승인(3종) 409, 다른 owner의 쓰기 5종 404, 대소문자·공백 변형 통계 종류 시험 추가 |
| m5 출처 정보 느슨 | AI 추출 여부와 extraction_method 일치(API·DB CHECK). 제거된 문헌의 evidence는 검증 불가. 기각된 evidence에 link 불가. page_index 상한. log2FC 등도 비교 지표로 인식 |
| m6 보고서 부정확 | 위 "숫자 변형" 항목을 정정 |

- 기존 시험 1건 수정: AI 경로 시험이 `extraction_method: manual_entry`를 보내고 있었다. m5 규칙상 이제 거부가 맞으므로, 그 값을 빼고 기본값(ai_extraction)을 쓰게 했다.
- 실행
  - PW-011 통합 32/32(`green.log`)
  - `pnpm test` exit 0: unit 30, integration 97, contracts 6, e2e 1, spikes 70, evals/pack PASS
  - 이 수치에는 작업 중인 PW-012 시험(미커밋)도 포함되어 있다.

### 재리뷰 minor 반영
- 끝이 점인 숫자(`2.`)
  - 이전: API는 받고 DB가 막아 모호한 422가 났다.
  - 이제 API 정규식을 DB와 같게 맞춰 필드를 밝힌 422를 준다(시험 추가).
- 시험 보강
  - 통계 숫자·텍스트 불일치 CHECK를 같은 트랜잭션에서 직접 시험한다. 이전 시험은 seal trigger 때문에 통과하고 있었다.
  - DB 시계 기록을 fact verify/retract와 claim approve/reject까지 확인한다.
- 문구 정정: DB CHECK는 "텍스트가 저장된 숫자로 해석되는지"만 본다. `'2400'`과 2400처럼 정규화된 텍스트는 막지 못한다. 원문 보존을 실제로 보장하는 것은 API의 분리 bind이고, 이는 왕복 시험으로 확인한다.
- **기존 데이터 주의**
  - pw_011_0002는 PW-011 데이터가 이미 있는 DB에서 실패할 수 있다(보정법이 있는 p_value, manual_entry로 기록된 AI 사실).
  - dbf806a 이전에 저장된 정규화 텍스트는 그대로 남는다.
  - 현재는 배포된 데이터가 없어 영향이 없다. 그 이전에 만든 개발 DB는 다시 만들어야 한다.
- API에서만 지키는 규칙
  - 기각된 evidence에 link 금지
  - observation trigger의 잠금은 API 경로가 먼저 잡는다
