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

## 리뷰 반영 (1차, changes requested → 수정)
| 지적 | 수정 | 시험 |
|---|---|---|
| MAJOR: 전송 불가·제거된 원문에서 읽은 사실이 단어 일치로 들어감 | 사실·주장은 근거 원문의 gate(`sourceGates`)를 물려받는다. 참고문헌이 빠지면 그 원문에서 나온 사실은 아예 후보가 아니고, 전송 불가면 사유와 함께 withheld | `MAJOR: a fact read from a source that may not be sent…` |
| MINOR 1: 민감 논문도 자기 사실·주장을 보냄 | `data_classification = 'sensitive'`이면 403 `paper_is_sensitive`(redaction 정책이 생기기 전까지 아무것도 보내지 않음) | `MINOR 1` |
| MINOR 2: 철회 문헌 확인 없음 | 서재가 철회로 아는 문헌(자체 표시 또는 철회 notice)의 인용은 `source_retracted`, 그 인용에 기댄 주장도 같은 사유로 withheld | `MINOR 2` |
| MINOR 3: cache가 저장된 context를 내줌 | context는 항상 지금 계산한다. 저장은 기록용(`recorded_before`)이고 대신 내주지 않는다. 행은 바꿀 수 없고(새 trigger) 문단·공급자별 최근 20개만 남긴다(`pw_037_0002_retrieval_records.sql`). `RETRIEVAL_VERSION = 'pw-retrieval-2'`가 fingerprint에 들어간다 | `MINOR 3`(저장 행을 바꿔 넣어도 결과에 나오지 않음, 22회 뒤 20개) |
| nit: 사실 문장의 "vs" 중복 | `ABC1 · fold change = 2.4 fold; group: abc1 vs WT; compared with: WT; n=3` | 기존 시험 기대값 갱신 |
| nit: 질의 수 | 앵커·전송 결정·검토 flag를 묶어서 조회(상관 부질의 제거), 소유자 조회는 한 번 | — |

- RED(`red-review.log`): 5a75ab5 구현과 migration 0001만으로 12개 중 7개 실패(사실 문장, `recorded_before` 없음, MAJOR, 민감, 철회, 기록 대신 제공).
- GREEN: 통합 12.
- mutation(`mutation.log` 하단): 9종 모두 탐지(사실의 전송 gate 상속, 제거 상속, 주장의 원문 상속, 철회 gate, 민감 gate, 저장 context 제공, recorded 표시, pruning, 사실 문장).
- 회귀: `pnpm test` exit 0 — unit 278, integration 358, contracts 17, 브라우저 84 (`pnpm-test-review.log`).
- 남은 위험: 정보성 기록이 되면서 cache의 성능 이득은 없다(원래도 작았다). 철회 판정은 서재가 아는 notice까지만이다(새 notice는 검색·추가 때 들어온다).

## 재리뷰
- approve (69f6659, 7901ab8).
- 남은 NIT(기록만, 바꾸지 않음): 근거 중 하나라도 gate 사유가 있으면 주장도 withheld된다(확인한 PDF 위치가 없는 인용 `no_confirmed_source_document` 포함). 주장 문장은 논문 자신의 문장이라 과하게 막는 쪽이다. 인용을 PDF 위치 없이 기록하는 경우가 많으면 승인된 주장이 writer에 거의 가지 않을 수 있다. 안전한 방향이라 그대로 두고, P05 Writer(PW-042)에서 실제 사용을 보고 "원문 전송 불가" 표시로 나눌지 정한다.
