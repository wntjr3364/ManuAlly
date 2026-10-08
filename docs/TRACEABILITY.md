# Requirements and traceability

모든 항목은 명세 상태다. Test ID는 향후 구현해야 할 검증 계약이며 실제 test 파일/결과는 Task 보고서에 연결한다.
| Requirement | Task | 테스트 설계 | 목표 |
|---|---|---|---|
| REQ-001 | PW-001 | TST-001A, TST-001B | 환경·저장소·운영 경계 확인 |
| REQ-002 | PW-002 | TST-002A, TST-002B | Provider 인증·배포 admission |
| REQ-003 | PW-003 | TST-003A, TST-003B | 문서 선택·포맷 왕복 spike |
| REQ-004 | PW-004 | TST-004A, TST-004B | 실행 세션·권한 격리 spike |
| REQ-005 | PW-005 | TST-005A, TST-005B | 집필 품질 baseline fixture |
| REQ-006 | PW-006 | TST-006A, TST-006B | P00 검토·ADR·버전 고정안 |
| REQ-007 | PW-007 | TST-007A, TST-007B | Monorepo와 검증 명령 scaffold |
| REQ-008 | PW-008 | TST-008A, TST-008B | Owner 인증과 PaperProject |
| REQ-009 | PW-009 | TST-009A, TST-009B | 불변 revision·snapshot 저장 |
| REQ-010 | PW-010 | TST-010A, TST-010B | 수동 Story·Outline 승인 |
| REQ-011 | PW-011 | TST-011A, TST-011B | Claim·Fact·Evidence 최소 모델 |
| REQ-012 | PW-012 | TST-012A, TST-012B | Shared editor schema·계약 |
| REQ-013 | PW-013 | TST-013A, TST-013B | DB job·outbox·audit 기반 |
| REQ-014 | PW-014 | TST-014A, TST-014B | 수동 논문 수직경로 검증 |
| REQ-015 | PW-015 | TST-015A, TST-015B | 에디터·자동저장·IME |
| REQ-016 | PW-016 | TST-016A, TST-016B | Selection toolbar·Short Chat |
| REQ-017 | PW-017 | TST-017A, TST-017B | Proposal·CAS·원자 적용 |
| REQ-018 | PW-018 | TST-018A, TST-018B | Highlight·Comment anchor |
| REQ-019 | PW-019 | TST-019A, TST-019B | Citation·Figure crossref node |
| REQ-020 | PW-020 | TST-020A, TST-020B | Mock AI·스트리밍 UI |
| REQ-021 | PW-021 | TST-021A, TST-021B | Version compare·Undo·기본 import |
| REQ-022 | PW-022 | TST-022A, TST-022B | 선택편집 브라우저 gate |
| REQ-023 | PW-023 | TST-023A, TST-023B | Provider registry·이벤트 정규화 |
| REQ-024 | PW-024 | TST-024A, TST-024B | Claude Agent adapter |
| REQ-025 | PW-025 | TST-025A, TST-025B | Codex App Server adapter |
| REQ-026 | PW-026 | TST-026A, TST-026B | Isolated runner·입출력 mount |
| REQ-027 | PW-027 | TST-027A, TST-027B | Typed tool gateway·scope |
| REQ-028 | PW-028 | TST-028A, TST-028B | Interrupt·취소·재연결 |
| REQ-029 | PW-029 | TST-029A, TST-029B | Usage·quota 관측 기본 |
| REQ-030 | PW-030 | TST-030A, TST-030B | 실제 provider 통합 gate |
| REQ-031 | PW-031 | TST-031A, TST-031B | 서지 검색 adapter |
| REQ-032 | PW-032 | TST-032A, TST-032B | 서지 정규화·출판본 관계 |
| REQ-033 | PW-033 | TST-033A, TST-033B | AI 문헌 후보 선정 |
| REQ-034 | PW-034 | TST-034A, TST-034B | 원문 권리·안전한 업로드 |
| REQ-035 | PW-035 | TST-035A, TST-035B | PDF parsing·highlight locator |
| REQ-036 | PW-036 | TST-036A, TST-036B | Figure/Table/Fact 출처 연결 |
| REQ-037 | PW-037 | TST-037A, TST-037B | 필요한 근거만 retrieval |
| REQ-038 | PW-038 | TST-038A, TST-038B | 문헌 이식성·읽기 연동 gate |
| REQ-039 | PW-039 | TST-039A, TST-039B | Story 대안·주장 범위 AI |
| REQ-040 | PW-040 | TST-040A, TST-040B | Detailed outline·영향 추적 |
| REQ-041 | PW-041 | TST-041A, TST-041B | WritingProfile 생성·승인 |
| REQ-042 | PW-042 | TST-042A, TST-042B | ParagraphContract·Writer |
| REQ-043 | PW-043 | TST-043A, TST-043B | Deterministic scientific gate |
| REQ-044 | PW-044 | TST-044A, TST-044B | 문체·과학 검토와 human review |
| REQ-045 | PW-045 | TST-045A, TST-045B | 과학적 부정 fixture·rubric gate |
| REQ-046 | PW-046 | TST-046A, TST-046B | 개요→집필 연구자 workflow |
| REQ-047 | PW-047 | TST-047A, TST-047B | Checkpoint·영구기억 재수화 |
| REQ-048 | PW-048 | TST-048A, TST-048B | Context budget·compact 전환 |
| REQ-049 | PW-049 | TST-049A, TST-049B | Quota 대기·리셋 재검증 |
| REQ-050 | PW-050 | TST-050A, TST-050B | 비용 예약·budget guard |
| REQ-051 | PW-051 | TST-051A, TST-051B | Lease fencing·경합·outbox 복구 |
| REQ-052 | PW-052 | TST-052A, TST-052B | 오류 분류·bounded retry |
| REQ-053 | PW-053 | TST-053A, TST-053B | Crash·disk full·stale 재개 시험 |
| REQ-054 | PW-054 | TST-054A, TST-054B | Run 상태 UI·운영 reliability gate |
| REQ-055 | PW-055 | TST-055A, TST-055B | DOCX import와 손실 보고 |
| REQ-056 | PW-056 | TST-056A, TST-056B | DOCX·CSL export |
| REQ-057 | PW-057 | TST-057A, TST-057B | PDF·재현 source archive |
| REQ-058 | PW-058 | TST-058A, TST-058B | Reviewer·제출판 freeze |
| REQ-059 | PW-059 | TST-059A, TST-059B | Security release audit |
| REQ-060 | PW-060 | TST-060A, TST-060B | Backup·restore·migration drill |
| REQ-061 | PW-061 | TST-061A, TST-061B | 배포·storage·upgrade runbook |
| REQ-062 | PW-062 | TST-062A, TST-062B | v1 최종 pilot·추적성 gate |

