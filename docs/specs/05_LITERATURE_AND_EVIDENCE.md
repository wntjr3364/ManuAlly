# 05. Literature curation, PDF and evidence

## 논문을 AI가 선정하는 방식
사용자가 paper brief를 정하면 AI는 검색식 후보 → 실제 bibliographic API 검색 → 중복 정리 → article type/주제/저널 적합성/본문 접근 깊이 평가 → 선정 사유 → 후보함을 만든다. 승인된 검색 범위·개수·비용 안에서는 매 논문마다 사용자 클릭을 강제하지 않는다. 그러나 scientific citation 채택·writing profile 변경은 검토 대상이다.

역할은 Scientific Reference와 Writing Reference로 분리. 동일 논문은 두 역할을 가질 수 있다. 높은 IF/인용수만으로 ‘좋은 글’로 선정하지 않는다. article type·연구 설계·섹션 문체·방법 재현성·논리의 명확성을 본다. Claude가 후보를 골랐다는 사실만으로 검증 완료가 되지 않는다.

## 검색과 원문
Crossref는 서지·출판 후 업데이트 조회의 기본 후보 [S13]. 생명과학은 PubMed 및 실제 사용조건을 확인한 OpenAlex adapter를 추가한다. 구체 endpoint/요금/key/호출 한도는 P00/P04에서 현재 문서와 live contract를 확인한다. 검색 요청·응답 원문 일부/확인일/provider/version을 cache한다. preprint·출판본·correction·retraction·expression of concern은 구분한다.

자동 원문 취득은 허용된 공개 API/라이선스 경로 또는 사용자의 합법적 업로드만 사용. PMC는 자동 수집 경로와 논문별 라이선스 제한을 명시한다 [S14]. 로그인·유료벽 우회, 대량 publisher scraping 금지. 다운로드할 권리와 외부 LLM으로 전송할 권리는 별도 field. writing profile에 원문 문장 전체를 대량 복사하지 않는다.

## 읽은 깊이
METADATA_ONLY / ABSTRACT_ONLY / FULLTEXT_PARTIAL / FULLTEXT_PARSED / SOURCE_CHECKED. 섹션 문체 분석은 실제 해당 섹션 접근이 필요. abstract만 읽었으면 Discussion 문체를 분석했다고 표시하지 않는다. schema·DOI 존재는 claim support를 증명하지 않는다. 지지/반대/불명/확인필요를 분리한다.

## PDF 파이프라인
immutable original → MIME/크기/해시 검사 → 안전한 parser → 페이지·섹션·문단 chunk → 메타데이터 대조 → 사용자 검증. PDF.js viewer, GROBID TEI/좌표는 보조 추출 [S12]. 읽기 순서·하이픈·표·수식 오염을 flag한다. OCR은 이미지 기반 문서임을 확인하고 해당 페이지에 한정한 opt-in fallback. parsed text 없음은 내용을 추측해 채우지 않는다.

PDF anchor: asset_revision_id, sha256, page_index(0-based), normalized quadpoints, exact quote, prefix/suffix, extractor_version. 페이지 crop/rotation/zoom 변화 golden tests. 새로운 PDF revision에 이전 좌표를 자동 적용하지 않는다.

## Evidence와 Fact
사용자가 결과 CSV/TSV/figure/table/method note를 올리면 Fact candidate를 만들 수 있으나 verified와 구분한다. Fact에는 단위·대조군·반복수·통계종류·p와 adjusted p 구분·source locator가 있어야 한다. 숫자를 graph screenshot에서 읽으면 검증필요. 분석을 다시 실행하거나 원본 결과 파일을 고쳐 claim에 맞추는 기능은 v1에 없다.

## Figure/Table 관리
asset version과 panel/table cell을 구분. caption version, source evidence, 본문 mention을 연결. Figure 번호는 ID와 별개로 배치 순서에 따라 계산. 새 figure를 업로드하면 기존 caption/본문 claim의 impact review를 만든다. 원본 그림은 보존하며 썸네일을 연구 원본으로 대체하지 않는다.

## Zotero와 이식성
v1은 DOI/CSL-JSON/BibTeX/RIS 가져오기 및 선택적인 Zotero read-only 연동 [S15]. Zotero가 외부 정본이면 local override와 source revision을 별도 기록한다. 양방향 sync는 미포함. 인용 번호/연도 suffix 등은 deterministic citeproc에 맡기며 LLM이 생성하지 않는다.

## 문헌 선택 실패
DOI 없음은 부적격과 동일하지 않음. 중복 DOI는 source metadata 차이를 비교. 인용에 사용된 논문이 철회되거나 metadata 수정되면 경고·검토 task를 만들고 과거 snapshot을 소급 변조하지 않는다. 문헌 unavailable 시 현재 증거 수준에서 답하거나 추가 원문을 요청한다.
