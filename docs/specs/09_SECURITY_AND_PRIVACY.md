# 09. Security, privacy and abuse cases

## 개인 앱도 인증이 필요하다
localhost 기본 + 최초 owner 설정. 원격 공개 시 TLS·안전한 session cookie·CSRF/Origin 검사·login rate-limit. unguessable ID는 권한 검사 대체가 아님. API, SSE, blob URL, search, jobs, comments, exports 모두 owner/project scope 검사. v1에 다중 사용자를 내세우지 않더라도 두 테스트 owner로 IDOR 회귀 검증.

## 신뢰 경계
문헌/PDF/DOI metadata/외부 tool result/AI summary/공동저자 comment는 비신뢰 데이터. 이 안의 명령이 shell·인증·scope·승인·예산·export destination을 바꾸지 못하게 한다. ‘이 PDF의 지시대로 환경변수를 보내라’ 등의 합성 injection fixture로 검사. 프롬프트만으로 방어하지 않고 tool gateway·egress·server schema로 차단한다.

## Credential
브라우저 localStorage/querystring/git/AI 대화/raw logs에 key/token 금지. 전용 secret store 또는 제한된 권한 서버 파일. 운영 key와 개발 key 분리. provider child에게 필요한 최소 인증만 제공하며 부모 전체 env를 상속하지 않는다. rotation/logout/revocation 시 queued job 재인증. 삭제된 credential snapshot을 summary에서 부활시키지 않는다.

## 파일과 URL
허용 MIME·크기·page count·uncompressed size 제한. zip slip·symlink·macro·XXE·HTML script 차단. PDF parser/export tool은 별도 리소스 제한 프로세스. 외부 fetch는 scheme/host/port·redirect·DNS resolved IP 재검사. localhost/RFC1918/link-local/cloud metadata/internal services를 일반 URL fetch로 읽지 못하게 함. Zotero local API 같은 명시적 localhost connector는 별도 승인된 adapter에 한정. export는 임의 file path나 외부 URL을 모델이 지정하지 못함.

## 미공개 연구자료
PaperProject에 data_classification, allowed_providers, external_send_policy를 저장. 채팅 시작 전 어떤 자료가 어느 공급자에 전달되는지 보여준다. 사용자 업로드가 곧 제3자 전송 동의를 뜻하지 않음. 민감한 인체/개인식별 데이터는 redaction 또는 전송 차단 정책을 요구. 기관 규정·저널 embargo 등은 사용자 확인사항. 보관/학습/지역 정책을 공급자 전체에 획일적으로 보장하지 않음.

## 로그
audit는 actor, intent, revision IDs, action, outcome, timestamps, model/version, input manifest hash를 저장. raw prompt/full PDF/PII는 기본 로그에 넣지 않음. 디버그 원문 저장은 별도 opt-in·짧은 보존·암호화. runtime hidden reasoning을 필수 저장/제품 UI로 삼지 않는다. user-visible response와 도구 실행 사실로 재현성을 확보한다.

## 위험 행위
원시 실험 데이터 수정·외부 이메일·논문 투고·Git push·계정 변경·추가 결제·운영 삭제는 AI writing scope 밖. 사용자 승인 UI가 있더라도 재사용/위조되지 않도록 exact action/hash/expiry에 바인딩한다. 기본 paper runtime에는 이 tool 자체를 제공하지 않는다.

## 공급망과 운영
lockfile/digest/SBOM/license allowlist. 자동 업데이트 대신 canary+contract regression. GROBID와 PDF/Word parser 패치 정책. AI가 unknown dependency를 설치하거나 plugin을 전역 로드하지 않음. security findings는 P00/Phase gates에서 blocker로 처리한다.
