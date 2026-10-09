# PW-034 — 원문 권리·안전한 업로드 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_034_0001_source_assets.sql`
  - `asset_sources`: 원본이 어디서 왔는지(사용자 업로드 / 공개 접근 fetch + URL), 연결된 참고문헌, 쪽수, 검사기 버전. 바꿀 수 없다.
  - `asset_policy_revisions`: 라이선스, 보관 권리(`keep_right`), 외부 AI 전송 권리(`external_send`)를 별도 field로 둔다. 소유자 결정은 새 revision으로 쌓이고 최신이 적용된다. 바꿀 수 없다.
  - `asset_fetches`: 모든 URL fetch 시도와 결과. 바꿀 수 없다. 하루 상한 계산에 쓴다.
- `packages/domain/src/asset-policy/index.ts`
  - `inspectPdf`(바이트 수준 검사)
    - PDF 서명과 `%%EOF`, 크기, 쪽수 상한을 본다.
    - 암호화를 거부한다.
    - 활성 내용을 거부한다: JavaScript, JS, Launch, EmbeddedFile(s), RichMedia, XFA, SubmitForm, ImportData, GoToE.
    - 이름의 `#xx` escape를 풀고 본다.
    - 압축된 object stream(ObjStm)은 풀어서 본다. 풀린 크기 합계에 상한이 있다(zlib `maxOutputLength`, 압축 폭탄 대비).
  - `safeFileName`(경로·제어·양방향 제어 문자 제거), `contentDisposition`(attachment, RFC 5987)
  - `policyInput`: 업로드는 외부 전송 동의가 아니다. 기본값은 `unknown`이다.
  - `recordSourceAsset`(같은 바이트면 같은 자산), `listSourceAssets`, `getSourceAsset`, `decideAssetPolicy`
  - `externalSendDecision`: 다음 조건이 모두 맞아야 허용한다. `unknown`은 "아니오"다.
    - 논문의 외부 전송 정책
    - 민감 자료가 아님
    - 논문이 허용한 공급자
    - 자산 자신의 전송 권리
    - 보관 권리
  - URL 정책 `checkFetchUrl`
    - https와 443 포트만 허용한다.
    - 계정정보가 든 URL과 IP literal을 거부한다.
    - 고정된 공개 접근 host만 허용한다: Europe PMC, NCBI PMC, arXiv.
  - `isInternalAddress`: loopback, 사설, CGNAT, link-local(metadata), 문서용, multicast, IPv6 ULA·link-local, IPv4-mapped, NAT64, IPv4 호환 주소를 막는다.
  - 소유자별 하루 상한(`checkFetchQuota`), `logFetch`
- `apps/api/src/assets/`
  - `store.ts`: 내용 주소(`sha256/xx/<hash>`). 임시 파일 → fsync → 읽기 전용 → rename 순서로 쓴다. 읽을 때마다 hash를 검증한다.
  - `fetch.ts`
    - 해석된 주소 전부를 검사한 뒤, 검사한 주소로 연결을 고정한다(DNS rebinding 대비).
    - redirect를 따라가지 않는다. 쿠키·인증을 보내지 않는다.
    - `application/pdf`만 받고 크기 상한을 둔다.
  - `index.ts`(route, 모두 paperScoped)
    - `POST /assets`: 원본 PDF 업로드, 쿼리에 license, keep_right, external_send, reference_id, name
    - `POST /assets/fetch`, `GET /assets`, `POST /assets/:id/policy`, `GET /assets/:id/send-check`
    - `GET /assets/:id/content`: attachment, nosniff, `CSP: sandbox`, no-store. hash가 틀리면 500이고 바이트를 내보내지 않는다.
