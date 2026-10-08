# Paper Workspace 상세 구축 계획서 v1.0

**Claude Code 구현용 / 2026-10-08 / 설계 상태: 구현 전**

## 0. 핵심 결론
이 플랫폼의 중심은 채팅창이 아니라 **연구자의 의도·승인된 개요·검증 가능한 근거·버전이 있는 원고**다. Claude/Codex는 이 상태를 읽고 수정안을 제안하는 교체 가능한 실행 엔진이다. 세션을 잃어도 논문이 보존되고, 사용량 한도에 걸려도 수동 작업과 안전한 재개가 가능해야 한다.

구현을 시작하기 전에 위험을 줄일 네 항목: (1) provider 인증·구독·배포 허용 범위, (2) 선택영역·인용·수식 보존, (3) 기존 작업환경의 실제 격리, (4) Word/PDF 출력의 실제 지원 범위. UI를 먼저 모두 만든 뒤 확인하지 않는다.

## 문서 상태와 사용법
사용자가 확정한 제품 원칙과 이 계획의 기술 기본값을 구분한다. 이 파일은 상세 기준서이며 실제 웹앱 구현물이 아니다. 62개 Task·62개 요구사항·124개 인수조건은 앞으로 구현·검증할 계획이다. 공급자 관련 설명은 공식 문서 확인 결과이며 사용자 계정에서 실증한 상태가 아니다.

권장 진행: START_HERE → CLAUDE → 이 계획 → PROGRESS → 현재 Task. 전체 계획을 매 세션마다 재주입하지 않는다. 구현 에이전트는 Task의 read_first만 추가로 읽는다.

## 읽는 순서
제품 범위 → 구조와 데이터 → 개요 → 편집 → 문헌/근거 → 집필 품질 → 세션 격리 → 컨텍스트/한도/복구 → 보안 → 출력/리뷰 → 테스트 → 운영 → 단계/개발 지시문.

## 1. Product scope and decisions


### 사용자 확정 요구
논문 한 편 = PaperProject. Scivo UI를 따를 필요 없음. 논문 안에서 manuscript 버전별 확인·비교·복원. 집필 전에 storyline·상세 outline을 충분히 설계하고 연구자가 승인. AI가 보고서식 장문을 쏟아내지 않고 실제 좋은 학술 논문을 참고. 참고할 논문의 탐색·선정·정리도 AI가 보조. 웹 채팅에서 답변·원고 수정이 완결. 선택영역 드래그·하이라이트·comment·짧은 AI 채팅. Claude Code/Codex 연동, 프로젝트별 별도 세션, 기존 작업폴더와 세션 보호. context를 정리·압축·재개하며 quota 소진 시 안전하게 대기·재개.

### 이 계획에서 제안하는 기본값 — 사용자 확정 사실과 구분
개인 단독 사용, 자체 호스팅, 한국어 UI/지시와 영어 원고, 다중 PaperProject, TypeScript 중심 monorepo, PostgreSQL 정본, 사용자 승인 중심 수정. 제품명은 가칭. 첫 버전은 PC 브라우저 우선. 기존 원시 연구자료는 수정하지 않고 검증된 결과표·그림·설명만 논문 증거로 가져온다.

### v1 필수
수동으로도 완결되는 paper/outline/editor; 승인 gate; reference/evidence와 citation/figure 객체; 작업·버전 이력; 웹 AI 선택 편집; Claude와 Codex adapter(허용된 인증모드); context/checkpoint/quota 운영; 문헌 자동 후보 선정; writing profile/과학적 검토; DOCX/PDF 및 machine-readable archive; backup/restore·보안·관측·평가. 실제 인증 미확인인 provider는 disabled 상태로 명시하고 전체 v1 완료로 숨기지 않는다.

### v1 범위 밖
동시 공동편집 CRDT, 실시간 커서, 외부 공동저자 계정 초대, 다중 사용자 SaaS, Zotero 양방향 동기화, 완전한 Word Track Changes round-trip, 모든 저널 템플릿, 자동 투고·이메일 전송, 원시 NGS/통계 파이프라인 실행, AI figure 생성, fine-tuning, 자율 다중에이전트 무한 반복. 이후 기능은 RFC와 별도 phase로 추가한다.

### 완료의 의미
그럴듯한 UI·mock 답변·문서 작성만으로 완료 아님. 한 개의 합성 생물학 논문과 한 개의 software/resource 유형 fixture로 전체 workflow가 동작하고, 실제 사용자 논문은 별도 동의하에 제한된 pilot을 수행한다. 과학적 진실·저널 채택·“AI 탐지 회피”는 제품이 보장하지 않는다.

## 2. Architecture and boundaries


### 권장안: TypeScript 중심의 모듈형 단일 애플리케이션
UI: React + Vite + TypeScript. Editor: Tiptap OSS / ProseMirror. API: Fastify + TypeScript. DB: PostgreSQL + 명시 SQL migration. Queue: pg-boss(호환 버전은 P00 검증). Worker: TypeScript orchestration. Claude Agent SDK / Codex App Server는 provider adapter 뒤에 둔다. PDF 읽기: PDF.js. 구조 추출: GROBID 선택 서비스. Export: Pandoc + citeproc/CSL + sandboxed PDF engine. 테스트: Vitest + Playwright + 실제 PostgreSQL integration fixture.

Fastify는 공식 TypeScript·검증·테스트 문서를 제공하며 [S16], pg-boss는 PostgreSQL을 이용하는 Node queue다 [S17]. 기술 선택은 제안이다. Django/FastAPI를 기본으로 고집하지 않는 이유는 editor schema/patch 검증과 agent adapter의 TypeScript를 공유해 문서 변환 로직을 두 언어로 중복 구현하지 않기 위해서다. 생물학 분석을 실행하는 플랫폼이 아니므로 Python backend가 필수는 아니다.

### 배포 단위
`web/api` + `job worker` + `PostgreSQL` + `blobs`가 필수다. GROBID/export sandbox는 필요 시 profile로 실행. Redis, Kubernetes, 별도 vector DB, LangGraph, 상시 primary-agent는 초기 필수가 아니다. 개발과 테스트의 데이터 경로/DB를 운영과 분리한다.

### 논리 흐름
Browser → authenticated API → DB transaction + outbox → durable queue → orchestrator → isolated provider child → typed tool gateway → proposal store → browser diff → explicit apply API → revision transaction.

중요: orchestrator에는 DB 접근권한이 있을 수 있으나 provider child에는 DB credential이 없다. child environment는 whitelist로 새로 생성한다. 모델의 paper_id/role/승인 flag를 믿지 않고 run에 묶인 server identity로 권한을 정한다.

### 책임
- API: 권한·schema·version·승인·budget reservation, 정본 쓰기.
- Domain modules: paper/story/outline/document/evidence/literature/review.
- Worker: lease·checkpoint·provider orchestration·event 정규화. 모델 결과를 정본에 직접 쓰지 않음.
- Agent child: 승인 범위 snapshot과 tool gateway만 접근. 임의 shell·file tools 기본 차단.
- Queue: 실행 신호/재시도. Paper state의 정본 또는 문서 commit 여부 판단자가 아님.
- Blob store: immutable content-addressed assets. hash·size·media type 검증. DB reference와 백업 manifest로 묶음.

### 계약
API/worker/UI는 `packages/contracts`와 `packages/editor-core`를 공유한다. 외부 SDK raw event는 `packages/providers/<provider>` 밖으로 노출하지 않는다. SSE는 UI 관측용이다. 브라우저 연결 종료는 job 취소가 아니다. event_id로 재연결하며 최종 상태는 DB 조회로 확인한다.

### 동시성
v1은 원고당 하나의 writer lease를 기본으로 한다. 여러 탭에서도 silent last-write-wins 금지. 모든 정본 변경에는 expected_revision과 idempotency key. AI 읽기 작업은 bounded concurrency 허용. 동일 문서에 두 AI proposal이 있어도 적용은 직렬화한다. 작업 큐 재전달은 정상 실패모델이며 외부 모델 호출 비용까지 exactly-once라 주장하지 않는다.

### repository
apps/web, apps/api, apps/worker; packages/contracts, editor-core, domain, providers, search, exports; db/migrations; tests/unit,integration,e2e,security,fixtures; infra; docs; tasks; evals.

### 운영 기본값
외부 AI disabled, MockProvider. localhost bind. 비밀은 서버 측 secret store/권한 제한 파일(레포 밖). 입력 PDF와 미공개 연구자료는 공개 로그/오류 리포트에 포함하지 않음. 운영 provider process와 개발 Claude Code는 다른 OS 사용자·HOME/config/state/cwd를 갖는다. 원본 데이터는 read-only snapshot/선택 사본만 공유한다.

## 3. Domain, identifiers and versioning