## Acceptance criteria

### REQ-001 — 환경·저장소·운영 경계 확인
전용 저장소, data root, OS 사용자, 설치 버전, 디스크/메모리/원본 경로를 비파괴적으로 조사한다.
- REQ-001-A / TST-001A: 승인된 경로·미정 경로·기존 세션 보호 경계가 preflight 보고서에 구분된다.
- REQ-001-B / TST-001B: 경로/권한/용량을 확인할 수 없으면 안전한 기본값으로 추정해 운영 파일을 생성하지 않고 blocked를 기록한다.

### REQ-002 — Provider 인증·배포 admission
Claude/Codex 인증모드와 local/private/hosted 이용범위를 공식 문서와 실제 환경으로 분리 검증한다.
- REQ-002-A / TST-002A: 각 provider/auth/deployment에 permitted/unknown/disabled 및 출처·확인일·테스트 상태가 있다.
- REQ-002-B / TST-002B: 기존 OAuth 파일 복사나 구독 사용을 가정한 private endpoint 접근은 거절되고 비용승인 전 모델 호출은 0회다.

### REQ-003 — 문서 선택·포맷 왕복 spike
인용·한글·emoji·그리스문자·수식·표가 있는 소형 문서에서 shared editor 위치와 DOCX export 손실을 검증한다.
- REQ-003-A / TST-003A: 선택 전후 텍스트와 citation atom이 보존되고 export preview와 손실 보고서가 있다.
- REQ-003-B / TST-003B: 같은 문장 두 곳/조합문자/atom 경계에서 위치가 모호하면 자동 치환하지 않고 불가 사례를 남긴다.

### REQ-004 — 실행 세션·권한 격리 spike
별도 identity/state/cwd로 합성 요청을 실행하고 기존 작업폴더 sentinel과 세션을 보호한다.
- REQ-004-A / TST-004A: 전용 native session ID를 얻고 명시 resume·interrupt가 확인되며 원본 sentinel hash가 유지된다.
- REQ-004-B / TST-004B: 암묵 continue, symlink로 원본 접근, inherited HOME/config 접근, sandbox 밖 shell surface가 차단된다.