- 범위 밖(RFC-011 부록): `apps/api/src/server.ts`(`assets` 옵션·등록), `apps/api/src/index.ts`(저장 폴더 `PW_ASSET_DIR`, 기본은 실행 사용자의 `~/.local/share/paper-workspace/assets`)
- 시험: `tests/tasks/PW-034/assets.int.test.ts`(통합 10)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-034-A / TST-034A 파일 hash·source·license/unknown·전송 허용 상태가 함께 저장 | 업로드: hash·크기·출처·쪽수·라이선스·보관·전송 권리가 함께 저장된다. 전송 권리는 `unknown`이다. 원본은 읽기 전용 파일이다. 같은 바이트면 같은 자산이고, 라이선스가 없으면 unknown이다. 표는 바꿀 수 없다 |
| | 권리 결정은 새 revision으로 쌓인다(이전 유지). 잘못된 값과 모르는 field는 422, 남은 404다 |
| | 참고문헌 연결은 같은 논문의 것만 된다(route와 저장 함수 둘 다 검사) |
| | 다운로드: attachment, 깨끗한 이름, nosniff, sandbox CSP, no-store. 디스크의 파일이 바뀌면 500이고 바이트를 주지 않는다 |
| REQ-034-B / TST-034B 유료벽 우회·무제한 crawling·SSRF·악성 파일·무승인 외부 LLM 전송 차단 | 거부하는 파일: JavaScript, escape된 이름, Launch, 내장 파일, XFA, 암호화, object stream 안에 숨긴 JavaScript, HTML, 잘린 파일. 압축 폭탄과 쪽수 상한도 거부한다. 거부된 파일은 행도 blob도 남기지 않는다. 다른 type은 415, 큰 body는 413이다 |
| | 외부 전송: 기본 unknown은 불가다. 거부, 공급자 불허, 민감 자료, 논문 차단도 각각 불가다. 모두 허용일 때만 허용한다(API 동일) |
| | URL 정책: http, 계정정보, 다른 포트, IP, 출판사 유료벽 host, file/gopher를 거부한다. 내부 주소의 여러 표기를 모두 막는다 |
| | fetch 결과는 모두 기록된다(`asset_fetches`). 출력 순서: 허용 host라도 내부 주소로 해석되면 거부 → 목록 밖 host → redirect → HTML 로그인 페이지 → 악성 PDF → 정상 저장. 정상 저장은 `license/keep_right/external_send` 모두 unknown이다 |
| | 하루 상한: 상한에 이르면 URL에 상관없이 요청을 내보내지 않는다(stand-in 서버 호출 수 불변). 상한은 소유자별이다 |

## RED → GREEN
- RED(`red.log`): migration과 domain 모듈만 있고 route가 없을 때 8개가 실패했다. 순수 함수 2개(URL 정책·내부 주소)는 그때 이미 통과했다.
- GREEN: 통합 10
- mutation(`mutation.log`): 처음 34종 중 5종이 살아남았다.
  - escape된 이름: 시험이 `/JS`로도 잡혔다 → Launch로 바꿨다.
  - inflate 상한 중복 검사: 동치라 지웠다.
  - NAT64 점 표기: 시험을 더했다.
  - 저장 함수의 참고문헌 검사: 직접 호출 시험을 더했다.
  - 상한 검사 순서: 목록 밖 URL도 상한에 걸리는지 시험을 더했다.
  - 다시 돌린 5종은 모두 탐지했다.
- 회귀: 첫 실행은 PW-014 runtime-load 시험이 실패했다(`pnpm-test-first-run.log`). strip-types가 TypeScript parameter property를 지원하지 않는다. `FetchRefused`를 일반 field로 고친 뒤 `pnpm test` exit 0 — unit 278, integration 308, contracts 17, 브라우저 82(`pnpm-test.log`).

## 보안·과학적 실패 경로
- 업로드는 외부 전송 동의가 아니다. 전송 권리는 소유자가 명시해야 하고, 논문 정책·공급자·민감도와 함께 모두 맞아야 한다.
- 원본은 바뀌지 않는다. 바뀐 파일은 내보내지 않는다(무결성 실패를 숨기지 않음).
- 유료벽 우회 경로는 없다. 사용자의 합법적 업로드와 고정 공개 접근 host만 쓴다. 쿠키와 인증을 보내지 않고 redirect를 따르지 않는다.
- crawling은 소유자별 하루 상한이다(모든 시도를 셈).

## 미실행 / 남은 위험
- 바이트 수준 검사는 parser가 아니다.
  - 예: ObjStm 외 stream의 다른 필터(LZW 등)에 숨긴 dictionary, 형식이 깨진 PDF의 해석 차이.
  - 실제 PDF parsing은 별도 리소스 제한 프로세스에서 한다(PW-035, spec 09).
  - 그 parser도 신뢰할 수 없는 입력으로 다룬다.
- 실제 공개 접근 host(Europe PMC, PMC, arXiv)로는 fetch하지 않았다(네트워크 미사용). 응답 형식(PDF 직접 응답 여부)은 실제로 확인해야 한다(not_run). 그 host들의 이용 조건도 사용자가 확인한다.
- 시스템 resolver의 실제 동작(다중 주소, IPv6 우선)은 test resolver로만 확인했다.
- 고아 blob: 검사를 통과한 뒤 DB 기록이 실패하면 blob이 남을 수 있다. 내용 주소라 해는 없고, 정리 작업은 나중에 한다.
- 웹 화면은 이 Task 범위가 아니다(PW-035 PDF 보기와 함께 한다).

## 다음
PW-035: PDF 파싱·anchor