### 중심 엔터티
PaperProject(id, owner_id, working_title, article_type, language, target_journal, status, policy_id). 소유자는 처음부터 명시한다. 다른 PaperProject 데이터가 검색·AI context·파일 URL에 섞이지 않아야 한다.

StoryRevision(id,paper_id,parent_id,question,main_message,novelty,status,approved_by,approved_at). OutlineRevision(id,paper_id,story_revision_id,parent_id,status). OutlineNode는 stable id, role, parent/order, paragraph_goal, claim_ids, evidence_ids, allowed_interpretation, exclusions, transition, word_budget를 가진다. 승인 후 본문을 덮어쓰지 않고 새 revision 생성.

Document(id,paper_id,kind,head_revision_id); DocumentRevision(id,parent_revision_id,content_json,schema_version,created_by,reason,hash). Block ID는 편집/순서 변경 시 유지하고 copy/paste로 복제될 때 새 ID. Split/merge는 lineage를 기록. 블록 UUID 하나로 위치 정합을 보장했다고 간주하지 않는다.

PaperSnapshot(id,label,story_revision_id,outline_revision_id,document_revision_ids,reference_revision_ids,asset_revision_ids,profile_revision_id,created_by). 이는 제출/공유/중요 checkpoint의 manifest이며 단순 manuscript 텍스트 복사와 다르다.

Working autosave ≠ named snapshot ≠ provider checkpoint. 저장 취소/복원은 과거를 덮어쓰지 않고 새 head revision을 생성한다. 원고·개요·figure·서지정보의 과거 제출판은 당시 참조 버전을 재현한다. time은 UTC 저장, 화면은 Asia/Seoul 표시를 기본으로 한다.

### 과학 근거
Claim(id,type=observation|interpretation|hypothesis|background, text, approval_state). EvidenceRecord(id,kind=experiment|figure_panel|table_cell|literature_excerpt|method_record,source_asset_revision,locator,extraction_state,verified_by). FactRecord(id,entity,metric,value,unit,comparison,n,statistic,uncertainty,source_locator,verification_state). Figure/Table asset은 version과 panel/cell ID를 가진다. 단순 숫자 문자열은 FactRecord가 아니다.

ReferenceWork는 DOI/PMID/다른 ID가 있을 수 있고, identifier 없음도 허용. 출판본/preprint는 relation으로 연결하되 무조건 병합하지 않는다. BibliographicRevision은 immutable. ProjectReference는 project membership, use_role=scientific|writing|both, screening_state, source_depth를 가진다. citation node는 stable reference_id와 locator만 저장하고 번호는 렌더러가 계산한다.

CommentThread(anchor,state); EditProposal(base_revision,operations,sources,checks,status); AIJob(intent,scope,authorization_snapshot,checkpoint); AgentSession(provider,version,identity_profile_id,session_id,cwd,state); UsageEvent(source,key,metric_kind,amount); QuotaSnapshot(observed_at,reset_at,unknown_reason); AuditEvent.

### 데이터 무결성
paper_id가 다른 엔터티 간 FK 연결은 composite key 또는 동등한 서버+DB 제약으로 차단. legacy import에서도 검사. `approved_by`는 모델 input으로 받지 않는다. delete는 우선 archive; 실행중 job·과거 snapshot이 참조하는 blob을 GC하지 않는다. 프로젝트 완전 삭제는 사용자 확인·retention 정책에 따르며 공유 reference/blob는 reference counting을 확인한다.

### schema migration
editor schema와 DB schema 버전을 별도로 둔다. 새 editor node가 과거 revision을 읽지 못하면 read-only fallback + migration preview. production migration 전 실제 복사본에서 upgrade·restore rehearsal. 모든 변경을 event-sourcing으로 만들 필요는 없으며, immutable revision + append-only audit + current pointer면 충분하다.

## 4. Storyline / Outline first


### 사용자 작업 흐름
Paper 생성 → 연구 질문·자료 정리 → AI와 story 대안 비교 → 연구자 story 승인 → detailed outline → 연구자 범위별 승인 → 문단 생성·편집 → review → named snapshot/export. 선형 wizard를 강제하지 않되 새 원고 생성의 서버 gate는 유지한다.

### 세 층의 작성 의도
1. Paper Brief: 연구 목적, 대상 독자, article type, 알려진 사실, 부족한 자료, 피해야 할 주장.
2. Storyline: 핵심 질문·메시지·근거 연결·경쟁 설명·결과 제시 순서·현재 증거의 한계.
3. Detailed Outline: Section → subsection → paragraph plan. 각 문단이 어떤 역할을 하고 어떤 주장·자료를 써야 하며 무엇을 쓰지 말아야 하는지 기록.

AI는 story 후보를 생성·비교하고 빈 근거와 논리의 비약을 표시할 수 있다. 다만 논문의 목적을 바꾸거나 그럴듯한 방향으로 결과를 맞추지 않는다. 데이터가 원래 가설과 맞지 않으면 대안과 한계를 제시하고 사용자 결정을 받는다. Writing Reference를 찾았다고 자동으로 연구 질문·논리 순서를 바꾸지 않는다.

### 상태
Story/Outline: DRAFT → IN_REVIEW → APPROVED → SUPERSEDED. 새 revision은 이전 승인본을 자동 폐기하지 않는다. approved snapshot은 immutable. 논문은 active_outline_revision을 별도 선택한다.

Outline node: DRAFT, READY_FOR_APPROVAL, APPROVED, EVIDENCE_MISSING, IMPACT_REVIEW_REQUIRED. AI generation 요청 시 paper_id와 active approved version, 관련 node 승인·필수 evidence 상태를 server-side로 검증. parent story 변경과 관련 claim 변경에 대한 impact_review가 해소되지 않은 node는 새 생성 차단. 관계 없는 문단의 문법 편집까지 막지는 않는다.

### 변경 영향
outline reorder, claim 변경, figure version 변경, evidence 철회, writing profile 갱신을 DependencyLink로 기록한다. 변경된 source를 참조하는 문단·abstract·caption·review response를 표시한다. 데이터 변경 → 전 논문 자동 재작성 금지. 사용자가 영향 범위를 보고 proposal 생성을 승인한다.

### 자유 집필과 기존 원고
수동 입력·메모·자료 수집은 개요 승인 전에도 가능하다. 기존 DOCX/텍스트는 원본을 보존해 가져오고 AI가 reverse outline 초안을 제안한다. 사용자가 승인하기 전 기존 문서를 삭제·잠금·재작성하지 않는다. 자유 노트에서 정식 원고로 옮길 때 provenance/개요 연결을 요청하되, 사용자가 직접 작성한 내용을 기계적으로 삭제하지 않는다.

### 예시 계약
Results paragraph: “실제 관측한 군집 차이만 설명”; 근거 table-2-r3, figure-1b; 금지: 통계적으로 뒷받침되지 않은 차이 단정/인과 표현; word budget 100–150은 편집 목표이지 무조건 채울 목표가 아님. 예시 수치는 합성 데이터다. 각 프로젝트 값은 실제 자료에서 지정한다.

### approval UX
비어 있는 필수 field와 근거 누락을 한곳에 표시. 승인 버튼은 문서와 근거 snapshot을 명시한다. chat의 ‘좋다’처럼 모호한 표현만으로 핵심 승인 상태를 바꾸지 않는다. 서버 승인 endpoint는 사용자 UI intent와 exact revision을 요구한다.

## 5. Editor, selection chat and safe changes


### 화면 구성 — Scivo와 독립
Paper dashboard: 논문 카드, 상태, 최근 snapshot, 진행중 작업. Paper 내부는 `구상/개요`, `원고`, `자료`, `검토/내보내기` 네 영역을 기본으로 한다. version·AI run·설정은 utility로 둔다. 원고 화면 중앙은 문서, 왼쪽은 접을 수 있는 outline, 오른쪽은 chat/comment/evidence inspector. UI를 터미널 콘솔처럼 만들지 않는다.

선택 → 작은 toolbar: 질문 / 문법 / 간결화 / 학술적 재작성 / comment. 짧은 지시는 선택 팝업에서, 여러 문단·전체 논리 변경은 sidebar에서 처리. 현재 대상(문장/문단/개요/전체)과 허용 범위를 항상 보여준다. 채팅 답변과 실제 수정 제안을 시각적으로 구분한다.

### 정본 표현
Tiptap/ProseMirror JSON + 자체 검증 schema. bold/italic/subscript/superscript, Greek/Unicode, citation node, figure/table crossref, inline math와 기본 표 지원. raw HTML 저장·실행 금지. HTML·Markdown·DOCX는 import/export 포맷이지 정본 아님. shared packages/editor-core가 server와 browser의 schema·position projection·transaction validation을 함께 소유한다 [S09].