### REQ-005 — 집필 품질 baseline fixture
합성 사실·개요·좋은/나쁜 문단과 권리 확인된 향후 평가자료 수집 절차를 준비한다.
- REQ-005-A / TST-005A: 수치·부정어·인용·장문·보고서식 서술의 기대 결과가 포함된 평가 fixture와 rubric이 있다.
- REQ-005-B / TST-005B: 본문을 읽지 않은 reference에 fulltext_style_verified 상태를 주거나 실제 없는 결과를 gold로 등록하지 않는다.

### REQ-006 — P00 검토·ADR·버전 고정안
앞선 위험검증을 바탕으로 기능 축소·대체 경로와 기술 선택을 확정 제안한다.
- REQ-006-A / TST-006A: compatibility matrix, proposed ADR, library license/version pin 후보, go/no-go와 사용자 승인 항목이 작성된다.
- REQ-006-B / TST-006B: 미검증 provider나 export 지원을 검증됨으로 보고하거나 승인 없이 전체 scaffold 구현을 시작하지 않는다.

### REQ-007 — Monorepo와 검증 명령 scaffold
apps/packages/test 경계와 타입·lint·단위·통합·E2E·pack-check 명령을 실제로 등록한다.
- REQ-007-A / TST-007A: clean install에서 정해진 명령이 실행되고 MockProvider만 사용한다.
- REQ-007-B / TST-007B: secret이 없다는 이유로 기본 테스트가 유료 provider를 호출하거나 전체 suite를 skip하지 않는다.

### REQ-008 — Owner 인증과 PaperProject
단일 소유자, 로그인 세션, 논문 프로젝트 CRUD/아카이브 및 scope authorization을 구현한다.
- REQ-008-A / TST-008A: 논문 A/B를 독립 생성하고 owner의 요청만 읽기·수정 가능하다.
- REQ-008-B / TST-008B: 다른 owner/project ID로 API/SSE/blob/search 요청 시 데이터가 반환되지 않는다.

### REQ-009 — 불변 revision·snapshot 저장
문서/개요/서지/asset revision과 named PaperSnapshot의 참조 구조를 구현한다.
- REQ-009-A / TST-009A: 복원이 새 revision을 만들며 과거 snapshot이 당시 참조를 재현한다.
- REQ-009-B / TST-009B: 승인 revision 덮어쓰기나 다른 paper 엔터티 참조를 DB/API가 거절한다.

### REQ-010 — 수동 Story·Outline 승인
AI 없이 research brief/story/문단계획을 편집하고 exact revision 승인·이력을 구현한다.
- REQ-010-A / TST-010A: 사용자가 지정한 revision만 승인되고 관련 outline node가 생성 허용 상태가 된다.
- REQ-010-B / TST-010B: 미승인 개요의 AI draft 요청은 서버에서 차단되지만 수동 메모/원고 입력은 가능하다.

### REQ-011 — Claim·Fact·Evidence 최소 모델
검증된 연구 사실과 추출 후보·해석·가설을 구분하고 원문 locator를 저장한다.
- REQ-011-A / TST-011A: 사실에 값·단위·그룹·출처·검증 주체가 연결된다.
- REQ-011-B / TST-011B: AI 또는 import가 verification/approval 주체를 위조하거나 p와 q를 동일 통계로 병합하지 못한다.

### REQ-012 — Shared editor schema·계약
citation/figure/math/문단 ID와 typed selection/proposal schema를 browser/server 공용으로 구현한다.
- REQ-012-A / TST-012A: 동일 fixture가 양쪽 schema와 position engine에서 같은 결과를 낸다.
- REQ-012-B / TST-012B: unknown node, raw HTML, duplicate block ID 또는 schema-version 불일치는 거절·명시 migration 경로로 간다.

### REQ-013 — DB job·outbox·audit 기반
durable job intent와 발행 outbox, state/event audit를 트랜잭션으로 저장한다.
- REQ-013-A / TST-013A: DB commit 후 재시작해도 논리 job이 queue로 전달되고 동일 intent는 중복 등록되지 않는다.
- REQ-013-B / TST-013B: publish 중 장애·중복 message에도 job 유실·중복 정본 변경이 발생하지 않는다.

