# 08. Context, quotas, durability and resume

## 세 가지 제한을 분리
ContextWindow: 현재 model request의 입력+예정 도구결과+출력 여유. UsageQuota: 계정/모델/시간창별 공급자 사용 한도. Budget: 사용자가 승인한 앱/프로젝트/작업 비용. compact는 quota를 되돌리지 않는다 [S04,S07,S19,S20].

## Context builder
우선순위: 서버 불변 정책 → 승인된 story/outline scope → 해당 facts/evidence → 선택 문장과 인접 문단 → 필요한 용어/profile → 관련 결정/미해결 comment → 최신 대화 일부. 전체 PDF·모든 세션 로그를 주입하지 않는다. public literature source와 사용자 승인 instruction은 다른 채널/데이터 field로 둔다.

현재 request budget 계산은 model/version별 capability에 근거한다. context_window - estimated_current_input - expected_tool_payload - output_reserve - safety_margin. cumulative billed token을 context occupancy로 쓰지 않는다. counter가 없으면 estimate+UNKNOWN field; 정확한 퍼센트처럼 표시하지 않음.

## Checkpoint
모든 외부 호출 전, 결과 검증 후, proposal 저장 후 DB checkpoint. LLM 요약 호출 없이도 생성 가능한 구조로 설계. approved revision IDs/hashes, job intent, completed action IDs, pending step, needed sources, policy/version, budget reservation, provider/session, last_event, cancellation/approval 상태를 보존. 원문/수치/승인 상태의 정본은 참조 객체에 있다. summary는 untrusted helpful note이고 승인 증거가 아니다.

## 압축 시점
초기 제안: 대략 70%에서 checkpoint 검토, 80% 부근 또는 예상 다음 turn budget 부족 시 압축/세션 교체 준비. 절대적인 공급자 한도가 아니다. 긴 도구 결과를 받기 전에 예약량을 확인한다. 모델 호출 중인 turn을 임의 잘라 compact하지 않는다. 안전한 boundary → checkpoint → compact 완료 확인 또는 새 세션 → 재수화 → revision/policy 재검사 → 다음 step. 요약에서 잃어버린 정보를 추측하지 않음.

## Quota normalization
quota schema에 observed_at, provider/auth/model/bucket, used_percent|null, reset_at|null, confidence=provider_reported|estimated|unknown, retry_after, error_kind를 둔다. reset은 UTC epoch/ISO로 정규화해 Asia/Seoul로 표시. 한 창이 리셋돼도 weekly/credit/model limit이 남아 있으면 재개하지 않음. 상한 시간을 얻지 못하면 ‘초기화 시각 확인 불가’ 표시 후 bounded backoff/manual resume. 존재하지 않는 5시간 리셋을 가정하지 않음.

## 자동 재개
사용자가 처음 허용한 task scope, 비용, auto_resume, 유효기간 안에서만 동작. WAITING_QUOTA를 durable DB에 저장하고 scheduled wake-up을 등록. reset+짧은 jitter 뒤 실제 가능여부/인증/다른 bucket/현재 문서 revision/작업 취소/정책 변경을 재검사. 재개는 draft/proposal 생성까지며 사용자 원고 적용을 자동 승인하지 않는다. 오랫동안 대기한 task는 WAITING_USER 또는 재확인. provider fallback과 추가 결제, rate-limit reset credit 소비는 별도 명시 승인 없이는 금지.

## Budget
작업 enqueue 전에 원가 estimate와 상한 예약. 앱·paper·run·provider별 승인 예산 관리. 알려지지 않은 비용은 UNKNOWN; 기본은 유료 실행 차단. 스트림 종료/실패에도 확인된 usage를 기록한다. 재개된 세션의 누적 비용 이벤트는 provider metric kind와 고유 event key로 delta 계산; 음수/역전은 anomaly로 표시. 공급자 usage에는 지연·추정이 있을 수 있으므로 앱의 소프트 예산만으로 exact invoice hard cap을 약속하지 않는다. 호출당 output/turn/tool-call/repair 제한과 provider hard cap을 함께 사용한다.

## 신뢰 가능한 queue
DB job + outbox가 논리 명령을 내구성 있게 보존. queue는 dispatch를 담당. lease heartbeat + fencing token으로 오래된 worker가 commit하지 못하게 한다. 모델 호출 전 상태를 기록하고 response를 받으면 proposal부터 저장한다. 외부 응답 유실은 reconciliation/안전 재생성으로 처리하며 ‘외부 모델은 정확히 한 번만 과금됐다’고 보장하지 않는다.

## 오류 종류별 동작
429 quota → WAITING_QUOTA; 401/403 credential → WAITING_AUTH; 일시 네트워크 → bounded retry; provider 과부하 → bounded retry/circuit breaker; hard budget → WAITING_BUDGET; evidence missing → WAITING_USER; schema violation → 최대 1회 constrained repair 후 실패; 문서 conflict → STALE; disk full → 안전 중단·저장 미완 알림.

## 웹 상태
현재 scope/task, 마지막 checkpoint, 모델·provider, 측정/추정 context, 앱 token/cost와 계정 quota 구분, 확인된 reset 시각, 대기 이유, stop/resume. 수동 editor는 AI 한도와 무관하게 작동한다. 로그 화면은 secret/raw hidden reasoning 대신 user-visible 답변·tool facts·audit를 제공한다.