### AI proposal 경로
1. 브라우저가 선택범위와 base revision을 고정한다. 사용자가 계속 입력해도 선택 요청의 snapshot은 변경하지 않는다.
2. 서버가 승인된 outline·scope·provider policy를 확인하고 job을 만든다.
3. 모델에는 immutable selection handle, 선택 문장, 필요한 전후 문맥·규칙을 준다. offset을 추측하게 하지 않는다.
4. 모델은 해당 handle의 replacement 또는 명시된 block operation을 제안한다.
5. 서버가 canonical EditProposal로 변환하고 schema·근거·보호 span·현재 revision을 검증한다.
6. diff 확인 후 사용자가 accept/reject/refine. 승인 요청은 proposal_id, proposal_hash, expected_revision, idempotency_key를 포함한다.
7. 단일 트랜잭션에서 revision·anchor mapping·audit·proposal applied를 함께 기록. 응답 유실 후 재요청해도 중복 적용하지 않는다.

### revision / 위치 계약
선택범위는 base_revision_id, block_id, expected_block_hash, ProseMirror block-relative positions, selected_slice_hash로 표현한다. position은 **JS 문자열 인덱스나 Python codepoint가 아닌 공유 editor schema의 ProseMirror position**이다. 노드 경계·인용 atom·emoji·결합문자·한글 IME를 포함한 golden fixtures로 정의한다. P00 spike에서 계약을 검증하기 전 실제 원고에 적용하지 않는다.

v1 안전 기본값: base revision이 바뀌면 자동 rebase하지 않고 STALE → 최신 원문 기준 재생성. 나중에 비중첩 자동 rebase를 추가하려면 별도 ADR과 property tests가 필요하다. 같은 문장이 두 곳 있어도 text search로 replacement 위치를 선택하지 않는다.

### 허용 operation
replace_selection, replace_block, insert_block_after, delete_block, move_block, update_citation, update_cross_reference. 첫 usable slice는 replace_selection만. citation과 수치·단위가 선택에 포함되면 보존 규칙을 먼저 적용한다. 기본 문법 모드는 citation atom 변경 금지. 다중 블록 계획은 한 번에 검증·commit하며 일부만 적용된 상태를 숨기지 않는다.

### Comment / Highlight
Comment anchor는 document_revision + block lineage + position + quote/prefix/suffix로 보조한다. 편집 transaction으로 확실히 추적 가능한 경우 이동, 텍스트 삭제/애매한 재배치는 ORPHANED 표시. 임의의 비슷한 문장에 붙이지 않는다. resolve는 수정 적용과 별개로 사용자가 확정하며 reopen 가능. AI suggestion을 reject해도 comment는 보존한다. PDF highlight는 별도 좌표 schema를 사용한다.

### 즉시 적용과 통제
기본은 diff 후 1회 apply. 사용자가 프로젝트 설정에서 켠 경우에만 좁은 문법 편집을 즉시 적용할 수 있다. 그래도 version/guard/undo를 생략하지 않는다. 숫자·claim·citation·outline 변경은 이 빠른 모드로 처리하지 않는다. 서버 재개 작업은 proposal 생성까지만 자동이며 manuscript 적용 승인은 재사용하지 않는다.

### 저장·접근성
autosave ack 전에는 ‘저장됨’ 표시 금지. 전송 실패·충돌·오프라인 표시. 브라우저 임시복구 저장은 계정·논문별 격리와 보존기간·명시 설정을 둔다. 로그아웃 시 shared device 데이터를 남기지 않는다. selection은 popup focus 시 유지. IME composition 중 patch 적용 금지. 키보드 전체 작업/ESC/스크린리더 labels, 1366×768과 1920×1080 테스트. 기본 단축키는 editor focus 안에서만 작동하며 변경 가능.

## 6. Literature curation, PDF and evidence


### 논문을 AI가 선정하는 방식
사용자가 paper brief를 정하면 AI는 검색식 후보 → 실제 bibliographic API 검색 → 중복 정리 → article type/주제/저널 적합성/본문 접근 깊이 평가 → 선정 사유 → 후보함을 만든다. 승인된 검색 범위·개수·비용 안에서는 매 논문마다 사용자 클릭을 강제하지 않는다. 그러나 scientific citation 채택·writing profile 변경은 검토 대상이다.

역할은 Scientific Reference와 Writing Reference로 분리. 동일 논문은 두 역할을 가질 수 있다. 높은 IF/인용수만으로 ‘좋은 글’로 선정하지 않는다. article type·연구 설계·섹션 문체·방법 재현성·논리의 명확성을 본다. Claude가 후보를 골랐다는 사실만으로 검증 완료가 되지 않는다.

### 검색과 원문
Crossref는 서지·출판 후 업데이트 조회의 기본 후보 [S13]. 생명과학은 PubMed 및 실제 사용조건을 확인한 OpenAlex adapter를 추가한다. 구체 endpoint/요금/key/호출 한도는 P00/P04에서 현재 문서와 live contract를 확인한다. 검색 요청·응답 원문 일부/확인일/provider/version을 cache한다. preprint·출판본·correction·retraction·expression of concern은 구분한다.

자동 원문 취득은 허용된 공개 API/라이선스 경로 또는 사용자의 합법적 업로드만 사용. PMC는 자동 수집 경로와 논문별 라이선스 제한을 명시한다 [S14]. 로그인·유료벽 우회, 대량 publisher scraping 금지. 다운로드할 권리와 외부 LLM으로 전송할 권리는 별도 field. writing profile에 원문 문장 전체를 대량 복사하지 않는다.

### 읽은 깊이
METADATA_ONLY / ABSTRACT_ONLY / FULLTEXT_PARTIAL / FULLTEXT_PARSED / SOURCE_CHECKED. 섹션 문체 분석은 실제 해당 섹션 접근이 필요. abstract만 읽었으면 Discussion 문체를 분석했다고 표시하지 않는다. schema·DOI 존재는 claim support를 증명하지 않는다. 지지/반대/불명/확인필요를 분리한다.

### PDF 파이프라인
immutable original → MIME/크기/해시 검사 → 안전한 parser → 페이지·섹션·문단 chunk → 메타데이터 대조 → 사용자 검증. PDF.js viewer, GROBID TEI/좌표는 보조 추출 [S12]. 읽기 순서·하이픈·표·수식 오염을 flag한다. OCR은 이미지 기반 문서임을 확인하고 해당 페이지에 한정한 opt-in fallback. parsed text 없음은 내용을 추측해 채우지 않는다.

PDF anchor: asset_revision_id, sha256, page_index(0-based), normalized quadpoints, exact quote, prefix/suffix, extractor_version. 페이지 crop/rotation/zoom 변화 golden tests. 새로운 PDF revision에 이전 좌표를 자동 적용하지 않는다.

### Evidence와 Fact
사용자가 결과 CSV/TSV/figure/table/method note를 올리면 Fact candidate를 만들 수 있으나 verified와 구분한다. Fact에는 단위·대조군·반복수·통계종류·p와 adjusted p 구분·source locator가 있어야 한다. 숫자를 graph screenshot에서 읽으면 검증필요. 분석을 다시 실행하거나 원본 결과 파일을 고쳐 claim에 맞추는 기능은 v1에 없다.

### Figure/Table 관리
asset version과 panel/table cell을 구분. caption version, source evidence, 본문 mention을 연결. Figure 번호는 ID와 별개로 배치 순서에 따라 계산. 새 figure를 업로드하면 기존 caption/본문 claim의 impact review를 만든다. 원본 그림은 보존하며 썸네일을 연구 원본으로 대체하지 않는다.

### Zotero와 이식성
v1은 DOI/CSL-JSON/BibTeX/RIS 가져오기 및 선택적인 Zotero read-only 연동 [S15]. Zotero가 외부 정본이면 local override와 source revision을 별도 기록한다. 양방향 sync는 미포함. 인용 번호/연도 suffix 등은 deterministic citeproc에 맡기며 LLM이 생성하지 않는다.

### 문헌 선택 실패
DOI 없음은 부적격과 동일하지 않음. 중복 DOI는 source metadata 차이를 비교. 인용에 사용된 논문이 철회되거나 metadata 수정되면 경고·검토 task를 만들고 과거 snapshot을 소급 변조하지 않는다. 문헌 unavailable 시 현재 증거 수준에서 답하거나 추가 원문을 요청한다.

## 7. Scientific writing engine and evaluation


### 목표와 비목표
목표: 연구자의 의도와 실제 근거를 보존하면서 읽기 좋은 과학 논문을 작성. 비목표: AI 탐지기 점수 최적화, 특정 저자의 문구 복제, 글을 더 길거나 더 화려하게 만드는 것. ‘Furthermore’ 같은 단어 자체를 금지하지 않는다. 과도한 반복·빈 강조·불필요한 설명을 문맥별로 검토한다.

