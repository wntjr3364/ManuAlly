# PW-008 — Owner 인증과 PaperProject — 보고서

상태: **in_review** / 일자: 2026-10-08

## 변경 파일
- `db/migrations/pw_008_0001_owner_papers.sql`
  - `owners`: scrypt 해시만 저장
  - `sessions`: 토큰·CSRF는 sha256 해시만 저장, 만료·폐기
  - `paper_projects`: owner 필수, 상태 active/archived, `external_send_policy`(기본 allow_selected — 사용자 결정), `data_classification`, `version`(낙관적 동시성)
- `packages/domain/src/shared/db.ts`: Queryable, DomainError, UUID 검사
- `packages/domain/src/papers/index.ts`: 생성·조회·목록·수정·archive. **모든 쿼리에 owner_id 조건**
- `apps/api/src/auth/{passwords,owners,sessions,plugin}.ts`
  - 최초 1회 setup: loopback에서만, owner가 이미 있으면 409
  - 로그인: 쿠키 HttpOnly + SameSite=Strict, 원격 공개 시 Secure 옵션. 계정 존재 여부가 응답 시간으로 드러나지 않게 함. 원격 주소별 실패 횟수 제한(429)
  - 상태 변경 요청은 Origin allowlist + CSRF 헤더(세션별 해시)를 검사. 새로고침한 페이지는 `GET /api/auth/session`으로 CSRF를 회전 발급
  - logout은 세션을 폐기
- `apps/api/src/routes/papers/index.ts`
- `apps/api/src/server.ts`
  - `:paperId`가 들어간 route는 `config.paperScoped`를 선언해야 하며, 없으면 서버가 시작을 거부한다
  - 소유권 검사 preHandler는 서버가 자동으로 붙인다(빠뜨릴 수 없음)
- 테스트: `tests/tasks/PW-008/papers.int.test.ts` (11개)

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-008-A 논문 A/B 독립 생성, owner 요청만 읽기·수정 | TST-008A ×7 (setup 1회, 쿠키 속성·토큰 해시 저장, 401·429, 독립 생성·버전 충돌 409·archive 보존·DELETE 없음, 422 field, CSRF·Origin, logout) | pass |
| REQ-008-B 다른 owner/project ID로 데이터 반환 없음 | TST-008B ×4 (다른 owner의 GET/PATCH/archive/unarchive 모두 404 + 본문에 제목 없음 + 목록에 없음 + 도메인 null / **등록된 모든 paper-scoped route**를 다른 owner·익명으로 호출 → 404·401 / 검사 없는 route 등록 시 서버 시작 거부 / 잘못된 id·SQL 주입 문자열 404) | pass |

- RED: owners 모듈 없음(`red.log`). GREEN: 11/11.
- Mutation(`papers.int.test.ts` 기준):
  - `getPaper`에서 owner 조건 제거 → 2건 실패
  - 서버가 소유권 검사를 붙이지 않게 함 → 4건 실패
- SSE·blob·search route는 아직 없다. 생기면 `:paperId` 규칙에 따라 같은 IDOR 테스트에 자동 포함된다.

## 보안·실패 경로
- 다른 owner의 논문은 403이 아니라 404로 응답해 존재 여부를 숨긴다.
- 로그인 rate limit은 프로세스 메모리 기준이다. 역프록시 뒤에 둘 때는 trustProxy 설정이 먼저 필요하다(지금은 loopback 기본).
- 세션 만료 기본값은 12시간이다. 비밀번호 변경·전체 세션 폐기 UI는 아직 없다.

## 미실행
- 브라우저 로그인 UI: PW-010/014에서 웹 앱과 함께.
- 원격 공개(TLS) 설정: v1 운영 단계(PW-061).

## 다음 Task
PW-009 불변 revision·snapshot 저장.
