# Security release audit (PW-059) — 2026-10-10 (리뷰 반영판)

게이트 결정은 `reports/security/audit.json`의 `gate`가 정본이다(`node tests/security/run-audit.ts`). 이 문서가 바뀐 뒤 커밋된 트리에서 다시 돌린 결과다. 요약은 아래 "결정"에 있다.

## 게이트 규칙(`tests/security/gate.ts`, 시험 `tests/security/gate.test.ts`)
- **refused**
  - 커밋되지 않은 변경이 있는 트리를 감사했거나, 그 여부가 기록되지 않았다.
  - 필수 자동 영역이 없거나, 실패했거나, 실행되지 않았거나, 시험이 0개이거나, skip이 하나라도 있다.
  - critical·high finding이 open이다.
  - critical·high 위험을 사용자가 아닌 쪽이 수용했다.
  - `fixed`인데 그것을 보여 주는 시험이 없다.
  - 형식이 잘못됐다.
- **pending_manual**: 필수 수동 확인이 사용자 기록(누가 = user, 언제, 근거)으로 `reports/security/manual-checks.json`에 없다. 실행기는 이 파일을 읽기만 한다. 필수 수동 확인 id(`REQUIRED_MANUAL`)가 파일에서 빠지면 거절한다(재리뷰 m1).
- **allowed**: 나머지. medium·low open finding은 목록으로 보인다.
- 영역의 결과는 시험 실행기(vitest JSON)에서 읽는다. 파일이 실행되지 않았으면 `not_run`이다.

