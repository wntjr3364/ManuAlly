# PW-062 — v1 최종 pilot·추적성 gate — REPORT
상태: in_review (2026-10-10) — 독립 리뷰 changes requested(MAJOR 1·MINOR 2·NIT 3) → 반영 → 재리뷰 **approve**(NIT 1 반영)

## 무엇을 했나
- **release 기록** `reports/release/capabilities.json`: 필수 capability 22개.
  - 각 항목: 연결된 요구사항(REQ-001~062 전부), 종류(automated / live / manual), 상태(pass / blocked / not_run / manual_pending), 근거 파일, pass가 아니면 blocker.
- **release gate** `tests/tasks/PW-062/release.ts`: spec 12의 릴리스 수준(Demo(Mock) → private alpha → private beta → 개인 사용 v1) 중 도달한 수준을 정한다.
  - 기록이 근거보다 많이 주장하면 거부한다.
    - live capability는 registry가 live evidence로 승인한 공급자일 때만 pass. mock 근거는 안 된다.
    - manual capability는 사용자가 기록했을 때만 pass(누가 = user, 언제, 근거).
    - 근거 없는 pass, 모르는 상태, 빠진 capability는 거부한다.
  - v1까지의 blocker를 모두 낸다.
- **release 보고서**(P07 gate 겸) `reports/release/RELEASE_REPORT.md`
  - 판정, MOCK 표시, capability 표, blocker와 할 일, 사용자 승인 범위(P00~P07), P07 요약, 정직 기록.
- **사용자 pilot** `reports/release/PILOT.md`(workflow 8개)와 `pilot.json`(사용자가 채움, 지금 pending).

## 판정
**Demo (Mock)**. 다음 수준(private alpha)을 막는 것과 v1까지의 blocker 12개는 모두 사용자 기계나 사용자 결정이 필요하다.
- 실제 공급자 2개(live smoke)
- 실제 sandbox
- 사용자 기계 preflight
- 실제 한도·장애
- 보안 gate(`pending_manual`)
- 사람 rubric
- 실제 배포·복원
- 브라우저·IME
- 사용자 pilot
- 위임으로 정한 범위 축소의 사용자 수용

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-062-A / TST-062A(필수 capability의 pass/blocked/not_run과 사용자 승인 범위가 일치하는 release report) | `release.test.ts` "TST-062A" 4개 + 위임 범위 표시 1개: 모든 REQ 추적·근거 파일 존재·blocker 이유, pass의 Task는 in_review, 보고서의 판정·blocker·표가 gate 계산과 같음, 승인 범위가 gate 파일 상태줄과 같음(P03의 "실제 provider 사용 미승인" 포함) | 통과 |
| REQ-062-B / TST-062B(mock·문서·미실행 live를 제품 완성으로 포장하거나 blocker를 지우지 않음) | "TST-062B" 7개(종류 재표기 거부 포함): gate 판정 규칙, 기록 위조(mock live pass, AI가 채운 pilot, 빠진 capability) 거부, registry 미승인 공급자의 live pass 금지, 과장 표현 금지와 MOCK 표시, 보안 gate·pilot 상태 일치, 수준 정의와 기록 일치 | 통과 |

## RED → GREEN
- RED(`red.log`): gate와 시험을 먼저 썼다. 기록이 없어 9개가 실패했다(`ENOENT capabilities.json`). gate 규칙 시험 1개는 통과.
- GREEN: 기록·보고서·pilot을 만든 뒤 10개 통과.

## 회귀와 감사
- `pnpm test` exit 0(리뷰 반영 후 26a51cc, `test.log`: unit 642, 통합 673, contracts 17, 브라우저 101, spikes·evals·pack-check). 재리뷰 NIT 시험 1개는 그 뒤 추가했고 PW-062 unit 13개로 확인했다. capability 근거의 전체 회귀는 이 로그를 가리킨다.
- 보안 감사를 깨끗한 커밋 1dbf54a에서 다시 실행했다: `pending_manual`, 자동 9개 영역 통과, 열린 finding 없음(F-02는 PW-061에서 수정). 기록 `reports/release/audit-run.log`, `reports/security/audit.json`.