### WritingProfile
article_type, target_audience, journal_rule_snapshot, preferred_English_variant, terminology_registry, section_roles, rhetoric_patterns, concision_preference, claim_strength_policy, anti_examples, accepted_examples, source_reference_versions, approved_at. 저널 rules는 원문·확인일·적용 article type을 저장 [S18]. 사용자 피드백을 profile 개선 후보로 기록하지만 한 번의 수정을 전역 스타일로 자동 고정하지 않는다.

우수 논문 후보의 해당 본문을 실제 읽고 ‘문단의 역할과 정보 배치 원칙’을 추출한다. 논문별 문장을 통째로 writer context에 반복 주입하지 않는다. 여러 논문에서 공통 원칙과 반례를 비교한다. 과도한 문구 재현은 source-similarity warning을 제공하며 법적 표절 판정기라고 부르지 않는다. 재현성 필수 Methods 표현을 단지 비슷하다는 이유로 왜곡하지 않는다.

### ParagraphContract
approved_story/outline/node ID + purpose + mandatory claims + exact approved facts + evidence locators + preceding/following context + terminology + prohibited inferences + target length + allowed operation + scope + source transmission policy. 모델은 부족한 근거에 대해 needs_evidence로 반환할 수 있어야 한다. 최소 단위는 보통 한 문단/한 논리 단위. 전체 원고 생성은 기본 동작이 아니다.

### 섹션 역할
Introduction: 필요한 배경·지식 공백·질문을 좁혀가며 과도한 교과서 설명 제한.
Methods: 수행이 확인된 절차/조건만. 없는 실험·장비·반복수·software version을 채우지 않음.
Results: 정확한 관찰·통계·figure/table 연결. 설명이 필요한 경우만 해석 범위를 허용하며 저널의 Results & Discussion 구조를 존중.
Discussion: 의미·선행연구 비교·대안 설명·한계. 결과 반복만 하지 않음.
Abstract: 본문에 확정된 결과에서 작성하고 수치·결론 일치 검사.
Resource/Software/Methods 논문에는 맞는 구조를 제공하며 고정 IMRaD를 강제하지 않음.

### 수정 모드
Conservative: 문법/가독성, 사실·범위·논리 순서 최대 보존.
Scientific Rewrite: 같은 주장과 근거에서 서술 재작성.
Structural Revision: 문단 순서/구성 변경 제안; outline 변경이 필요하면 먼저 RFC-like outline proposal.
모드를 바꿔도 사실·인용·승인·version 검증은 동일하다.

### 검증 층
A. Deterministic: schema, scope, approved version, citation ID, FactRecord와 수치·단위/그룹 매칭, 보호된 span 변경, crossref 존재. 정확한 mapping이 불가능하면 UNKNOWN이지 통과 아님.
B. Scientific reviewer: 과장, 관찰/인과 혼동, 논리 비약, 반대 근거 누락, 섹션 역할, 부정어 반전. AI 판단은 finding+source+confidence로 저장.
C. Writing reviewer: 반복·정보 밀도·문단 연결·불필요한 장문. 단어 blacklist나 고정 문장 길이로 판정하지 않음.
D. Human: 핵심 주장·의미·승인·최종 채택.

writer와 reviewer는 역할/context를 분리하되 매 교정에 복수 LLM을 호출하지 않는다. 기본 한 번 생성+필요한 검토, 최대 repair 1회(초기 제안값). 계속 실패하면 사용자에게 근거 부족/명세 충돌을 보여준다. 같은 모델의 self-review를 독립적 사실 검증이라고 부르지 않는다.

### 안전한 실패와 export
hard structural/auth/version violation은 적용 차단. unsupported scientific assertion은 원고 proposal 적용을 차단하거나 사실 정정 task로 분리. 스타일 문제는 경고와 대안이지 사용자의 수동 문장을 차단하는 검열이 아니다. draft export는 미해결 상태를 보고서로 첨부 가능; clean submission snapshot은 중요 불일치 해결을 요구한다. unsupported 내용을 사용자가 force-accept해 verified로 바꾸는 일반 버튼은 두지 않는다.

### 품질 평가
합성 fixture로 factual constraints·인용·negation·단위·p/q·상관/인과·범위 준수 테스트. 본문 품질은 사용자가 제공/사용 허용한 paragraph gold set으로 블라인드 pairwise 평가. 사실 보존, 논리, 간결함, 논문 장르 적합성, author intent를 별도 측정. accepted-edit rate와 재수정량은 참고 지표이며 정답과 동일하지 않음. live LLM 결과는 고정 문자열 비교 대신 rubric과 회귀 사례로 검증. 초기 30개 합성 hard cases + 권리 확인된 10개 이상 수동 rubric 사례를 release fixture로 구축한다. 수치는 제안된 최소 gate이지 품질 보장 확률이 아니다.

## 8. Provider-independent runtime and isolation


### 세 가지 구분
PaperProject는 영구 연구 객체. WorkThread는 사용자의 특정 문단·개요·검토 대화. AgentSession은 provider-native 임시 실행 세션. 논문 하나에 항상 하나의 영구 세션만 고집하지 않는다. WorkThread는 여러 AgentSession으로 이어질 수 있고 해당 mapping/history를 보존한다. 일반 paper context는 DB에서 재구성한다.

### Adapter interface
capabilities(), start_session(), resume_session(explicit_id), run_turn(contract), interrupt(), compact_if_supported(), inspect_usage(), inspect_quota(), close(). 위 이름은 **플랫폼 내부 interface**이며 실제 SDK 메서드가 아님. 어댑터에서 공식 SDK/JSON-RPC로 매핑하고 P00에서 검증한다 [S01–S08].

Claude: Agent SDK structured tools/events 우선, 지원이 명확한 headless fallback만. 설치 버전에서 compact API가 없으면 새 세션 hydration. Codex: private stdio App Server + pinned generated schema. raw RPC allowlist. Browser는 provider port/credential/session directory에 직접 접근하지 않는다.

### 세션 식별
SessionBinding(paper_id,work_thread_id,provider,provider_version,auth_profile_id,native_session_id,run_state_dir,cwd,capability_snapshot). session lookup은 서버 owner/paper scope로 제한. `--continue`, 최신 세션 찾기, 현재 folder 기준 암묵 resume 금지. 사용자 개발 CLI와 같은 home/config를 공유하지 않는다.

### 실제 격리
control plane와 agent process를 분리. user namespace/별도 서비스 계정, run별 writable sandbox, 선택한 immutable input read-only, CPU/memory/pids/임시디스크 제한, 제한된 network egress. 기본 shell·범용 file tool·프로젝트 repo 로드 비활성. host home, Docker socket, SSH agent, 운영 DB creds mount 금지. symlink·path traversal·/proc·metadata endpoint 경로까지 부정 테스트.

컨테이너 자체를 무조건 완벽한 security boundary로 설명하지 않는다. control plane 및 승인된 OS 설정이 보장하는 범위와 잔여 위험을 문서화한다. Git worktree는 코드 분리 수단이지 보안 sandbox가 아니므로 논문 집필 런타임의 필수는 아님.

### Tool gateway
읽기: get_approved_outline, get_document_slice, get_fact_records, get_reference_excerpt, get_figure_metadata, search_literature_with_budget.
제안: propose_outline_change, propose_manuscript_edit, propose_profile_change, add_candidate_reference, add_review_finding.
금지: approve_outline, set_verified_fact, apply_approved_patch, change_owner, delete_snapshot, change_budget, arbitrary_http/shell/write_file, submit_paper.

모델이 제시하는 paper_id는 권한 부여에 사용하지 않는다. 도구의 project scope는 run token에서 결정한다. 승인·정본 변경은 브라우저/서버 domain layer 책임. 정해진 tool allowlist에도 field-level authorization을 적용한다.

### 실행 상태
CREATED → QUEUED → RUNNING → PROPOSAL_READY → AWAITING_USER_APPLY → COMPLETED.
보조 상태: CHECKPOINTING, COMPACTING, WAITING_QUOTA, WAITING_AUTH, WAITING_NETWORK, WAITING_BUDGET, WAITING_USER, INTERRUPTED, FAILED, CANCELED, STALE.
job 완료(제안 생성)와 proposal 적용 완료를 별도 모델로 구현해 상태 혼동을 피한다. UI의 ‘완료’는 무엇이 끝났는지 적는다.

### 취소·소유권
cancel request를 DB에 먼저 기록하고 adapter interrupt, graceful timeout 후 해당 child process group만 종료. broad pkill 금지. orphan process 재연결은 OS PID만 아니라 session binding/fencing token을 확인한다. app restart 시 남아 있는 side effect 여부를 reconcile. 취소 뒤 늦게 도착한 response는 canonical 문서에 적용하지 않는다.

