# 02. Domain, identifiers and versioning

## 중심 엔터티
PaperProject(id, owner_id, working_title, article_type, language, target_journal, status, policy_id). 소유자는 처음부터 명시한다. 다른 PaperProject 데이터가 검색·AI context·파일 URL에 섞이지 않아야 한다.

StoryRevision(id,paper_id,parent_id,question,main_message,novelty,status,approved_by,approved_at). OutlineRevision(id,paper_id,story_revision_id,parent_id,status). OutlineNode는 stable id, role, parent/order, paragraph_goal, claim_ids, evidence_ids, allowed_interpretation, exclusions, transition, word_budget를 가진다. 승인 후 본문을 덮어쓰지 않고 새 revision 생성.

Document(id,paper_id,kind,head_revision_id); DocumentRevision(id,parent_revision_id,content_json,schema_version,created_by,reason,hash). Block ID는 편집/순서 변경 시 유지하고 copy/paste로 복제될 때 새 ID. Split/merge는 lineage를 기록. 블록 UUID 하나로 위치 정합을 보장했다고 간주하지 않는다.

PaperSnapshot(id,label,story_revision_id,outline_revision_id,document_revision_ids,reference_revision_ids,asset_revision_ids,profile_revision_id,created_by). 이는 제출/공유/중요 checkpoint의 manifest이며 단순 manuscript 텍스트 복사와 다르다.

Working autosave ≠ named snapshot ≠ provider checkpoint. 저장 취소/복원은 과거를 덮어쓰지 않고 새 head revision을 생성한다. 원고·개요·figure·서지정보의 과거 제출판은 당시 참조 버전을 재현한다. time은 UTC 저장, 화면은 Asia/Seoul 표시를 기본으로 한다.

## 과학 근거
Claim(id,type=observation|interpretation|hypothesis|background, text, approval_state). EvidenceRecord(id,kind=experiment|figure_panel|table_cell|literature_excerpt|method_record,source_asset_revision,locator,extraction_state,verified_by). FactRecord(id,entity,metric,value,unit,comparison,n,statistic,uncertainty,source_locator,verification_state). Figure/Table asset은 version과 panel/cell ID를 가진다. 단순 숫자 문자열은 FactRecord가 아니다.

ReferenceWork는 DOI/PMID/다른 ID가 있을 수 있고, identifier 없음도 허용. 출판본/preprint는 relation으로 연결하되 무조건 병합하지 않는다. BibliographicRevision은 immutable. ProjectReference는 project membership, use_role=scientific|writing|both, screening_state, source_depth를 가진다. citation node는 stable reference_id와 locator만 저장하고 번호는 렌더러가 계산한다.

CommentThread(anchor,state); EditProposal(base_revision,operations,sources,checks,status); AIJob(intent,scope,authorization_snapshot,checkpoint); AgentSession(provider,version,identity_profile_id,session_id,cwd,state); UsageEvent(source,key,metric_kind,amount); QuotaSnapshot(observed_at,reset_at,unknown_reason); AuditEvent.

## 데이터 무결성
paper_id가 다른 엔터티 간 FK 연결은 composite key 또는 동등한 서버+DB 제약으로 차단. legacy import에서도 검사. `approved_by`는 모델 input으로 받지 않는다. delete는 우선 archive; 실행중 job·과거 snapshot이 참조하는 blob을 GC하지 않는다. 프로젝트 완전 삭제는 사용자 확인·retention 정책에 따르며 공유 reference/blob는 reference counting을 확인한다.

## schema migration
editor schema와 DB schema 버전을 별도로 둔다. 새 editor node가 과거 revision을 읽지 못하면 read-only fallback + migration preview. production migration 전 실제 복사본에서 upgrade·restore rehearsal. 모든 변경을 event-sourcing으로 만들 필요는 없으며, immutable revision + append-only audit + current pointer면 충분하다.