### REQ-014 — 수동 논문 수직경로 검증
Paper→개요 승인→사실 등록→문단 수동 입력→snapshot→새로고침을 연결한다.
- REQ-014-A / TST-014A: 브라우저 재접속 후 원고·승인·근거·snapshot이 재현된다.
- REQ-014-B / TST-014B: DB 실패 시 저장됨을 표시하지 않고 미저장 상태를 유지한다.

### REQ-015 — 에디터·자동저장·IME
rich text 편집, 저장 ack, 로컬 복구 정책, IME 안정성을 구현한다.
- REQ-015-A / TST-015A: 한글 조합·italic·sub/superscript·인용 입력을 저장/복구한다.
- REQ-015-B / TST-015B: 조합 중 AI patch를 적용하거나 실패한 저장을 성공으로 표시하지 않는다.

### REQ-016 — Selection toolbar·Short Chat
선택 유지·작업 범위 표시·키보드 조작 가능한 짧은 AI 명령 UI를 만든다.
- REQ-016-A / TST-016A: 문장 선택 후 팝업에 한국어 지시를 입력해도 원래 선택 handle이 유지된다.
- REQ-016-B / TST-016B: 포커스 이동으로 범위가 바뀌거나 선택 없음에 전체 원고를 암묵 대상으로 삼지 않는다.

### REQ-017 — Proposal·CAS·원자 적용
replacement proposal, server 검증, diff, expected revision, idempotent apply를 구현한다.
- REQ-017-A / TST-017A: 사용자 apply 한 번으로 해당 범위만 새 revision에 반영된다.
- REQ-017-B / TST-017B: stale/중복 apply/숫자 보호 위반/늦은 응답은 무음 덮어쓰기 없이 거절 또는 기존 결과 반환된다.

### REQ-018 — Highlight·Comment anchor
선택 코멘트·스레드·resolve/reopen·orphaned anchor를 구현한다.
- REQ-018-A / TST-018A: 문단 이동/작은 편집 뒤 코멘트가 확실한 위치에 유지된다.
- REQ-018-B / TST-018B: 선택 문장이 삭제되거나 동일 후보가 여럿이면 코멘트를 엉뚱한 문장에 자동 부착하지 않는다.

### REQ-019 — Citation·Figure crossref node
인용과 그림/표 참조를 stable ID 객체로 삽입·렌더한다.
- REQ-019-A / TST-019A: 그림 순서나 인용 스타일 변경 후 번호가 일관되게 재계산된다.
- REQ-019-B / TST-019B: LLM 생성 bibliography 텍스트나 존재하지 않는 reference ID가 확정 citation으로 저장되지 않는다.

### REQ-020 — Mock AI·스트리밍 UI
deterministic mock으로 질문/수정 intent와 SSE 이벤트·job 상태를 연결한다.
- REQ-020-A / TST-020A: 답변 스트림·proposal 준비·적용 전 상태가 웹에서 구분된다.
- REQ-020-B / TST-020B: 브라우저 연결 종료를 job 취소로 처리하거나 mock을 실제 provider 응답으로 표시하지 않는다.

### REQ-021 — Version compare·Undo·기본 import
원고 비교·새 revision 복원·텍스트/Markdown 기본 가져오기를 구현한다.
- REQ-021-A / TST-021A: 적용된 AI 수정의 undo와 과거 version 비교가 새로고침 뒤에도 동작한다.
- REQ-021-B / TST-021B: restore가 audit/과거 revision을 삭제하거나 import가 현재 원고를 예고 없이 덮지 않는다.

### REQ-022 — 선택편집 브라우저 gate
실제 selection→short chat→diff→apply→undo와 다중 탭·해상도 회귀를 검사한다.
- REQ-022-A / TST-022A: 1366×768/1920×1080에서 핵심 workflow와 키보드 조작이 통과한다.
- REQ-022-B / TST-022B: 복제 문장·emoji·citation atom·멀티탭 충돌에서 잘못된 위치 변경이 1건도 승인되지 않는다.

### REQ-023 — Provider registry·이벤트 정규화
공통 adapter contract와 capability registry, raw event와 domain event 변환을 구현한다.
- REQ-023-A / TST-023A: provider/version/auth별 verified/unsupported/unknown capability가 표시된다.
- REQ-023-B / TST-023B: 지원되지 않는 compact/quota 필드를 있는 것으로 가정하지 않는다.

