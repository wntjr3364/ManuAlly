# 공식 근거와 확인 범위

확인일: 2026-10-08. 아래는 공개 문서 검토이며 실제 사용자 환경·계정 테스트가 아니다. 가격·고정 사용량·미검증 SDK 메서드를 제품 요구사항에 하드코딩하지 않는다.

## S01 — Claude Agent SDK overview
https://code.claude.com/docs/en/agent-sdk/overview

SDK는 Claude Code 기반 agent loop·sessions·permissions를 제공. 제3자 제품의 claude.ai 로그인/한도 제공에는 사전 승인 제약이 명시됨. API 인증과 구독 인증을 혼동하지 않는다.

## S02 — Claude programmatic/headless execution
https://code.claude.com/docs/en/headless

-p, structured/stream JSON, session resume. bare mode는 호스트 구성 자동 로드를 줄이며 subscription OAuth를 사용하지 않는다. 실제 설치 버전에서 지원을 검증한다.

## S03 — Claude sessions
https://code.claude.com/docs/en/agent-sdk/sessions

명시적인 session ID와 resume/fork를 사용. 파일시스템 격리나 사용자 논문 버전 관리는 별도 설계 대상.

## S04 — Claude status line
https://code.claude.com/docs/en/statusline

context/usage 정보와 조건부 rate_limits 필드. 모든 실행 모드에 모든 필드가 제공되는 보장은 없다.

## S05 — Claude SDK usage
https://code.claude.com/docs/en/agent-sdk/cost-tracking

SDK usage와 추정 비용의 의미를 어댑터에서 정규화해야 함. CLI 재개 시 누적 집계를 단순 합산하지 않는다.

## S06 — Claude permissions
https://code.claude.com/docs/en/agent-sdk/permissions

공식 권한 제어를 이용하되 애플리케이션의 서버 권한 검증·OS 격리를 대체하지 않는다.

## S07 — Codex App Server
https://developers.openai.com/codex/app-server/

공식 구조화 연동. thread/turn, compaction, token usage, 계정별 rate-limit surface 제공. 배포·인증 범위와 설치 버전별 schema 검증 필요.

## S08 — Codex App Server authentication
https://learn.chatgpt.com/docs/app-server#authentication

현재 문서는 기존 local/open-source app-server 인증과 commercial/hosted 사용을 구분하고 Sign in with ChatGPT 경로를 안내한다. 자체 호스팅의 해당 여부를 임의 단정하지 않는다.

## S09 — Tiptap editor
https://tiptap.dev/docs/editor/getting-started/overview

오픈소스 core와 유료 Pro/Cloud 확장을 구분한다. core 기반 자체 comment/AI proposal 구현을 제안.

## S10 — Tiptap comments
https://tiptap.dev/docs/comments/getting-started/overview

공식 Comments는 요금제·private registry·document server 의존이 있다. 이를 무료 내장 기능으로 가정하지 않는다.

## S11 — Pandoc manual
https://pandoc.org/MANUAL.html

DOCX·LaTeX·PDF 변환과 citation 처리를 제공하나 모든 포맷 간 완전한 round-trip은 보장하지 않는다.

## S12 — GROBID
https://grobid.readthedocs.io/en/latest/Introduction/

학술 PDF의 구조·참고문헌·좌표를 추출한다. 추출 결과는 검증된 과학적 사실과 다르다.

## S13 — Crossref REST API
https://www.crossref.org/documentation/retrieve-metadata/rest-api/

서지정보·라이선스·출판 후 업데이트 등 조회. DOI 존재는 본문 주장 지지 여부와 다르다.

## S14 — PMC automated access and licenses
https://pmc.ncbi.nlm.nih.gov/tools/textmining/

자동 수집 경로와 논문별 재사용 조건이 있다. 공개 접근 가능성을 무제한 자동 다운로드 권한으로 간주하지 않는다.

## S15 — Zotero Web API
https://www.zotero.org/support/dev/web_api/v3/basics

서지 라이브러리 읽기, API version, 인증, 로컬 API의 구분. v1은 가져오기/읽기 연동부터 제공한다.

## S16 — Fastify
https://fastify.dev/docs/latest/

TypeScript backend 후보의 공식 문서. 런타임 버전·plugin 호환성을 P00에서 고정한다.

## S17 — pg-boss
https://github.com/timgit/pg-boss

PostgreSQL 기반 Node 작업 큐. 큐 보장만으로 외부 LLM 요청·문서 변경의 exactly-once를 보장하지 않는다.

## S18 — Nature Portfolio editorial policies
https://www.nature.com/nature-portfolio/editorial-policies

학술지 정책은 프로젝트별로 원문·확인일을 저장하고 투고 전 재확인한다. 모든 저널에 동일 AI 공개 규칙을 하드코딩하지 않는다.

## S19 — OpenAI API rate limits
https://developers.openai.com/api/docs/guides/rate-limits

API request/token rate 제한과 구독 quota·사용자 예산을 분리한다.

## S20 — Anthropic API rate limits
https://platform.claude.com/docs/en/api/rate-limits

API rate 제한과 spend 제한은 다르다. 재시도는 공급자가 제공한 정보와 오류 유형에 근거한다.