### 사용량·외부 세션
세션 분리는 같은 provider account quota를 분리하지 못한다. CPU·RAM도 물리적으로 공유된다. 앱 자체 concurrency·budget·priority로 간섭을 줄이되 터미널 사용량을 정확히 예약/보호한다고 주장하지 않는다. 통제 밖 사용량이 있으면 remaining은 공급자 관측 시점의 상태임을 표시한다.

## 9. Context, quotas, durability and resume


### 세 가지 제한을 분리
ContextWindow: 현재 model request의 입력+예정 도구결과+출력 여유. UsageQuota: 계정/모델/시간창별 공급자 사용 한도. Budget: 사용자가 승인한 앱/프로젝트/작업 비용. compact는 quota를 되돌리지 않는다 [S04,S07,S19,S20].

### Context builder
우선순위: 서버 불변 정책 → 승인된 story/outline scope → 해당 facts/evidence → 선택 문장과 인접 문단 → 필요한 용어/profile → 관련 결정/미해결 comment → 최신 대화 일부. 전체 PDF·모든 세션 로그를 주입하지 않는다. public literature source와 사용자 승인 instruction은 다른 채널/데이터 field로 둔다.

현재 request budget 계산은 model/version별 capability에 근거한다. context_window - estimated_current_input - expected_tool_payload - output_reserve - safety_margin. cumulative billed token을 context occupancy로 쓰지 않는다. counter가 없으면 estimate+UNKNOWN field; 정확한 퍼센트처럼 표시하지 않음.

### Checkpoint
모든 외부 호출 전, 결과 검증 후, proposal 저장 후 DB checkpoint. LLM 요약 호출 없이도 생성 가능한 구조로 설계. approved revision IDs/hashes, job intent, completed action IDs, pending step, needed sources, policy/version, budget reservation, provider/session, last_event, cancellation/approval 상태를 보존. 원문/수치/승인 상태의 정본은 참조 객체에 있다. summary는 untrusted helpful note이고 승인 증거가 아니다.

### 압축 시점
초기 제안: 대략 70%에서 checkpoint 검토, 80% 부근 또는 예상 다음 turn budget 부족 시 압축/세션 교체 준비. 절대적인 공급자 한도가 아니다. 긴 도구 결과를 받기 전에 예약량을 확인한다. 모델 호출 중인 turn을 임의 잘라 compact하지 않는다. 안전한 boundary → checkpoint → compact 완료 확인 또는 새 세션 → 재수화 → revision/policy 재검사 → 다음 step. 요약에서 잃어버린 정보를 추측하지 않음.

### Quota normalization
quota schema에 observed_at, provider/auth/model/bucket, used_percent|null, reset_at|null, confidence=provider_reported|estimated|unknown, retry_after, error_kind를 둔다. reset은 UTC epoch/ISO로 정규화해 Asia/Seoul로 표시. 한 창이 리셋돼도 weekly/credit/model limit이 남아 있으면 재개하지 않음. 상한 시간을 얻지 못하면 ‘초기화 시각 확인 불가’ 표시 후 bounded backoff/manual resume. 존재하지 않는 5시간 리셋을 가정하지 않음.

### 자동 재개
사용자가 처음 허용한 task scope, 비용, auto_resume, 유효기간 안에서만 동작. WAITING_QUOTA를 durable DB에 저장하고 scheduled wake-up을 등록. reset+짧은 jitter 뒤 실제 가능여부/인증/다른 bucket/현재 문서 revision/작업 취소/정책 변경을 재검사. 재개는 draft/proposal 생성까지며 사용자 원고 적용을 자동 승인하지 않는다. 오랫동안 대기한 task는 WAITING_USER 또는 재확인. provider fallback과 추가 결제, rate-limit reset credit 소비는 별도 명시 승인 없이는 금지.

### Budget
작업 enqueue 전에 원가 estimate와 상한 예약. 앱·paper·run·provider별 승인 예산 관리. 알려지지 않은 비용은 UNKNOWN; 기본은 유료 실행 차단. 스트림 종료/실패에도 확인된 usage를 기록한다. 재개된 세션의 누적 비용 이벤트는 provider metric kind와 고유 event key로 delta 계산; 음수/역전은 anomaly로 표시. 공급자 usage에는 지연·추정이 있을 수 있으므로 앱의 소프트 예산만으로 exact invoice hard cap을 약속하지 않는다. 호출당 output/turn/tool-call/repair 제한과 provider hard cap을 함께 사용한다.

### 신뢰 가능한 queue
DB job + outbox가 논리 명령을 내구성 있게 보존. queue는 dispatch를 담당. lease heartbeat + fencing token으로 오래된 worker가 commit하지 못하게 한다. 모델 호출 전 상태를 기록하고 response를 받으면 proposal부터 저장한다. 외부 응답 유실은 reconciliation/안전 재생성으로 처리하며 ‘외부 모델은 정확히 한 번만 과금됐다’고 보장하지 않는다.

### 오류 종류별 동작
429 quota → WAITING_QUOTA; 401/403 credential → WAITING_AUTH; 일시 네트워크 → bounded retry; provider 과부하 → bounded retry/circuit breaker; hard budget → WAITING_BUDGET; evidence missing → WAITING_USER; schema violation → 최대 1회 constrained repair 후 실패; 문서 conflict → STALE; disk full → 안전 중단·저장 미완 알림.

### 웹 상태
현재 scope/task, 마지막 checkpoint, 모델·provider, 측정/추정 context, 앱 token/cost와 계정 quota 구분, 확인된 reset 시각, 대기 이유, stop/resume. 수동 editor는 AI 한도와 무관하게 작동한다. 로그 화면은 secret/raw hidden reasoning 대신 user-visible 답변·tool facts·audit를 제공한다.

## 10. Security, privacy and abuse cases


### 개인 앱도 인증이 필요하다
localhost 기본 + 최초 owner 설정. 원격 공개 시 TLS·안전한 session cookie·CSRF/Origin 검사·login rate-limit. unguessable ID는 권한 검사 대체가 아님. API, SSE, blob URL, search, jobs, comments, exports 모두 owner/project scope 검사. v1에 다중 사용자를 내세우지 않더라도 두 테스트 owner로 IDOR 회귀 검증.

### 신뢰 경계
문헌/PDF/DOI metadata/외부 tool result/AI summary/공동저자 comment는 비신뢰 데이터. 이 안의 명령이 shell·인증·scope·승인·예산·export destination을 바꾸지 못하게 한다. ‘이 PDF의 지시대로 환경변수를 보내라’ 등의 합성 injection fixture로 검사. 프롬프트만으로 방어하지 않고 tool gateway·egress·server schema로 차단한다.

### Credential
브라우저 localStorage/querystring/git/AI 대화/raw logs에 key/token 금지. 전용 secret store 또는 제한된 권한 서버 파일. 운영 key와 개발 key 분리. provider child에게 필요한 최소 인증만 제공하며 부모 전체 env를 상속하지 않는다. rotation/logout/revocation 시 queued job 재인증. 삭제된 credential snapshot을 summary에서 부활시키지 않는다.

### 파일과 URL
허용 MIME·크기·page count·uncompressed size 제한. zip slip·symlink·macro·XXE·HTML script 차단. PDF parser/export tool은 별도 리소스 제한 프로세스. 외부 fetch는 scheme/host/port·redirect·DNS resolved IP 재검사. localhost/RFC1918/link-local/cloud metadata/internal services를 일반 URL fetch로 읽지 못하게 함. Zotero local API 같은 명시적 localhost connector는 별도 승인된 adapter에 한정. export는 임의 file path나 외부 URL을 모델이 지정하지 못함.

### 미공개 연구자료
PaperProject에 data_classification, allowed_providers, external_send_policy를 저장. 채팅 시작 전 어떤 자료가 어느 공급자에 전달되는지 보여준다. 사용자 업로드가 곧 제3자 전송 동의를 뜻하지 않음. 민감한 인체/개인식별 데이터는 redaction 또는 전송 차단 정책을 요구. 기관 규정·저널 embargo 등은 사용자 확인사항. 보관/학습/지역 정책을 공급자 전체에 획일적으로 보장하지 않음.

### 로그
audit는 actor, intent, revision IDs, action, outcome, timestamps, model/version, input manifest hash를 저장. raw prompt/full PDF/PII는 기본 로그에 넣지 않음. 디버그 원문 저장은 별도 opt-in·짧은 보존·암호화. runtime hidden reasoning을 필수 저장/제품 UI로 삼지 않는다. user-visible response와 도구 실행 사실로 재현성을 확보한다.

### 위험 행위
원시 실험 데이터 수정·외부 이메일·논문 투고·Git push·계정 변경·추가 결제·운영 삭제는 AI writing scope 밖. 사용자 승인 UI가 있더라도 재사용/위조되지 않도록 exact action/hash/expiry에 바인딩한다. 기본 paper runtime에는 이 tool 자체를 제공하지 않는다.