### REQ-024 — Claude Agent adapter
허용된 인증의 SDK로 structured turn·tools·explicit session/resume·stream을 연결한다.
- REQ-024-A / TST-024A: 승인된 합성 live smoke에서 native ID 저장·재개·범위 제한 response가 확인된다.
- REQ-024-B / TST-024B: 인증/예산 없으면 disabled/blocked이며 사용자 기존 Claude 세션이나 config를 재사용하지 않는다.

### REQ-025 — Codex App Server adapter
버전 고정 stdio JSON-RPC와 thread/turn/resume/interrupt/events를 구현한다.
- REQ-025-A / TST-025A: initialize→thread→turn 흐름과 normalized event가 contract에 맞는다.
- REQ-025-B / TST-025B: raw server 외부 공개, unknown RPC forwarding, sandbox 밖 shellCommand 노출은 차단된다.

### REQ-026 — Isolated runner·입출력 mount
전용 OS identity/state/cwd·리소스 한도·read-only evidence와 environment whitelist를 구현한다.
- REQ-026-A / TST-026A: run 파일은 자기 sandbox에만 생기고 원본 sentinel/기존 session state는 불변이다.
- REQ-026-B / TST-026B: symlink/path traversal/host HOME/Docker socket/원본 쓰기 경로에 접근할 수 없다.

### REQ-027 — Typed tool gateway·scope
run token에 결합한 paper scope와 읽기/제안 도구 allowlist를 구현한다.
- REQ-027-A / TST-027A: 허용된 개요·문단·증거 조회와 proposal만 생성한다.
- REQ-027-B / TST-027B: 모델이 paper_id/approved_by/tool 이름을 바꿔 다른 논문·정본 적용·승인을 획득하지 못한다.

### REQ-028 — Interrupt·취소·재연결
사용자 stop, provider interrupt, 좁은 process termination, late event와 SSE replay를 구현한다.
- REQ-028-A / TST-028A: 취소가 지속 저장되고 재연결 화면은 DB의 최종 run 상태와 일치한다.
- REQ-028-B / TST-028B: 취소 후 늦은 response가 문서를 변경하거나 broad pkill로 타 세션이 종료되지 않는다.

### REQ-029 — Usage·quota 관측 기본
토큰·추정 비용·계정 quota·관측 시각·unknown을 정규화한다.
- REQ-029-A / TST-029A: 누적/turn/context metrics가 서로 구분돼 UI와 ledger에 저장된다.
- REQ-029-B / TST-029B: 같은 cumulative event 재전달을 중복 합산하거나 null reset을 임의 시각으로 채우지 않는다.

### REQ-030 — 실제 provider 통합 gate
승인된 provider에서 개요 기반 1문단·부분 수정·중단·재개를 종단 검증한다.
- REQ-030-A / TST-030A: 실제 실행한 provider와 미실행 adapter를 구분한 보고서가 있다.
- REQ-030-B / TST-030B: 계정/약관/비용 미승인 상태를 테스트 통과 또는 v1 전체연동 완료로 기록하지 않는다.

### REQ-031 — 서지 검색 adapter
Crossref와 승인된 생명과학 검색 adapter를 bounded/cached 요청으로 연결한다.
- REQ-031-A / TST-031A: 실제 검색식·출처·관측일·metadata가 candidate에 연결된다.
- REQ-031-B / TST-031B: API key/한도/endpoint가 바뀌면 fabricated 결과 대신 source unavailable을 반환한다.

### REQ-032 — 서지 정규화·출판본 관계
DOI/PMID/무식별 논문과 preprint/publication/correction metadata를 versioned 구조로 정리한다.
- REQ-032-A / TST-032A: 중복 후보는 확인 가능한 identifier로 정리되고 출판본 관계가 보존된다.
- REQ-032-B / TST-032B: 제목 유사성만으로 다른 연구를 병합하거나 metadata 변경으로 과거 인용 snapshot을 바꾸지 않는다.

### REQ-033 — AI 문헌 후보 선정
주제/논문유형/문체적합성/읽은 범위로 후보와 선정 이유를 정리한다.
- REQ-033-A / TST-033A: scientific/writing/both 용도와 적합성·제외 사유가 사용자에게 보인다.
- REQ-033-B / TST-033B: 높은 인용수만으로 writing quality를 확정하거나 후보 발견만으로 승인 profile을 변경하지 않는다.

