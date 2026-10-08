# 10. Import, export, revision and submission boundary

## 가져오기
DOCX/Markdown/text/CSL/RIS/BibTeX는 원본 asset을 먼저 불변 저장. parser output preview와 손실 보고서(댓글·변경내용·수식·표·그림 위치·인용 필드)를 확인한 뒤 새 문서로 반영. 현재 head를 자동 대체하지 않는다. Word tracked changes가 unresolved면 어떤 텍스트 버전을 가져올지 명시. 기존 원고에는 AI reverse outline 제안만 하고 자동 재작성하지 않음.

## v1 export
1. Clean DOCX: section styles, italic species/gene rules, sub/superscript, inline math 지원범위, 표·caption·figure crossref·bibliography.
2. 읽기용 PDF: 고정된 export pipeline과 format fixtures. 원래 PDF와 100% 동일 레이아웃 약속 안 함.
3. Reproducible source bundle: schema versioned editor JSON, outline/story, immutable reference revisions, CSL-JSON/BibTeX, asset manifest, checksums, selected profile/AI assistance audit.
4. Review package: clean 원고 + change summary + comment/reviewer table. Word native Track Changes round-trip과 동일하지 않음을 명시.

Pandoc은 여러 형식 변환을 제공하나 중간 표현 한계에 따른 정보 손실을 문서화한다 [S11]. ‘나중에 export 버튼만 추가하면 됨’으로 미루지 않고 P00에서 citation/figure/math/표 fixture로 먼저 검증한다.

## deterministic bibliography
citation node에는 reference stable ID와 locator. author-year suffix·번호·bibliography order는 고정된 citeproc/CSL 버전에서 생성. source metadata 업데이트가 과거 제출판을 소급 바꾸지 않음. CSL license와 target journal style version 저장. AI가 bibliography 문자열을 만들어 넣지 못함.

## 전체 일관성 검사
abstract ↔ Results 수치/결론, Methods ↔ 보고한 분석, figure/table ↔ caption ↔ 본문, acronym first use, sample name/unit/statistic consistency, reference completeness, 미해결 placeholders/critical comments, funding/author contributions/data availability 존재 여부. 제도·윤리 승인번호·저자명·funding은 실제 입력이 없으면 placeholder/needs_input이며 지어내지 않음.

## SubmissionSnapshot
원고·개요·profile·refs·assets·export toolchain version/hash를 freeze. 출력 파일 hash와 검사 보고서를 저장. draft export는 경고 포함 가능. submission-ready 표시에는 critical issues 해소와 사용자 확인 필요. 자동 투고는 없음.

## Reviewer workflow
v1은 reviewer comment를 사용자가 붙여 넣거나 import해 원문→수정 대상→proposal→response draft→해결 여부로 연결. ‘수정했다’라는 response 문장은 실제 적용 revision/section locator가 존재할 때만 generated-complete 상태. 대안 설명/동의하지 않음도 기록 가능. 서로 다른 journal 재투고는 기존 submission snapshot을 유지하고 새로운 작업판 생성. full multi-branch merge는 후속 기능.
