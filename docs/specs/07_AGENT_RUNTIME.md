# 07. Provider-independent runtime and isolation

## 세 가지 구분
PaperProject는 영구 연구 객체. WorkThread는 사용자의 특정 문단·개요·검토 대화. AgentSession은 provider-native 임시 실행 세션. 논문 하나에 항상 하나의 영구 세션만 고집하지 않는다. WorkThread는 여러 AgentSession으로 이어질 수 있고 해당 mapping/history를 보존한다. 일반 paper context는 DB에서 재구성한다.

## Adapter interface
capabilities(), start_session(), resume_session(explicit_id), run_turn(contract), interrupt(), compact_if_supported(), inspect_usage(), inspect_quota(), close(). 위 이름은 **플랫폼 내부 interface**이며 실제 SDK 메서드가 아님. 어댑터에서 공식 SDK/JSON-RPC로 매핑하고 P00에서 검증한다 [S01–S08].

Claude: Agent SDK structured tools/events 우선, 지원이 명확한 headless fallback만. 설치 버전에서 compact API가 없으면 새 세션 hydration. Codex: private stdio App Server + pinned generated schema. raw RPC allowlist. Browser는 provider port/credential/session directory에 직접 접근하지 않는다.

## 세션 식별
SessionBinding(paper_id,work_thread_id,provider,provider_version,auth_profile_id,native_session_id,run_state_dir,cwd,capability_snapshot). session lookup은 서버 owner/paper scope로 제한. `--continue`, 최신 세션 찾기, 현재 folder 기준 암묵 resume 금지. 사용자 개발 CLI와 같은 home/config를 공유하지 않는다.

## 실제 격리
control plane와 agent process를 분리. user namespace/별도 서비스 계정, run별 writable sandbox, 선택한 immutable input read-only, CPU/memory/pids/임시디스크 제한, 제한된 network egress. 기본 shell·범용 file tool·프로젝트 repo 로드 비활성. host home, Docker socket, SSH agent, 운영 DB creds mount 금지. symlink·path traversal·/proc·metadata endpoint 경로까지 부정 테스트.

컨테이너 자체를 무조건 완벽한 security boundary로 설명하지 않는다. control plane 및 승인된 OS 설정이 보장하는 범위와 잔여 위험을 문서화한다. Git worktree는 코드 분리 수단이지 보안 sandbox가 아니므로 논문 집필 런타임의 필수는 아님.

## Tool gateway
읽기: get_approved_outline, get_document_slice, get_fact_records, get_reference_excerpt, get_figure_metadata, search_literature_with_budget.
제안: propose_outline_change, propose_manuscript_edit, propose_profile_change, add_candidate_reference, add_review_finding.
금지: approve_outline, set_verified_fact, apply_approved_patch, change_owner, delete_snapshot, change_budget, arbitrary_http/shell/write_file, submit_paper.

모델이 제시하는 paper_id는 권한 부여에 사용하지 않는다. 도구의 project scope는 run token에서 결정한다. 승인·정본 변경은 브라우저/서버 domain layer 책임. 정해진 tool allowlist에도 field-level authorization을 적용한다.

## 실행 상태
CREATED → QUEUED → RUNNING → PROPOSAL_READY → AWAITING_USER_APPLY → COMPLETED.
보조 상태: CHECKPOINTING, COMPACTING, WAITING_QUOTA, WAITING_AUTH, WAITING_NETWORK, WAITING_BUDGET, WAITING_USER, INTERRUPTED, FAILED, CANCELED, STALE.
job 완료(제안 생성)와 proposal 적용 완료를 별도 모델로 구현해 상태 혼동을 피한다. UI의 ‘완료’는 무엇이 끝났는지 적는다.

## 취소·소유권
cancel request를 DB에 먼저 기록하고 adapter interrupt, graceful timeout 후 해당 child process group만 종료. broad pkill 금지. orphan process 재연결은 OS PID만 아니라 session binding/fencing token을 확인한다. app restart 시 남아 있는 side effect 여부를 reconcile. 취소 뒤 늦게 도착한 response는 canonical 문서에 적용하지 않는다.

## 사용량·외부 세션
세션 분리는 같은 provider account quota를 분리하지 못한다. CPU·RAM도 물리적으로 공유된다. 앱 자체 concurrency·budget·priority로 간섭을 줄이되 터미널 사용량을 정확히 예약/보호한다고 주장하지 않는다. 통제 밖 사용량이 있으면 remaining은 공급자 관측 시점의 상태임을 표시한다.