## Mutation(`mutation.log`)
- gate 7종, 기록 6종, 보고서 5종을 시험했다.
- 처음에 2종이 살아남았다.
  - 뒤 수준의 blocker 누락
  - MOCK 표시 문장 삭제(시험이 단어만 봤다)
- 시험을 강화해 둘 다 잡았다(R2). 그 밖에 무효 mutant 1개를 기록했다.

## 변경 파일
- `reports/release/{capabilities.json, RELEASE_REPORT.md, PILOT.md, pilot.json}`
- `tests/tasks/PW-062/{release.ts, release.test.ts}`
- `reports/tasks/PW-062/**`, `PROGRESS.md`
- write scope 밖 변경 없음. migration 없음.

## 보안·과학 경계
- 사용자 행위(실제 공급자 승인, 수동 확인, pilot, phase gate 승인)를 AI가 대신 기록하지 않는다. gate가 그런 기록을 거부한다.
- 관측하지 못한 값은 pass가 아니다.

## 미검증·남은 위험
- 이 gate는 기록의 일관성과 과장을 막는다. 기록에 적힌 근거(각 Task의 시험)의 내용은 각 Task의 시험·리뷰가 맡는다.
- 사용자 pilot, 실제 공급자, 수동 확인 2건, 사람 rubric은 하지 않았다(사용자 몫).

## 독립 리뷰(changes requested) — 반영
- **M1** CAP-EXPORT를 단순 pass로 보여 주고, 위임으로 정한 spec 10 내보내기 축소를 사용자에게 보이지 않았다.
  - capability 제목에 한계를 적었다: 학술지 CSL·OMML·그림 삽입 없음, 기울임은 경고만, 전체 일관성 검사 없음, PDF는 LibreOffice.
  - 보고서에 "위임으로 정한 범위" 절을 더했다. P07 결정을 열거하고, P02~P06은 각 gate의 위임 목록과 RFC-010·Zotero 결정을 가리킨다.
  - 새 capability **CAP-SCOPE-ACCEPT**(manual, 사용자 수용)를 v1 blocker로 넣었다.
- **m1** gate가 기록의 `kind`를 그대로 믿었다. capability마다 종류와 공급자를 gate 안(`KIND_OF`)에 고정했다. 다르게 적힌 기록은 거부한다(시험: live·manual을 automated로 바꾼 4종, 공급자 바꾸기).
- **m2** "실제 호출은 한 번도 없다"와 PW-004 사고가 모순이었다.
  - "승인되거나 근거가 기록된 실제 호출은 없다"로 고쳤다. PW-004 사고를 MOCK 표시와 정직 기록에 적었다. capability blocker 문구도 같다.
  - 시험은 MOCK 절 안에서 확인한다.
- **n1** 시험 실패 상태로 push한 커밋 id를 모두 적었다: 7143002(lint), 54322d5(typecheck), 199bf58·d45d577(TST-014A 경합).
- **n2** 과장 표현 목록을 넓혔다: v1 완성, 완성된 제품, 실제 AI로 검증됨, 출시 준비 완료, release-ready.
- **n3** 수동 기록은 증명이 아니라 사용자 진술이다. 누구나 쓸 수 있고 AI는 쓰지 않는다. 이를 gate 주석, 보고서, PILOT.md에 적었다.
- 반영 확인 mutation 7종을 모두 잡았다(MOCK 절 범위 시험 R2 포함).
- 재리뷰 approve. NIT 1(`KIND_OF`와 `LEVELS`를 묶는 시험 없음): 둘이 정확히 같은 id를 갖고, 기록의 종류가 고정값과 같음을 시험한다.

## 다음
- 사용자 결정(P07 gate)
  - 실제 공급자 사용 승인 여부와 live smoke
  - 수동 확인 2건
  - 배포와 pilot
- 결정 뒤 해야 할 일은 새 Task로 만든다.
