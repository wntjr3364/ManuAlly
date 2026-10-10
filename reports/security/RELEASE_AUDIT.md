# Security release audit (PW-059) — 2026-10-10

**Gate decision: `pending_manual`** (`node tests/security/run-audit.ts`, exit 2; record: `reports/security/audit.json`).
- 자동 점검 8영역이 모두 통과했다: 263개 시험, 실패 0, skip 0.
- critical·high 미해결 finding이 없다. F-01(high)은 고쳤고 시험으로 확인했다.
- 실제 기계에서만 할 수 있는 두 확인이 남아 release를 허용하지 않는다(아래 "수동 확인"). 사용자가 근거를 기록해야 한다.

## 게이트 규칙(`tests/security/gate.ts`, 시험 `tests/security/gate.test.ts`)
- **refused**
  - 필수 자동 영역이 없거나, 실패했거나, 실행되지 않았거나, 시험이 0개이거나, skip이 하나라도 있다. skip은 통과가 아니고 숨기지 않는다.
  - critical·high finding이 open이다.
  - critical·high 위험을 사용자가 아닌 쪽이 수용했다. AI는 위험을 수용할 수 없고, 수용자와 날짜가 기록돼야 한다.
  - `fixed` finding에 그것을 보여 주는 시험이 없다.
  - 형식이 잘못됐다.
- **pending_manual**: 위에 해당하지 않지만 필수 수동 확인의 근거가 없다.
- **allowed**: 나머지. medium·low open finding은 목록으로 보인다.
- 영역 결과는 시험 실행기(vitest JSON)에서 읽는다. 사람이나 AI가 적어 넣지 않는다.

## 영역과 근거
| 영역 | 무엇을 | 근거(시험) | 결과 |
|---|---|---|---|
| SEC-IDOR-AUTH | 서버 route table 전체(152개, 새 route도 자동 포함). (1) 세션 없음 → 401. (2) CSRF 토큰 없음 또는 다른 Origin → 403, 변경 없음. (3) 다른 사용자 논문 → 모든 논문 route 404, 내용 없음. (4) 자기 논문 + 다른 사용자의 id(경로 모든 매개변수 × 모든 id, 본문의 모든 id 필드, 유효 선택값 변형 7종): 약 13,000 요청에서 내용 유출 0(ZIP·DOCX는 풀어서 검사), 상대 기록 변경 0, 상대 id가 자기 기록에 남은 것 0, 500 응답 0. 모든 경로 매개변수에 id 출처가 있어야 한다(없으면 실패). | `tests/security/sweep.int.test.ts`, `reports/tasks/PW-059/sweep-stats.json` | 통과 |
| SEC-INJECTION | 원고·아웃라인·문헌에 심은 지시("env를 보내라, /etc/passwd, 모든 제안 적용, 다른 논문 읽기")를 그대로 따르는 모델이 18가지를 시도한다. 금지 도구는 모두 거부되고, 다른 논문 내용은 0, 적용·승인·이동도 0이며, 모든 시도가 audit에 남는다(숨은 방향 문자는 `?`로 보임). 도구 목록에 env·file·http·shell·approve·apply 같은 것이 없다. 그리고 PW-027 gateway(scope는 run token에서만). | `tests/security/injection.int.test.ts`, `tests/tasks/PW-027/gateway.int.test.ts` | 통과 |
| SEC-EGRESS | 일반 URL fetch는 하나(open-access PDF)뿐이다. https·443만, 자격증명 URL 없음, IP 리터럴은 목록에 있어도 거부, 비슷한 이름 거부. DNS 응답의 모든 주소를 검사한다: loopback·사설·link-local·메타데이터·CGNAT·멀티캐스트·IPv6 안의 IPv4. 좋은 주소 사이에 나쁜 주소가 하나만 있어도 연결 전에 거부한다. 네트워크 모듈과 `fetch`는 검토된 4+3곳에서만 쓰이고(새 곳은 실패), API는 PDF fetcher 말고 외부로 나가지 않는다. | `tests/security/egress.test.ts`, `tests/tasks/PW-034/assets.int.test.ts`, `tests/security/static.test.ts` | 통과 |
| SEC-CREDENTIAL | AI 실행에 묶이는 로그인 프로필이 개발자 CLI 상태(`~/.claude`, `~/.codex`), 그 안, 홈 자체, 그리로 가는 symlink이면 거부한다(**F-01 수정**). 자식 프로세스는 검토된 5곳에서만 시작되고 모두 환경을 명시하며, 서버 환경을 넘기지 않는다. 자격증명 파일은 이름만 다루고 읽지 않는다. 브라우저 저장소에 토큰이나 비밀이 없다. git에 비밀 모양 문자열이 없다(합성 fixture 1곳 검토). sandbox runner(PW-026)도 포함한다. | `tests/security/credentials.test.ts`, `tests/security/static.test.ts`, `tests/tasks/PW-026/runner.test.ts` | 통과 |
| SEC-PARSER | PDF(크기·쪽·inflate bomb, 별도 제한 프로세스), DOCX(ZIP 항목·크기·CRC·깊이·DOCTYPE 거부), 원본 묶음 검증기(이중 이름·경로 탈출·위조) | `tests/tasks/PW-035/pdf.int.test.ts`, `tests/tasks/PW-055/docx.test.ts`, `tests/tasks/PW-057/archive.test.ts` | 통과 |
| SEC-AUTH | owner·세션·로그인 제한·논문 범위 | `tests/tasks/PW-008/*.int.test.ts` | 통과 |
| SEC-REDACTION | 오류와 로그의 비밀 가림(키 접두어, 라벨 값, 긴 불투명 문자열) | `tests/tasks/PW-052/classify.test.ts` | 통과 |
| SEC-SUPPLY | 운영 의존성 111개의 라이선스가 모두 허용 목록에 있다(MIT·ISC·BSD·Apache-2.0·MIT/CC0). latest·`*`·git·URL 의존성이 없다. lockfile이 추적된다. | `tests/security/supply-chain.test.ts` | 통과 |