### REQ-034 — 원문 권리·안전한 업로드
PDF 원본 불변 저장, media/size/license/external-send 권한, 안전 다운로드를 구현한다.
- REQ-034-A / TST-034A: 파일 hash·source·license/unknown·전송 허용 상태가 함께 저장된다.
- REQ-034-B / TST-034B: 유료벽 우회·무제한 crawling·SSRF·악성 파일·무승인 외부 LLM 전송은 차단된다.

### REQ-035 — PDF parsing·highlight locator
PDF.js viewer와 추출·페이지 좌표·읽기 깊이·품질 상태를 연결한다.
- REQ-035-A / TST-035A: 확인한 문장의 페이지/quadpoint/quote/source hash를 다시 열 수 있다.
- REQ-035-B / TST-035B: 추출 실패/회전/새 PDF revision에서 근거 위치를 추측해 확정하지 않는다.

### REQ-036 — Figure/Table/Fact 출처 연결
panel/cell·caption·asset version과 fact 검증·본문 impact를 연결한다.
- REQ-036-A / TST-036A: 원고 claim에서 해당 figure/table/source 값을 추적할 수 있다.
- REQ-036-B / TST-036B: 새 그림/단위/그룹 변경이 연결 문단의 검토필요 표시 없이 조용히 반영되지 않는다.

### REQ-037 — 필요한 근거만 retrieval
project-scoped lexical retrieval과 명시 context selection·cache invalidation을 구현한다.
- REQ-037-A / TST-037A: 선택 paragraph와 관련된 source excerpt/locator만 context에 포함된다.
- REQ-037-B / TST-037B: 다른 프로젝트·삭제한 자료·전송불가 원문·오래된 approved state가 cache에서 유출되지 않는다.

### REQ-038 — 문헌 이식성·읽기 연동 gate
CSL-JSON/RIS/BibTeX 가져오기와 선택적 Zotero read-only adapter를 검증한다.
- REQ-038-A / TST-038A: 지원 포맷을 가져와 안정된 reference ID/출처 metadata로 인용할 수 있다.
- REQ-038-B / TST-038B: 외부 Zotero library를 자동 수정하거나 양방향 sync가 없는 것을 있는 것처럼 표시하지 않는다.

### REQ-039 — Story 대안·주장 범위 AI
자료 기반 story 대안·경쟁 설명·근거 부족을 웹에서 검토한다.
- REQ-039-A / TST-039A: 후보별 main message·증거·한계가 보이고 사용자가 채택한다.
- REQ-039-B / TST-039B: AI가 주장을 확정하거나 원래 데이터에 맞지 않는 결과를 story에 추가하지 않는다.

### REQ-040 — Detailed outline·영향 추적
문단별 목적·증거·제외사항·전환과 outline 변경 영향 graph를 구현한다.
- REQ-040-A / TST-040A: 승인된 node에서 필요한 범위만 새 생성되고 변경된 source의 영향을 추적한다.
- REQ-040-B / TST-040B: 새 draft outline을 승인본 대신 사용하거나 관련 없는 문법수정까지 전면 잠그지 않는다.

### REQ-041 — WritingProfile 생성·승인
실제 읽은 섹션·사용자 선호·저널 정책 snapshot에서 versioned profile을 제안한다.
- REQ-041-A / TST-041A: profile은 근거 reference/섹션/규칙/반례와 승인 상태를 가진다.
- REQ-041-B / TST-041B: abstract-only로 Discussion style을 만들거나 특정 문구를 대량 복사해 profile로 저장하지 않는다.

### REQ-042 — ParagraphContract·Writer
승인 story/outline와 exact facts에서 부분 생성·보수적 교정·재작성 mode를 구현한다.
- REQ-042-A / TST-042A: 생성 결과가 지정 scope/목적/근거/용어를 사용하며 proposal로만 반환된다.
- REQ-042-B / TST-042B: missing evidence를 지어내거나 한 문단 요청을 전체 원고 작성으로 확장하지 않는다.

### REQ-043 — Deterministic scientific gate
수치/단위/대조군/인용/보호 span/허용 claim의 일치 검증과 unknown 처리를 구현한다.
- REQ-043-A / TST-043A: 정확히 매칭된 fact와 citation은 근거 locator를 포함한 check 결과를 가진다.
- REQ-043-B / TST-043B: p↔q·단위·negation·group 변경/존재하지 않는 citation을 통과시키거나 모호한 매칭을 verified로 표시하지 않는다.

