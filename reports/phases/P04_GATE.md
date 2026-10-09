# P04 Gate — 문헌·원문·근거 (PW-031 ~ PW-038)
작성: 2026-10-09 · 상태: **사용자 위임에 따라 진행 — 외부 서비스 실제 호출은 아직 하지 않음**

## 사용자 결정
- 사용자 지시(2026-10-09): "니가 적절하게 선택해서 프로젝트 완성해라". 이 gate의 결정은 위임에 따라 권장안으로 기록한다. 사용자는 언제든 되돌릴 수 있다.
- 위임으로 정한 항목
  1. RFC-011(P04 write scope 연결 파일) 채택. Task별 부록에 모두 기록했다.
  2. 서지 원천은 Crossref·PubMed만 쓴다. OpenAlex는 사용조건을 확인하지 못해 넣지 않는다.
  3. 원문 PDF는 보관 권리가 확인된 것만 열고 보낸다. 모르면 막는다(`keep_right_unknown`).
  4. Zotero는 읽기 전용 가져오기 원천이다. 정본은 서재(DB)다. 양방향 동기화는 없다.
  5. 민감 논문(`data_classification = 'sensitive'`)은 redaction 정책이 생기기 전까지 아무것도 외부로 보내지 않는다.
- **P04 구현 완료.** PW-031~037 독립 리뷰 approve. PW-038은 리뷰 중이다(결과는 아래에 덧붙인다).

## 사용자가 직접 해야 하는 일 (위임할 수 없음)
- 실제 Crossref·PubMed 계약 스크립트 실행(사용자 네트워크, 연락 email 설정). 이 컨테이너에서는 not_run.
- 실제 OA 원문 내려받기, 실제 Zotero 라이브러리 읽기(사용자 key). 이 컨테이너에서는 not_run.
- P03에서 넘어온 RFC-010(provider를 sandbox 안에서 실행) 확인.

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-031 | 서지 검색 adapter(Crossref, PubMed): 대역 서버, 정규화, 철회·정정 고지, 실패 구분 | 통합 16, mutation 12 | approve(재리뷰 nit 반영) |
| PW-032 | 서재: DOI 정규화, 중복 병합 없이 연결, 버전, 고지 관계 | 통합 16, mutation 25 | 리뷰(MINOR 3)·재리뷰(MAJOR: 직접 입력이 서재 정보를 바꿈)·approve |
| PW-033 | 후보 평가(MOCK assessor): 용도·적합·읽은 깊이·경고, 사용자 채택만 | 통합 18, 브라우저 1, mutation 30 | 리뷰(MINOR 3)·재리뷰 approve(MINOR 1 반영) |
| PW-034 | 원문 자산 정책: 바이트 검사, 보관·전송 권리, 안전한 내려받기(SSRF·한도) | 통합 10, mutation 34 | 3차에 approve |
| PW-035 | PDF 추출·위치(anchor): 격리된 child, 메모리 상한, 낡은 위치 감지 | 통합 13, 브라우저 1, mutation 18 | 3차에 approve |
| PW-036 | 그림 버전·근거 추적·검토 표시 | 통합 7, 브라우저 1, mutation 19 | 리뷰(MINOR 3)·재리뷰 approve |
| PW-037 | 문단에 필요한 근거만 retrieval(원천 gate 상속, 민감 논문 차단) | 통합 12, mutation 22 | 리뷰(MAJOR: 전송 불가 원천의 사실 유출)·재리뷰 approve |
| PW-038 | 참고문헌 가져오기(CSL-JSON, BibTeX, RIS, DOI 목록)·Zotero 읽기 전용 | 통합 11, 브라우저 1, mutation 19 | 리뷰 중 |

최종 회귀 `pnpm test` exit 0: unit 278, integration 369, contracts 17, 브라우저 85 (`reports/tasks/PW-038/pnpm-test.log`).

## 다음 phase로 넘기는 위험 (확인만)
- **외부 서비스 실제 동작은 미검증이다.** Crossref, PubMed, OA host, Zotero 모두 대역 기준이다. 형식이 다르면 실패로 구분해 알리고 성공으로 보이지 않게 했다.
- **provider run이 아직 retrieval context를 쓰지 않는다.** RFC-010 구현과 P05 Writer(PW-042)에서 연결한다.
- retrieval은 어휘 일치만 쓴다(의미 검색 없음). 근거 하나에라도 gate 사유가 있으면 주장도 보내지 않는다(보수적, PW-037 NIT).
- PDF 위치는 글꼴 근사로 계산한다. 실제 논문 PDF는 시험하지 않았다. 파서의 network 격리는 RFC-010 sandbox와 함께 한다.
- 그림 파일은 아직 정책 route(전송·내려받기)를 거치지 않는다. 지금은 어디로도 보내지 않는다.
- 브라우저 일회성 실패 2건(PW-015, PW-016)은 PROGRESS Open items에 열려 있다.
- **P01~P03에서 넘어온 항목은 아직 열려 있다.** 실제 IME, Firefox/Safari, 배포, 실제 provider.

## 다음
RFC-010 구현(provider를 sandbox 안에서 실행 + worker run 경로) → P05(PW-039~046).