### 공급망과 운영
lockfile/digest/SBOM/license allowlist. 자동 업데이트 대신 canary+contract regression. GROBID와 PDF/Word parser 패치 정책. AI가 unknown dependency를 설치하거나 plugin을 전역 로드하지 않음. security findings는 P00/Phase gates에서 blocker로 처리한다.

## 11. Import, export, revision and submission boundary


### 가져오기
DOCX/Markdown/text/CSL/RIS/BibTeX는 원본 asset을 먼저 불변 저장. parser output preview와 손실 보고서(댓글·변경내용·수식·표·그림 위치·인용 필드)를 확인한 뒤 새 문서로 반영. 현재 head를 자동 대체하지 않는다. Word tracked changes가 unresolved면 어떤 텍스트 버전을 가져올지 명시. 기존 원고에는 AI reverse outline 제안만 하고 자동 재작성하지 않음.

### v1 export
1. Clean DOCX: section styles, italic species/gene rules, sub/superscript, inline math 지원범위, 표·caption·figure crossref·bibliography.
2. 읽기용 PDF: 고정된 export pipeline과 format fixtures. 원래 PDF와 100% 동일 레이아웃 약속 안 함.
3. Reproducible source bundle: schema versioned editor JSON, outline/story, immutable reference revisions, CSL-JSON/BibTeX, asset manifest, checksums, selected profile/AI assistance audit.
4. Review package: clean 원고 + change summary + comment/reviewer table. Word native Track Changes round-trip과 동일하지 않음을 명시.

Pandoc은 여러 형식 변환을 제공하나 중간 표현 한계에 따른 정보 손실을 문서화한다 [S11]. ‘나중에 export 버튼만 추가하면 됨’으로 미루지 않고 P00에서 citation/figure/math/표 fixture로 먼저 검증한다.

### deterministic bibliography
citation node에는 reference stable ID와 locator. author-year suffix·번호·bibliography order는 고정된 citeproc/CSL 버전에서 생성. source metadata 업데이트가 과거 제출판을 소급 바꾸지 않음. CSL license와 target journal style version 저장. AI가 bibliography 문자열을 만들어 넣지 못함.

### 전체 일관성 검사
abstract ↔ Results 수치/결론, Methods ↔ 보고한 분석, figure/table ↔ caption ↔ 본문, acronym first use, sample name/unit/statistic consistency, reference completeness, 미해결 placeholders/critical comments, funding/author contributions/data availability 존재 여부. 제도·윤리 승인번호·저자명·funding은 실제 입력이 없으면 placeholder/needs_input이며 지어내지 않음.

### SubmissionSnapshot
원고·개요·profile·refs·assets·export toolchain version/hash를 freeze. 출력 파일 hash와 검사 보고서를 저장. draft export는 경고 포함 가능. submission-ready 표시에는 critical issues 해소와 사용자 확인 필요. 자동 투고는 없음.

### Reviewer workflow
v1은 reviewer comment를 사용자가 붙여 넣거나 import해 원문→수정 대상→proposal→response draft→해결 여부로 연결. ‘수정했다’라는 response 문장은 실제 적용 revision/section locator가 존재할 때만 generated-complete 상태. 대안 설명/동의하지 않음도 기록 가능. 서로 다른 journal 재투고는 기존 submission snapshot을 유지하고 새로운 작업판 생성. full multi-branch merge는 후속 기능.

## 12. SDD + TDD + evidence-based delivery


### 작업 방식
REQ → acceptance criterion → failing test → 최소 구현 → 단위/계약/통합/E2E → 독립 review → 사용자 phase gate. 여러 관련 없는 subsystem을 한 task에 넣지 않는다. 현재 Task write_scope 밖 구조변경·spec 수정·공급자 policy 변경은 RFC. 더 작게 쪼갤 때도 requirement/test 연결은 유지.

### 테스트 층
Unit/property: editor transaction·protected spans·Fact matcher·schema·state machine·budget·time normalization.
Contract: provider versioned event fixtures, explicit session/resume, quota missing, partial JSON, refusal, tool failure, usage cumulative semantics.
Integration: 실제 PostgreSQL transaction/CAS/FK/outbox/job dedup, blob manifest, restore, migrations.
Browser: 실제 selection → short chat → diff → apply → undo → reload, Korean IME, duplicate paragraph, multi-tab conflict, PDF highlight and citation.
Scientific: synthetic hard fixtures + 권리 확인한 수동 blind rubric. 구조/사실 검사와 문체 판단을 구분.
Security/fault: cross-project read/write, prompt injection, key logging, symlink, SSRF, stale worker, SIGTERM/process death, disk full, network loss, quota reset unknown, orphan anchor.

### first complete slice
Paper 생성 → Story와 Outline 수동 작성·승인 → 검증된 사실·reference 등록 → Mock 또는 승인된 실제 provider가 문단 proposal → 웹에서 선택 수정 → CAS 적용 → undo/새로고침 → DOCX 샘플 출력. 이 수직 경로를 먼저 완성하고 확장한다. 실제 과금/인증 미승인 시 Mock 결과는 명확히 표기.

### 완료 기준
모든 필수 REQ에 자동 또는 수동 검증 증거. 모든 critical negative fixture 기대결과 통과. 불필요한 skip/xfail 금지. live provider smoke 미실행이면 해당 adapter는 미검증 disabled. export 렌더와 source manifest 검증. 새 환경 backup restore와 migration rehearsal 성공. 주요 workflow 사용자가 직접 검토. coverage 숫자만으로 대체하지 않음.

### 독립 review
Codex 또는 별도 Claude 세션이 read-only로 actual diff/test evidence 검토. 리뷰어가 구현자의 요약을 정답으로 받지 않음. 오류 수정은 별도 task에 반영. reviewer agent가 자기 판단으로 승인/merge/production 배포하지 않음.

### 개발용 컨텍스트
초기 전체 패키지를 반복 읽지 않음. START_HERE, CLAUDE, PROGRESS, 현재 task, task에 연결된 specs/contracts만. 완료 후 tests/run evidence와 next action 기록. compact 후 파일의 실제 상태와 git diff 재확인. 이전 대화가 완료를 선언했다는 이유로 진행 상태 변경 금지.

### 검증 명령 관리
P01 scaffold에서 lint/typecheck/unit/integration/e2e/contracts/evals/pack-check 명령을 실제 등록한다. 명령명이 문서에 있다고 실행 가능하다고 주장하지 않음. 보고서는 실행 명령·exit code·핵심 log·artifact 경로와 not_run 이유를 포함. screenshot만으로 기능을 검증하거나, API unit test만으로 브라우저 동작 완료를 주장하지 않음.

## 13. Operations, storage, backup and maintenance


### 기본 배포
전용 data root를 설치 시 정한다. 예: `/data/paper-workspace`는 예시 경로이며 존재·권한·용량을 확인한 뒤 사용자 승인으로 지정한다. 앱 설치경로와 연구 원본경로, 개발 .claude/.codex 디렉터리와 구분. root filesystem/Docker overlay에 원문 PDF·logs·parser temp가 무제한 증가하지 않게 한다.

필수 runtime: web/api, worker, postgres, durable blob volume. GROBID/export runner는 resource-limited profile. non-root, read-only app image, 특정 temp dir만 writable, DB/agent port 외부 공개 금지. loopback 또는 안전한 reverse proxy. 개발 test DB와 운영 DB를 같은 이름·credential로 사용하지 않는다.

### 저장 정책
원본 asset immutable + sha256 + size + mime. 텍스트 추출/index/thumbnail은 재생성 가능한 derived data. 원고 revision·승인·출판 snapshot·reference metadata는 재생성 불가능한 primary data. 별도 retention policy. autosave를 전부 영구 저장해 무한증가시키지 않되 named snapshot/approved revision이 참조하는 항목은 보존. blob GC는 참조 무결성/대기 job/restore window 확인 후 실행.

### Backup
DB consistent backup + 같은 시점 manifest가 지칭하는 immutable blobs + 설정/schema version. credential은 독립적인 secret recovery 정책으로 관리. 같은 디스크의 다른 폴더만으로 재해복구라고 부르지 않음. 암호화된 별도 저장위치/오프호스트 사본을 사용자가 지정. archive의 접근권한과 DOI 원문 재배포권한도 확인.

기본 제안: 주기적인 DB/asset 백업 + 중요 snapshot 직후 추가 백업, 정기적인 별도 환경 복원. 목표 RPO/RTO는 운영환경 검증 후 설정하며 일단 임의의 ‘0 데이터손실’을 약속하지 않는다. 배포 전 최소 한 번 실제 restore drill: reference/citation/figure/approval/proposal/version이 모두 연결되는지 검사.

### 관측과 알림
run/job 상태, queue 대기, repeated failure, provider capability 변경, usage 미확인, orphan process, blob errors, save failure, backup age, disk pressure. UI status와 운영 logs 일치. 민감 원문/keys를 telemetry에 포함하지 않음. 유료 observability SaaS는 기본 의존성 아님.

