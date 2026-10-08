# Provider compatibility and admission gate
**이전 대화의 “구독 세션을 새로 열면 자체 웹앱에서도 바로 쓸 수 있다”는 전제를 확정 설계로 사용하지 않는다.** 기술 지원과 이용 허용 범위는 별개다.

| 항목 | Claude | Codex | 구현 판단 |
|---|---|---|---|
| 정식 프로그래밍 연동 | Agent SDK / CLI -p [S01,S02] | App Server [S07] | 공식 구조화 출력만 기본 채택 |
| 세션 | 명시 ID / resume / fork [S03] | thread ID / resume [S07] | 세션 저장소와 작업 cwd 별도 |
| 인증 | SDK 문서는 API key 안내; 제3자 claude.ai 로그인/한도 제공 사전승인 제약 [S01] | API key 및 환경에 따른 ChatGPT 인증; local/open-source와 hosted/commercial 구분 [S08] | P00 admission 승인 전 연동 disabled |
| 수동 압축 | SDK·CLI 버전에 따라 capability를 검증 | thread/compact/start 문서화 [S07] | supports_manual_compact=false이면 checkpoint 후 새 세션 |
| context 관측 | 실행 모드별 차이 [S04] | thread token usage surface [S07] | known/estimated/unknown 표시 |
| quota/reset | 상태줄의 조건부 필드가 headless 계약을 의미하지 않음 [S04] | 인증모드별 account/rateLimits/read [S07] | unavailable은 UNKNOWN, private endpoint 스크래핑 금지 |
| 웹 연결 | 플랫폼 서버/worker가 broker | App Server stdio 사용 권장 [S07] | raw agent server를 브라우저/인터넷에 직접 노출하지 않음 |

## 배포 프로파일
A. **PERSONAL_LOCAL**: 사용자가 소유한 머신의 브라우저+전용 runner. 공급자가 해당 개인 사용·인증을 허용하는지 확인한다. 논문 서비스 자체는 loopback 기본.
B. **PRIVATE_SELF_HOSTED**: 연구용 서버에서 개인이 접속. 로컬 앱과 동일 정책이라 가정하지 않는다. 해당 인증방식의 hosted 허용 여부를 확인하거나 API 인증을 사용한다.
C. **MULTIUSER_HOSTED**: v1 제외. 독립적인 OAuth 승인·과금·테넌트 보안 설계 없이는 활성화하지 않는다.

## P00에서 남겨야 할 증거
1. 제품/CLI/SDK version, 배포 프로파일, 인증 종류(비밀 제외), 공식 근거 확인일.
2. structured turn 1회, JSON event stream, explicit session resume, interrupt, usage 이벤트의 실제 shape.
3. compact 요청 수용뿐 아니라 완료 event와 이어지는 실행 확인. 미지원은 새 세션 재수화로 대체.
4. quota 정보 없음·expired auth·429·네트워크 단절의 adapter normalization.
5. 기존 세션/홈/working tree를 건드리지 않는 부정 테스트.
6. 실제 호출은 사용자 승인 계정·예산과 합성 논문 텍스트로만 수행. 미실행 항목은 blocked.

## 금지되는 지름길
credential 파일 복사, 기존 사용자 세션 자동 attach, latest-session 재개, 개인 브라우저 cookie 추출, 요금제 우회, 한도 소진 시 무단 API fallback, reset credit 자동 소비, 계정 owner에게 이메일 자동 발송. Codex의 `thread/shellCommand` 등 sandbox 밖 명령 surface는 tool gateway에 노출하지 않는다 [S07].

## Capability registry
provider/version/auth/deployment 조합마다 session_resume, structured_tools, interrupt, manual_compact, usage_events, context_window, quota_read, reset_at, max_output_control, sandbox_profile을 저장한다. capabilities는 LLM의 응답이 아니라 테스트와 adapter 코드에서 설정한다. 문서상 supported와 실제 verified를 분리한다.
