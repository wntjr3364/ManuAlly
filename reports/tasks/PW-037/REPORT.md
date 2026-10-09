# PW-037 — 필요한 근거만 retrieval — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_037_0001_retrieval_cache.sql`
  - `retrieval_cache`: 조립한 문단 context를 담는다. 키는 (논문, 문서, 문단, 공급자, fingerprint)이고 바꿀 수 없다.
  - 입력이 하나라도 바뀌면 fingerprint가 달라진다. 같은 행을 고치는 일은 없다.
- `packages/search/src/retrieval/index.ts`
  - `retrieveContext(db, {paperId, documentId, blockId, provider, maxItems, maxChars, lexical})`
    - 먼저 문단 자신의 연결을 따라간다.
      - 인용한 참고문헌 → 검증된 문헌 인용 근거(+ 확인한 PDF 위치: 쪽, sha256)
      - 언급한 그림·표 → 최신 버전에서 읽은 검증된 사실
      - 그 근거에 기대는 승인된 주장
    - 다음으로 같은 논문 안에서 단어 검색을 한다. 드문 단어 가중(idf), 공유 단어 2개 이상만 쓰고 `via: 'lexical'`로 표시한다.
    - 들어오지 않는 것
      - 다른 논문의 자료
      - 논문에서 뺀 참고문헌
      - 검증·승인되지 않았거나 거절·철회된 기록
    - 보내면 안 되는 것은 이유와 함께 `withheld`로 뺀다(본문 텍스트 없음).
      - 원문 인용: 그 원문 PDF의 외부 전송 조건(PW-034)이 모두 맞아야 한다. 확인한 PDF 위치가 없는 인용도 뺀다.
      - 이전 그림 버전에서 읽은 사실
      - 열린 검토 표시가 있는 사실·주장
      - 보관된 그림의 사실
    - 논문이 허용하지 않은 공급자(또는 전송 차단 논문)는 아무것도 받지 않는다(403).
    - 상한: 정해진 순서(인용 → 그림 → 주장 → 단어)로 항목 단위로만 자르고 `truncated`를 알린다.
    - cache: fingerprint는 입력 전부로 만든다. 문서 revision, 문단, 후보 기록과 그 상태·hash, 전송 결정, 그림 버전, 검토 표시, 논문 정책, 공급자, 상한. fingerprint가 같을 때만 저장된 context를 돌려준다.
  - `rankLexical`, `terms`: 결정적인 단어 순위(불용어, 3자 이상, NFKC 소문자)
- 범위 밖(RFC-011 부록): `packages/search/package.json`(`@pw/domain` workspace 의존성, `./*` export). 새 외부 의존성은 없다.
- 시험: `tests/tasks/PW-037/retrieval.int.test.ts`(통합 8)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-037-A / TST-037A 선택 paragraph와 관련된 source excerpt/locator만 context에 포함 | 인용한 r1의 인용(쪽, sha256 locator), 언급한 Figure 1의 검증된 사실(패널, 버전), 그 근거의 승인된 주장이 들어간다. 단어가 겹치는 r2는 lexical로 들어온다. 관련 없는 r4와 검증 안 된 9.9 값은 없다. 관련 없는 문단은 빈 context다 |
| | 인용한 참고문헌이라도 검증되지 않은 인용은 들어오지 않는다 |
| | 단어 순위: 공유 단어 2개 이상, 같은 후보 안에서만 |
| | 상한: 항목 단위, 정해진 순서, `truncated` |
| REQ-037-B / TST-037B 다른 프로젝트·삭제한 자료·전송불가 원문·오래된 approved state가 cache에서 유출되지 않음 | 전송 금지 원문의 인용은 이유와 함께 빠진다(텍스트 없음) |
| | 허용하지 않은 공급자(codex)는 거부한다. 다른 논문의 문서나 문단은 not found다. 같은 내용의 bob 자료는 alice context에 없다 |
| | cache: 같은 입력이면 cached. 다음 경우마다 새 fingerprint가 되고 cache에서 나오지 않는다 |
| | ㆍ 전송 권리를 철회하면 → withheld |
| | ㆍ 참고문헌을 빼면 → 사라짐 |
| | ㆍ 주장을 철회하면 → 사라짐 |
| | ㆍ 새 그림 버전이 생기면 → 이전 버전에서 읽은 사실이 withheld |
| | cache 행은 바꿀 수 없다. 문단을 고치면(새 revision) 새 context다 |

## RED → GREEN
- RED(`red.log`): 구현을 빼면 모듈이 없어 실패했다. 행동 단위 RED는 mutation이 맡는다.
- GREEN: 통합 8
- mutation(`mutation.log`): 13종 중 1종(검증되지 않은 인용)이 살아남았다. 시험을 더한 뒤 모두 탐지했다.
- 회귀
  - 첫 실행(`pnpm-test-first-run.log`)에서 PW-016 브라우저 시험 하나가 실패했다(인용만 선택 → Esc → Shift+Home 뒤 도구막대가 5초 안에 나타나지 않음).
  - 그 시험만 11회 다시 돌렸고 모두 통과했다(6회는 CPU 전부에 부하를 건 상태). 이 Task는 웹 코드를 바꾸지 않았다.
  - 원인은 확인하지 못했다. PW-015에서 본 일회성 실패와 같은 종류로 기록한다.
  - 다시 전체 실행: `pnpm test` exit 0 — unit 278, integration 354, contracts 17, 브라우저 84(`pnpm-test.log`)

## 보안·과학적 실패 경로
- 자료는 그 논문 것만 쓴다(모든 질의에 paper 조건). cache 키와 fingerprint에도 논문, 문서, 공급자가 들어간다.
- 원문 인용은 그 원문의 전송 권리가 확인될 때만 나간다. 확인한 PDF 위치가 없는 인용은 어느 원문인지 알 수 없어 내보내지 않는다(보수적).
- 오래된 승인 상태(이전 그림 버전, 열린 검토, 철회·거절)는 context에 들어가지 않는다. cache는 입력이 같을 때만 쓴다.

## 미실행 / 남은 위험
- 아직 provider run이 이 context를 쓰지 않는다. P05 Writer(PW-042)와 tool gateway(`get_reference_excerpt` 등) 연결은 RFC-010 구현과 함께 한다.
- 단어 검색은 단순 어휘 일치다. 의미 검색(embedding)은 하지 않는다. 동의어, 약어, 한국어 조사 처리는 없다.
- cache는 같은 입력일 때 조립을 줄이지 않는다. 입력을 모두 읽어야 fingerprint를 알 수 있기 때문이다. 유출 방지가 목적이고 성능 이득은 작다.
- fingerprint에는 원문 PDF의 보관 권리 변화가 전송 결정을 통해 들어간다. 그 밖의 정책 필드가 새로 생기면 함께 넣어야 한다(주석으로 기록).

## 다음
PW-038: 문헌 이식성·읽기 연동 gate