### REQ-044 — 문체·과학 검토와 human review
AI reviewer findings·간결함/장르 rubric·의미 검토와 bounded repair를 구현한다.
- REQ-044-A / TST-044A: 구체 span·이유·근거·대안으로 findings를 제시하고 사용자가 최종 채택한다.
- REQ-044-B / TST-044B: 단어 blacklist나 model 자체 점수로 품질을 보장하거나 repair loop가 무한 실행되지 않는다.

### REQ-045 — 과학적 부정 fixture·rubric gate
합성 hard fixture와 권리 확인된 수동 blind 평가를 분리 운영한다.
- REQ-045-A / TST-045A: 최소 hard-case suite와 human rubric의 결과·미실행·회귀를 기록한다.
- REQ-045-B / TST-045B: AI 탐지 회피 점수/자기평가만으로 release quality 통과를 선언하지 않는다.

### REQ-046 — 개요→집필 연구자 workflow
생물학·Software/Resource 유형에서 문헌/개요/paragraph/수정까지 검증한다.
- REQ-046-A / TST-046A: 서로 다른 article type의 outline과 섹션 역할이 원고에 반영된다.
- REQ-046-B / TST-046B: 모든 유형을 고정 IMRaD나 보고서 목록으로 강제하거나 사용자 승인 없이 novelty를 바꾸지 않는다.

### REQ-047 — Checkpoint·영구기억 재수화
LLM 호출 없이 current IDs/hashes/진행·권한·근거를 저장하고 새 세션을 구성한다.
- REQ-047-A / TST-047A: 새 provider session에서 승인된 story/outline/facts와 미완료 step을 복원한다.
- REQ-047-B / TST-047B: AI summary가 승인/사실/작업완료를 바꾸거나 quota 소진 뒤 추가 요약 호출을 필수로 요구하지 않는다.

### REQ-048 — Context budget·compact 전환
request별 token 예산·출력/도구 여유와 안전 boundary compaction/hydration을 구현한다.
- REQ-048-A / TST-048A: 지원 provider는 compact 완료 확인 후, 미지원은 새 세션 후 같은 작업을 잇는다.
- REQ-048-B / TST-048B: 누적 과금 token을 context 점유율로 쓰거나 실행중 tool/compact 미완료를 무시하고 다음 turn을 시작하지 않는다.

### REQ-049 — Quota 대기·리셋 재검증
known/unknown reset와 여러 bucket·스케줄 wake-up·auto-resume policy를 구현한다.
- REQ-049-A / TST-049A: 공급자 시각 이후 실제 사용 가능성을 재확인하고 승인 범위의 미완료 작업을 재개한다.
- REQ-049-B / TST-049B: 다른 bucket이 남았거나 unknown reset·취소·승인 만료 상태에서 무조건 실행하지 않는다.

### REQ-050 — 비용 예약·budget guard
project/run/provider 예산 예약·usage 정산·상한·repair/search 한도를 구현한다.
- REQ-050-A / TST-050A: 승인 예산 내 작업만 admitted되며 per-turn/누적 usage가 중복 없이 정산된다.
- REQ-050-B / TST-050B: 한도 소진 시 무단 API 전환·추가 결제·reset credit 소비·무한 재시도를 하지 않는다.

### REQ-051 — Lease fencing·경합·outbox 복구
한 writer·stale worker 차단·중복 queue 전송·inflight recovery를 구현한다.
- REQ-051-A / TST-051A: worker 재시작/경합에도 문서 commit은 한 번 발생하고 진행 상태가 reconcile된다.
- REQ-051-B / TST-051B: expired worker가 fence를 무시해 수정하거나 외부 모델 과금까지 exactly-once라고 보고하지 않는다.

### REQ-052 — 오류 분류·bounded retry
auth/network/quota/budget/schema/evidence/cancel 오류를 구분하고 재개 조건을 구현한다.
- REQ-052-A / TST-052A: 각 오류가 올바른 WAITING/FAILED 상태와 다음 행동을 표시한다.
- REQ-052-B / TST-052B: 401을 quota reset으로 처리하거나 계정 문제에서 무한 반복 모델 호출하지 않는다.