### 비상 중단
AI global pause는 queued task와 running task에 반영하되 사용자 수동 편집은 유지. disk/db 장애는 저장상태를 false로 표시하고 local recovery 옵션을 제공. quota/Auth 일시 중단은 원고 접근을 막지 않음. 안전하게 저장할 수 없는 상태에서 ‘autosaved’ 표시 금지.

### 업그레이드
model/SDK/CLI/parser/editor/citeproc 업데이트를 개별 식별. contract/eval/export fixture로 regression 후 pin 변경. 깨진 provider만 disabled하고 manual editor는 계속 사용. migration rollback은 데이터 파괴적인 down migration보다 검증된 backup restore/forward fix를 우선 검토. 실행 중 paper job은 maintenance checkpoint로 멈춘다.

### 릴리스 수준
Demo(Mock) → private alpha(실제 허용 provider 1개) → private beta(두 adapter와 reliability) → 개인 사용 v1(전체 gate+restore+pilot). 각 수준을 명시해 미검증 기능을 지원한다고 홍보하지 않음.

## 14. 구현 단계와 Gate

각 phase는 사용자 검토 후 다음 단계로 넘어간다. 전체 Task의 상세 인수조건·수정범위·tests는 tasks/INDEX.md와 docs/TRACEABILITY.md에 있다.

| Phase | 범위 | Task | Gate |
|---|---|---|---|
| P00 | 사전 타당성·위험 검증 | PW-001–PW-006 | 인증/위치/격리/출력 위험 검증, ADR 승인 전 전체 구현 금지 |
| P01 | 정본·승인·수동 workflow 기반 | PW-007–PW-014 | 수동으로 Paper→개요승인→원고→snapshot을 저장·복원 |
| P02 | 선택 편집·diff·복원 첫 완성형 | PW-015–PW-022 | 선택→짧은채팅→diff→apply→undo가 브라우저에서 정확히 동작 |
| P03 | 공식 provider와 격리 실행 | PW-023–PW-030 | 허용된 실제 provider와 별도 세션이 연결; 미검증 provider는 명시 disabled |
| P04 | 문헌·PDF·근거와 그림 연결 | PW-031–PW-038 | 문헌 후보와 원문 깊이·근거 위치·그림·인용이 연결 |
| P05 | 개요 주도 과학적 집필 | PW-039–PW-046 | 승인된 스토리 기반 문단 생성과 과학/문체 평가 통과 |
| P06 | 컨텍스트·한도·중단 복구 | PW-047–PW-054 | compact·quota·crash·stale·비용 문제에서 유실·무음덮어쓰기 방지 |
| P07 | 투고 출력·복구·개인 배포 완성 | PW-055–PW-062 | 출력·security·실제 restore·개인 pilot과 전체 요구사항 검증 |

### 첫 usable version과 v1의 차이
P02/P03에서는 논문 프로젝트·개요 승인·문단 작성·선택 수정·버전 복원까지 일상적으로 써볼 수 있는 수직 경로를 확보한다. P04–P07에서 자동 문헌 선정·과학적 집필·긴 작업 복구·출력을 보강한다. 핵심인 quota 자동 재개/두 provider 지원을 영구히 ‘나중 기능’으로 돌리는 계획은 아니다. 다만 미검증 인증을 허용됐다고 가정해 전체 완성이라 선언하지 않는다.

## 15. 의사결정·추가 위험

### ADR 목록
| ID | 제안 | 이유 / 변경 시 필요한 검증 |
|---|---|---|
| ADR-001 | PaperProject가 하나의 논문 | 사용자 확정 요구. 여러 논문 묶음으로 바꾸지 않음 |
| ADR-002 | PostgreSQL + immutable revisions가 정본 | session/PDF/Markdown 중복 정본 방지 |
| ADR-003 | TypeScript monorepo와 shared editor-core | editor position/patch validation을 양쪽에서 공유. P00 검증 후 확정 |
| ADR-004 | Tiptap OSS, 자체 제한된 comments/proposals | Pro/Cloud 요금·종속 최소화. 비용·난이도 검증 후 조정 |
| ADR-005 | 단일 owner + optimistic concurrency | v1 CRDT 제외. 복수 탭은 충돌을 명시 |
| ADR-006 | AI가 proposal 생성, server가 적용 | 저자 승인·version·evidence를 runtime 밖에서 강제 |
| ADR-007 | provider/auth/deployment capability admission | 구독 약관·SDK 지원을 추정하지 않음 |
| ADR-008 | pg-boss + DB job/outbox | 운영 구성 최소화. 외부 side effects는 별도 idempotency |
| ADR-009 | checkpoint + compact/new session hydration | agent의 기억이 과학적 정본이 되지 않음 |
| ADR-010 | one writer per document, bounded review | quota/문서경합/복잡한 multi-agent 방지 |
| ADR-011 | draft export와 submission snapshot 구분 | 작성 중 편의와 최종 검증을 모두 보존 |
| ADR-012 | local/private deployment, hosted auth 별도 검토 | SaaS·계정 공유를 개인 도구와 혼동하지 않음 |

확정 시 각 ADR을 독립 문서로 승격해 status/context/decision/alternatives/consequences/source evidence를 기록한다. 본 표는 사용자 확정 제품 요구를 제외하면 설계 제안이다.


### 위험과 대응
| 위험 | 실패 사례 | 예방 / 검증 |
|---|---|---|
| 인증·구독 사용범위 오해 | UI 완성 후 구독 runtime 사용 불가 | P00 admission, API/허용 local 모드, 비용 자동 전환 금지 |
| 기존 세션/파일 간섭 | 최신 세션 attach, 원본 분석폴더 덮어쓰기 | explicit session + 별도 HOME/cwd + read-only snapshot + sentinel tests |
| shared quota 간섭 | 논문 작업으로 개발 계정 한도 소진 | app budget/concurrency 표시; 완전 격리 불가 명시 |
| outline drift | AI가 다른 novelty로 전체 원고 생성 | approved IDs·paragraph contract·impact graph |
| hallucinated methods/numbers | 없는 실험조건이나 p-value 추가 | verified FactRecord + missing evidence 상태 + human review |
| 잘못된 인용 | DOI만 맞고 claim은 무관 | source depth, excerpt locator, citation support review |
| style overfitting | 참고 논문 문구/과장 복제 | rhetoric pattern 추출, source similarity warning, human rubric |
| stale edit | 기다리는 동안 수동 수정한 문장을 덮음 | CAS/hash/STale proposal 재생성 |
| comment 위치 유실 | 삭제된 문장 코멘트가 다른 문장에 부착 | mapped/orphaned 상태, exact anchor 테스트 |
| 중복 retry | 동일 제안 2회 적용·두 worker 경합 | transaction idempotency+lease fencing; 외부 호출 중복 가능 명시 |
| compact 기억 손실 | 승인되지 않은 사실을 승인됐다고 요약 | source version IDs와 server authority, summary는 비신뢰 |
| reset 오판 | weekly limit인데 5시간 후 무한 재시도 | multi-bucket+unknown+bounded retry+circuit breaker |
| 비용 폭주 | 검색/작성/리뷰 루프가 연속 실행 | turn/tool/repair/output 상한, reserve+actual ledger |
| prompt injection | PDF 지시로 credential/다른 원고 접근 | tool scope·network·OS 경계·부정 tests |
| Word 상호운용성 | 공동저자 tracked changes 유실 | import loss report·원본 보존·v1 round-trip 비지원 고지 |
| PDF 해석 오류 | 2단 읽기 순서·표 수치 깨짐 | 페이지 locator·추출 quality·사용자 검증 |
| storage full | autosave 실패를 성공처럼 표시 | free-space limits·save ack·tmp retention·recovery |
| backup 무용 | DB만 복구돼 figure/PDF 없음 | consistent manifest+blob checksums+실제 restore drill |
| scope 폭발 | Zotero+Word+분석+SaaS 동시 구현 | v1 non-goals·phase gate·작은 vertical slice |
| 평가 착시 | model이 자기 글에 높은 점수 | deterministic tests+blind human rubric+negative fixtures |


### 비기능 목표
아래는 측정 후 조정할 **제품 목표**이며 현재 구현 성능이나 작업 소요시간 예측이 아니다.