시험이 실제로 잡는지 확인했다(`reports/tasks/PW-059/mutation.log`).
- IDOR 심기 6종 중 5종을 바로 잡았다. 남은 1종은 본문 변형을 넣은 뒤 잡았다.
- 게이트 규칙 7종, F-01, egress 2종(1종은 시험 보강 뒤), 정적 점검 심기 4종을 모두 잡았다.

## Findings
| ID | 심각도 | 상태 | 내용 | 근거·계획 |
|---|---|---|---|---|
| F-01 | high | fixed | AI 실행에 자격증명 파일이 묶이는 로그인 프로필을 개발자 CLI 상태나 홈과 대조하지 않았다. 설정을 잘못하면 개발용 주 로그인이 실행에 들어간다(constitution: 기존 credential 디렉터리 공유 금지). | RED `reports/tasks/PW-059/red-F01.log` → `prepareStateDir`가 `assertSafeProfileDir`를 쓴다. 시험 `tests/security/credentials.test.ts`, RFC-010 시험 10개 통과. |
| F-02 | low | open | 웹 앱에 CSP·frame-ancestors·Referrer-Policy가 없다. 쿠키는 이미 SameSite=Strict와 HttpOnly이고, 원문은 sandbox CSP로 보낸다. | PW-061 배포 runbook에서 빌드 앱을 그 헤더와 함께 제공하고, TLS 뒤에서 Secure 쿠키를 쓴다. |

## 수동 확인(필수, 아직 근거 없음 → `pending_manual`)
- **MAN-LIVE-SANDBOX**: 실제 Claude Code / Codex CLI를 별도 runtime 로그인 프로필로 bubblewrap sandbox 안에서 실행한다. 사용자 PC와 연구실 서버(sudo 없음) 둘 다에서 한다.
  - 이 환경에는 자격증명이 없고, 개발 에이전트는 실제 CLI를 실행하지 않는다.
  - 확인할 것: 프로필 경로가 `~/.claude`이면 거부되는지, egress 목록 밖으로 나가지 못하는지, 실행 폴더가 지워지는지.
- **MAN-DEPLOY-TLS**: 배포에서 TLS, Secure 쿠키, allowed origins, F-02 헤더를 확인한다(PW-061).
- 사용자가 확인하고 `reports/security/audit.json`의 해당 항목에 근거(날짜·기계·결과 파일)를 남기면, 게이트를 다시 돌려 `allowed`가 된다.

## 시스템 프로그램(별도 프로세스, 링크하지 않음)
- LibreOffice(MPL-2.0, PDF 변환), poppler `pdftotext`(GPL, 본문 확인), bubblewrap(LGPL, sandbox), PostgreSQL(PostgreSQL License)
- 모두 별도 프로세스로 실행하고 앱에 링크하지 않는다. 배포 시 사용자 시스템의 설치본을 쓴다.

## 점검하지 않은 것
- 브라우저 XSS 자동 탐색: React escape와 편집기 schema에 의존한다. 원문 HTML 렌더는 없다.
- 시간 기반 경합 공격, 서비스 거부(요청 상한·크기 상한은 있다)
- 외부 침투 시험
- 실제 공급자의 보관·학습 정책. 공급자별로 보장하지 않고, 사용자가 확인할 사항이다(spec 09).