### REQ-053 — Crash·disk full·stale 재개 시험
강제 프로세스 중단·디스크 포화·응답 유실·문서 변경·승인 철회 상황을 주입한다.
- REQ-053-A / TST-053A: checkpoint에서 복구하며 중간 응답은 검증된 proposal 상태로만 보존된다.
- REQ-053-B / TST-053B: 복구 과정이 새 문서를 덮거나 저장 실패를 성공으로 표시하거나 취소 작업을 부활시키지 않는다.

### REQ-054 — Run 상태 UI·운영 reliability gate
사용량 출처·대기 이유·reset·stop/resume·checkpoint를 사용자 UI와 맞춘다.
- REQ-054-A / TST-054A: AI 대기 중에도 수동 원고 편집·자료 열람이 되고 상태가 DB와 일치한다.
- REQ-054-B / TST-054B: unknown 사용량을 0/정확한 백분율로 표시하거나 자동재개를 자동원고승인으로 취급하지 않는다.

### REQ-055 — DOCX import와 손실 보고
Word 원본 보존, unresolved changes 처리, 수식·표·comments의 손실 preview를 구현한다.
- REQ-055-A / TST-055A: 사용자가 변환 손실을 확인하고 새 문서/새 revision으로 가져온다.
- REQ-055-B / TST-055B: track changes/인용 field가 소실돼도 원본을 삭제하거나 완전 round-trip 지원이라고 표시하지 않는다.

### REQ-056 — DOCX·CSL export
고정 renderer에서 style·caption·crossref·bibliography·기본 표/수식 출력과 검사한다.
- REQ-056-A / TST-056A: golden fixture의 의미/인용/표/글자 formatting이 내보낸 문서에서 확인된다.
- REQ-056-B / TST-056B: LLM이 인용번호를 만들거나 누락된 reference를 채운 뒤 정상 export로 표시하지 않는다.

### REQ-057 — PDF·재현 source archive
읽기용 PDF와 JSON/CSL/assets/hash/version manifest bundle을 생성한다.
- REQ-057-A / TST-057A: archive만으로 해당 논문 snapshot 참조와 출력물을 검증할 수 있다.
- REQ-057-B / TST-057B: 권한 없는 원문을 외부 공유 bundle에 자동 포함하거나 manifest에 없는 blob을 누락시켜 성공 표시하지 않는다.

### REQ-058 — Reviewer·제출판 freeze
review comment→edit→response trace와 제출 snapshot/일관성 검사를 구현한다.
- REQ-058-A / TST-058A: response의 수정완료 주장이 실제 revision·locator와 연결되고 제출판이 불변이다.
- REQ-058-B / TST-058B: 미수정 내용을 수정완료로 답하거나 critical issue가 남은 원고를 submission-ready로 표시하지 않는다.

### REQ-059 — Security release audit
cross-project·injection·egress·credential·file parser·auth·dependency license를 독립 점검한다.
- REQ-059-A / TST-059A: 최소권한/secret redaction/명시 외부전송 정책에 대한 부정 테스트와 보고서가 있다.
- REQ-059-B / TST-059B: critical leak/IDOR/host 접근이 남았거나 테스트 미실행을 은폐하면 release gate를 거절한다.

### REQ-060 — Backup·restore·migration drill
DB+immutable blobs+manifest를 새 환경에 실제 복원하고 migration 호환성을 확인한다.
- REQ-060-A / TST-060A: 원고·개요·근거·comment·reference·figure·snapshot이 함께 복원된다.
- REQ-060-B / TST-060B: DB만 되거나 blob checksum/참조가 깨진 백업을 성공으로 보고하지 않는다.

### REQ-061 — 배포·storage·upgrade runbook
data root/리소스 제한/health/AI pause/버전 고정/로그 retention/업그레이드 절차를 구현한다.
- REQ-061-A / TST-061A: 깨끗한 전용 환경에서 private deployment·상태조회·안전중단이 가능하다.
- REQ-061-B / TST-061B: root overlay 무제한 저장·공개 agent port·운영/테스트 DB 혼용·latest 무검증 업데이트를 허용하지 않는다.

### REQ-062 — v1 최종 pilot·추적성 gate
전체 요구사항 evidence, 두 provider 상태, 과학 품질, export, security, restore와 사용자 pilot을 검토한다.
- REQ-062-A / TST-062A: 필수 capability의 pass/blocked/not_run과 사용자 승인 범위가 일치하는 release report가 있다.
- REQ-062-B / TST-062B: mock·문서 완성·미실행 live test를 제품 완성으로 포장하거나 남은 blocker를 제거 없이 완료 처리하지 않는다.