## 영역과 근거(필수 9개)
| 영역 | 무엇을 | 근거(시험) |
|---|---|---|
| SEC-IDOR-AUTH | 아래 "IDOR sweep이 실제로 닿는 범위" | `tests/security/sweep.int.test.ts`, `tests/security/schema.int.test.ts`, `reports/tasks/PW-059/sweep-stats.json` |
| SEC-INJECTION | 원고·아웃라인·문헌에 심은 지시를 그대로 따르는 모델이 18가지를 시도한다. 금지 도구는 거부되고, 다른 논문 내용은 0, 적용·승인·이동도 0이며, 모두 audit에 남는다. 도구 목록에 바깥에 닿거나 행동하는 도구가 없다. PW-027 gateway도 포함한다. | `tests/security/injection.int.test.ts`, `tests/tasks/PW-027/gateway.int.test.ts` |
| SEC-EGRESS | URL fetch(https·443, 자격증명 URL 없음, IP 리터럴은 목록에 있어도 거부, DNS 응답 주소 전부 검사, rebinding). 네트워크 모듈·fetch는 어떤 형태든(import·`import()`·require·createRequire·window.fetch·별칭) 검토 목록에서만 쓰인다. `.js/.mjs/.cjs`, `infra/`, `scripts/`도 본다. | `tests/security/egress.test.ts`, `tests/tasks/PW-034/assets.int.test.ts`, `tests/security/static.test.ts` |
| SEC-SEND-POLICY | 논문의 전송 정책(민감 자료, 차단, 허용 공급자)이 공급자에게 자료가 가는 지점(`runProviderTurn`)에서 확인된다(**F-03**). 원문 전송 결정, 검색 발췌, checkpoint 재개, quota 깨우기의 정책 재확인도 포함한다. | `tests/security/send-policy.int.test.ts`, `tests/tasks/PW-034`, `PW-037`, `PW-047`, `PW-049` |
| SEC-CREDENTIAL | 로그인 프로필이 개발자 CLI 상태, 홈, symlink, 옮겨 둔 상태(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`·XDG)이면 거부한다(**F-01**). 모든 spawn은 환경을 명시하고(`{ env }` 포함) `process.env`를 펼치거나 복사하지 않는다. sandbox 안에서 상속하는 2곳은 검토했다(**F-04** 수정). 자격증명 파일은 읽지 않는다. 브라우저 저장소에 비밀이 없다. git에 비밀이 없다. 실행 시점 코드 생성(eval·new Function·vm)이 없다. sandbox runner(PW-026)도 포함한다. | `tests/security/credentials.test.ts`, `tests/security/static.test.ts`, `tests/tasks/PW-026/runner.test.ts` |
| SEC-PARSER | PDF·DOCX·원본 묶음 검증기의 크기·폭탄·경로·위조 | `PW-035`, `PW-055`, `PW-057` 시험 |
| SEC-AUTH | owner·세션·로그인 제한 | `PW-008` 시험 |
| SEC-REDACTION | 오류·로그의 비밀 가림 | `PW-052` 시험 |
| SEC-SUPPLY | 운영 의존성 111개 라이선스 허용 목록, latest·git·URL 의존성 없음, lockfile | `tests/security/supply-chain.test.ts` |

## IDOR sweep이 실제로 닿는 범위(리뷰 M1 반영)
- **route 범위**
  - 서버 route table 전체(152개)를 다룬다.
  - 모든 경로 매개변수 종류(23종)에 두 사용자 모두 실제 기록이 있어야 한다. 없으면 실패한다. 그래서 PDF anchor, story alternative, curation assessment, figure flag도 fixture가 만든다.
- **기본 점검**
  - 세션이 없으면 401이다.
  - CSRF 토큰이 없거나 다른 Origin이면 403이고, 바뀌는 것이 없다.
  - 다른 사용자의 논문에는 모든 논문 route가 404다.
- **교차 시도**(약 16,000 요청): 자기 논문에 다른 사용자의 id를 넣는다.
  - 경로: 모든 매개변수에 모든 id를 넣는다.
  - query: `asset_id`, `block_id`, `document_id`, `reference_id`
  - 본문: 모든 id 필드, 중첩 id(`nodes[].claim_ids`, `facts[].evidence_id` 등), 유효 선택값 변형 7종
  - 소유자 범위 POST(`/api/budgets` 등)
- **판정**
  - 다른 사용자의 글이 없어야 한다. ZIP·DOCX는 풀어서 본다.
  - **다른 사용자의 id**도 없어야 한다. 단, 요청에 넣은 것은 뺀다.
  - 상대 기록이 바뀌지 않아야 한다.
  - 상대 id가 자기 기록에 남지 않아야 한다.
  - 500이 없어야 한다.
- **positive control**(소유자 자신의 올바른 요청)
  - 읽기 route 62개가 모두 소유자에게 2xx로 답한다. 그래서 위의 교차 404는 실제 검사다. 예외 1개(Zotero 키 없음)는 이유와 함께 기록했다.
  - 바꾸기 route 80개 중 17개는 일반 본문이 검증을 지나 id 처리까지 간다.
  - **63개는 일반 본문이 첫 검증에서 멈춘다.** 그래서 sweep만으로는 본문 깊이의 교차 시도를 증명하지 못한다. 목록은 `sweep-stats.json`의 `changing_routes_not_reached`에 있다. 이 부분은 아래 두 가지로 덮는다.
    1. **DB가 교차 논문 참조를 거부한다**(`schema.int.test.ts`). 논문 범위 표 사이의 외래 키 113개 중 88개는 양쪽에 `paper_id`가 있다. 이 키들로는 어떤 route나 worker도 한 논문의 기록이 다른 논문의 기록을 가리키게 할 수 없다(리뷰 원본에서 FK 위반이 500으로 드러난 경우가 이것이다). 외래 키가 없는 참조는 아래 3·4가 맡는다. 나머지 25개는 이유가 검토된 예외 목록에 있고, 목록은 정확해야 한다(새 키나 사라진 예외는 실패).
       - job이 쓰는 것
       - 같은 행의 다른 복합 키가 논문을 고정하는 것
       - 요청이 주는 것: 표적 시험이 있다.
    2. **요청이 주는 비복합 참조 8종의 표적 시험**: 과학 검사, 리뷰, story 대안, Writer, 초안 요청, curation, 개요 노드의 주장 id·근거 id.
       - 다른 사용자의 id로는 4xx로 거부된다.
       - 자기 id로는 받아들여지거나, 그 id를 읽은 gate가 409로 멈춘다(대조군).
       - 상대 id는 남지 않는다.
    3. **외래 키 없는 id 배열**(재리뷰 M1'): 배열 열은 모두 `schema.int.test.ts`에 분류되어 있다(새 열은 실패).
       - id 배열 7개: 누가 쓰는지, 어디서 논문을 확인하는지, 어떤 시험이 보이는지가 적혀 있다.
       - 그 밖의 13개는 id가 아니다(메시지 코드, 공급자 이름, 사용자 글 등).
       - 이 점검에서 **F-05**를 찾았다. 개요 노드의 `claim_ids`·`evidence_ids`가 형식만 확인되어 다른 논문의 근거로 "근거 필요"를 채울 수 있었다. 수정했고, 표적 시험 2종(주장 id, 근거 id)을 추가했다.
    4. **원고 안의 id**(인용 `referenceId`, 그림 참조 `targetId`): 사용자의 수동 편집이므로 저장은 막지 않는다(제품 불변조건). 대신 논문 안에서만 풀린다.
       - 다른 논문의 문헌·그림은 내보내기에서 `unresolved_citation`·`unresolved_figure` 오류가 된다. 이 오류는 제출판 freeze를 막는다.
       - 그 내용(제목 등)은 보고서에도 파일에도 나오지 않는다(표적 시험).
       - JSON 문서 안의 다른 id(스냅샷 manifest 등)는 서버가 만든다.

## Findings
| ID | 심각도 | 상태 | 내용 | 근거 |
|---|---|---|---|---|
| F-01 | high | fixed | AI 실행 로그인 프로필이 개발자 CLI 상태일 수 있었다. 리뷰 n2: 옮겨 둔 상태 포함. | `credentials.test.ts`, RED `red-F01.log` |
| F-03 | high | fixed | 전송 정책을 실제 전송 지점(`runProviderTurn`)에서 확인하지 않았다. 선택 수정·curation worker는 자체 확인도 없었다. 지금은 mock만 연결되어 있어 잠재 위험이다. | `send-policy.int.test.ts`, RED `red-F03.log` |
| F-04 | low | fixed | sandbox 가용성 확인이 worker 환경 전체를 받았다. | `static.test.ts` |
| F-05 | medium | fixed | 개요 노드의 주장·근거 id가 형식만 확인되어, 다른 논문의 근거로 "근거 필요"를 채울 수 있었다(내용 유출은 없음: 읽는 쪽이 논문으로 거른다). 재리뷰 M1'. | `sweep.int.test.ts` 표적 2종, `schema.int.test.ts`, RED `red-F05.log` |
| F-02 | low | open | 웹 앱 CSP·frame-ancestors·Referrer-Policy가 없다. | PW-061 배포에서 다룬다. |

## spec 09 대조(리뷰 m5 반영)
| spec 09 항목 | 상태 |
|---|---|
| 인증·세션·CSRF·Origin·로그인 제한, 모든 범위의 owner 검사, 두 owner IDOR | SEC-IDOR-AUTH, SEC-AUTH |
| 비신뢰 데이터의 지시가 shell·인증·범위·승인·예산·export 대상을 못 바꿈 | SEC-INJECTION. export 대상은 고정(임의 경로·URL 없음, PW-056·057) |
| credential: 브라우저·git·로그에 없음, 최소 인증만 자식에게 | SEC-CREDENTIAL, SEC-REDACTION |
| credential 교체·logout·폐기 시 대기 job 재인증 | **부분.** run마다 admission을 다시 하고(PW-050), 인증 실패는 WAITING_AUTH가 되며(PW-052), 다시 시작은 사용자 행위다(PW-054). "교체" 자체의 시험은 없다. |
| 삭제된 credential snapshot의 부활 금지 | 해당 없음(summary에 credential을 넣지 않음). 시험 없음. |
| 파일: MIME·크기·쪽·압축 해제 크기, zip slip·XXE·macro | SEC-PARSER. macro: DOCX 매크로는 실행하거나 해석하지 않고, 포함 개체(OLE)는 손실로 보고한다(PW-055). |
| 외부 fetch: scheme·host·port·redirect·DNS 재검사, 내부 주소 금지 | SEC-EGRESS |
| PaperProject의 분류·허용 공급자·전송 정책 | SEC-SEND-POLICY |
| 로그: raw prompt·PDF·PII를 기본 로그에 넣지 않음 | **부분.** audit·tool call은 해시와 id만 둔다(PW-013·027). 오류는 가린다(PW-052). raw 디버그 저장 기능은 없다(opt-in도 없음). 로그 내용 전체의 자동 시험은 없다. |
| 위험 행위의 승인을 정확한 행동·해시·만료에 묶음 | 각 Task 시험: 승인 `content_hash`(PW-010·011·041), 적용 `proposal_hash`+기준 revision(PW-017·042), 자동 재개 허가 만료(PW-049), 제출판 intent+expected revision(PW-058). 이 감사 영역에는 넣지 않았다. |
| lockfile·license allowlist | SEC-SUPPLY |
| SBOM | **없음.** 라이선스 목록(`pnpm licenses`)은 있지만 SBOM 파일은 만들지 않는다. 후속 과제다. |
| GROBID·parser 패치 정책, canary 업데이트 | GROBID는 쓰지 않는다. parser 패치 정책은 PW-061 runbook에서 다룬다(미작성). |

## 수동 확인(필수) — `reports/security/manual-checks.json`
- **MAN-LIVE-SANDBOX**: 실제 Claude Code / Codex CLI를 sandbox 안에서, 별도 runtime 로그인 프로필로 실행한다. 사용자 PC와 연구실 서버에서 한다.
- **MAN-DEPLOY-TLS**: 배포에서 TLS, Secure 쿠키, origin, F-02 헤더를 확인한다(PW-061).
- 사용자가 확인한 뒤 해당 항목에 `status: "passed"`, `evidence`, `checked_by: "user"`, `checked_at`을 적고 게이트를 다시 돌린다.
- AI(개발 에이전트)는 이 기록을 쓰지 않는다.

## 시스템 프로그램(별도 프로세스, 링크하지 않음)
LibreOffice(MPL-2.0), poppler `pdftotext`(GPL), bubblewrap(LGPL), PostgreSQL

## 점검하지 않은 것
- 브라우저 XSS 자동 탐색
- 시간 경합 공격
- 외부 침투 시험
- 공급자의 보관·학습 정책: 사용자가 확인할 사항이다.
- 위 표의 "부분"과 "없음" 항목
