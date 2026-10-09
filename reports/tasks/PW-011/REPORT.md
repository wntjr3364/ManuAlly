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
- 숫자 변형: 원문 텍스트를 그대로 저장한다(반올림·정규화 없음). 범위·말로 쓴 값은 사실로 받지 않는다.
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