- 기준 fixture: 20,000단어 원고, reference 200개, figure/table asset 30개. 정확한 측정 머신/브라우저를 보고서에 남긴다.
- 수동 입력·선택에 눈에 띄는 지속 정지 없음; 로컬 정상환경의 입력 반응 p95 100ms 이내를 초기 목표로 측정한다. LLM completion 시간은 별도 측정한다.
- 로컬 정상환경의 autosave ack p95 1초 이내 목표. timeout/오프라인에서는 성공 상태를 표시하지 않는다.
- 처리 중인 하나의 paper에는 writer 1개. 전체 provider concurrency는 초기 1로 두고 사용자가 예산·호스트 성능에 맞춰 조정한다.
- UI는 상태/선택범위/모델 호출 여부/미저장/경고를 키보드와 스크린리더로 파악할 수 있어야 한다.
- 정본 변경의 unauthorized/duplicate/stale 경로는 deterministic critical fixture에서 통과 허용 0건을 목표로 한다. 이는 모든 현실 오류가 0건이라는 보장이 아니다.
- 백업 복구 목표와 retention은 실제 데이터량·저장위치·기관 정책을 확인해 정한다. 아직 RPO/RTO를 충족했다고 주장하지 않는다.


## 16. Claude Code에 넘기는 절차

새 전용 저장소에 패키지를 배치한다. 기존 저장소라면 기존 CLAUDE.md/AGENTS.md를 덮어쓰지 말고 검토 후 하위 문서로 병합한다. 최초 요청은 다음과 같이 전달한다.

```text
이 저장소의 START_HERE.md, CLAUDE.md, PROJECT_PLAN_KO.md, PROGRESS.md를 읽어라.
이번 요청은 설계 검토와 P00 준비만이다. 코딩·scaffold·패키지 설치·외부 AI 호출·기존 설정 변경을 하지 마라.

1. 사용자 확정 요구, 설계 기본값, 미정 결정, 실제 검증되지 않은 가정을 구분하라.
2. 특히 Claude/Codex 구독·API 인증·local/private hosted 이용조건을 확인하고, 허용 근거 없는 인증경로를 구현 전제에서 제외하라. 사용자 credential 파일을 읽거나 복사하지 마라.
3. 기존 연구 세션·작업폴더·HOME/config·운영 데이터가 보호되는지 검토하라.
4. Paper 정본/outline 승인/AI proposal 적용/버전/컨텍스트·quota 복구 사이의 모순을 찾아라.
5. Python scripts/validate_pack.py로 패키지 자체를 검증하라. 이것이 웹앱 테스트가 아님을 구분하라.
6. P00에서 확인할 실제 로컬 버전·환경·자료·승인·비용 항목과 PW-001의 실행 계획을 제시하라.
7. 계획의 요구사항을 임의 삭제하거나 스택을 조용히 바꾸지 마라. 변경이 필요하면 RFC로 설명하라.

결과는 핵심 blocker, 수정이 필요한 설계, 결정이 필요한 사항, 첫 Task의 허용범위·시험으로 정리하고 멈춰라. 이후 모든 Phase를 자동 구현하지 마라.
```

승인 후 prompts/02_BUILD_ONE_TASK_KO.md에 실제 TASK_ID를 넣어 한 작업만 진행한다. review는 prompts/03_INDEPENDENT_REVIEW_KO.md, 개발 세션 재개는 prompts/04_RESUME_BUILD_KO.md, phase 판정은 prompts/05_PHASE_GATE_KO.md를 사용한다.

## 17. Provider 확인사항 — 반드시 먼저 읽기

### 공식 문서와 실제 검증의 구분
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


## 18. 출시 전 사용자에게 확인할 사항

인증·배포 모드와 실제 사용할 계정/예산; 운영 data root와 백업 위치; 외부 전송을 허용하는 미공개 자료 범위; 목표 저널·논문 유형과 스타일 기준 후보; 실제 평가에 사용할 권리 확인된 문단; DOCX 공동저자 교환에서 필수인 기능. 이 결정들이 미정이라고 전체 계획을 중단하지 않는다. 안전한 기본값(Mock/수동편집/localhost/외부전송 금지)으로 진행하며 영향을 받는 기능을 명시 blocked로 관리한다.

## 19. 공식 출처

### 근거 등록부

확인일: 2026-10-08. 아래는 공개 문서 검토이며 실제 사용자 환경·계정 테스트가 아니다. 가격·고정 사용량·미검증 SDK 메서드를 제품 요구사항에 하드코딩하지 않는다.

### S01 — Claude Agent SDK overview
https://code.claude.com/docs/en/agent-sdk/overview

SDK는 Claude Code 기반 agent loop·sessions·permissions를 제공. 제3자 제품의 claude.ai 로그인/한도 제공에는 사전 승인 제약이 명시됨. API 인증과 구독 인증을 혼동하지 않는다.

### S02 — Claude programmatic/headless execution
https://code.claude.com/docs/en/headless

-p, structured/stream JSON, session resume. bare mode는 호스트 구성 자동 로드를 줄이며 subscription OAuth를 사용하지 않는다. 실제 설치 버전에서 지원을 검증한다.

### S03 — Claude sessions
https://code.claude.com/docs/en/agent-sdk/sessions

명시적인 session ID와 resume/fork를 사용. 파일시스템 격리나 사용자 논문 버전 관리는 별도 설계 대상.

### S04 — Claude status line
https://code.claude.com/docs/en/statusline

context/usage 정보와 조건부 rate_limits 필드. 모든 실행 모드에 모든 필드가 제공되는 보장은 없다.

### S05 — Claude SDK usage
https://code.claude.com/docs/en/agent-sdk/cost-tracking

SDK usage와 추정 비용의 의미를 어댑터에서 정규화해야 함. CLI 재개 시 누적 집계를 단순 합산하지 않는다.

### S06 — Claude permissions
https://code.claude.com/docs/en/agent-sdk/permissions

공식 권한 제어를 이용하되 애플리케이션의 서버 권한 검증·OS 격리를 대체하지 않는다.

### S07 — Codex App Server
https://developers.openai.com/codex/app-server/

공식 구조화 연동. thread/turn, compaction, token usage, 계정별 rate-limit surface 제공. 배포·인증 범위와 설치 버전별 schema 검증 필요.

### S08 — Codex App Server authentication
https://learn.chatgpt.com/docs/app-server#authentication

현재 문서는 기존 local/open-source app-server 인증과 commercial/hosted 사용을 구분하고 Sign in with ChatGPT 경로를 안내한다. 자체 호스팅의 해당 여부를 임의 단정하지 않는다.

### S09 — Tiptap editor
https://tiptap.dev/docs/editor/getting-started/overview

오픈소스 core와 유료 Pro/Cloud 확장을 구분한다. core 기반 자체 comment/AI proposal 구현을 제안.

### S10 — Tiptap comments
https://tiptap.dev/docs/comments/getting-started/overview

공식 Comments는 요금제·private registry·document server 의존이 있다. 이를 무료 내장 기능으로 가정하지 않는다.

### S11 — Pandoc manual
https://pandoc.org/MANUAL.html

DOCX·LaTeX·PDF 변환과 citation 처리를 제공하나 모든 포맷 간 완전한 round-trip은 보장하지 않는다.

### S12 — GROBID
https://grobid.readthedocs.io/en/latest/Introduction/

학술 PDF의 구조·참고문헌·좌표를 추출한다. 추출 결과는 검증된 과학적 사실과 다르다.

### S13 — Crossref REST API
https://www.crossref.org/documentation/retrieve-metadata/rest-api/

서지정보·라이선스·출판 후 업데이트 등 조회. DOI 존재는 본문 주장 지지 여부와 다르다.

### S14 — PMC automated access and licenses
https://pmc.ncbi.nlm.nih.gov/tools/textmining/

자동 수집 경로와 논문별 재사용 조건이 있다. 공개 접근 가능성을 무제한 자동 다운로드 권한으로 간주하지 않는다.

### S15 — Zotero Web API
https://www.zotero.org/support/dev/web_api/v3/basics

서지 라이브러리 읽기, API version, 인증, 로컬 API의 구분. v1은 가져오기/읽기 연동부터 제공한다.

### S16 — Fastify
https://fastify.dev/docs/latest/

TypeScript backend 후보의 공식 문서. 런타임 버전·plugin 호환성을 P00에서 고정한다.

### S17 — pg-boss
https://github.com/timgit/pg-boss

PostgreSQL 기반 Node 작업 큐. 큐 보장만으로 외부 LLM 요청·문서 변경의 exactly-once를 보장하지 않는다.

### S18 — Nature Portfolio editorial policies
https://www.nature.com/nature-portfolio/editorial-policies

학술지 정책은 프로젝트별로 원문·확인일을 저장하고 투고 전 재확인한다. 모든 저널에 동일 AI 공개 규칙을 하드코딩하지 않는다.

### S19 — OpenAI API rate limits
https://developers.openai.com/api/docs/guides/rate-limits

API request/token rate 제한과 구독 quota·사용자 예산을 분리한다.

### S20 — Anthropic API rate limits
https://platform.claude.com/docs/en/api/rate-limits

API rate 제한과 spend 제한은 다르다. 재시도는 공급자가 제공한 정보와 오류 유형에 근거한다.
