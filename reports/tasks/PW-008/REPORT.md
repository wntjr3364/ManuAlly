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

## 독립 리뷰 후속 (verdict: changes requested → 수정)
리뷰가 찾은 major 5건 가운데 3건(1·2·4)은 위 보고서의 보안 주장과 실제 코드가 달랐다. 아래와 같이 정정·수정했다.

| 리뷰 | 원인 | 조치 / 회귀 테스트 (`review-fixes.int.test.ts`) |
|---|---|---|
| 1 사용자명 열거(타이밍) | `DUMMY_HASH`의 필드가 하나 모자라 scrypt를 건너뜀(있는 계정 45–70 ms, 없는 계정 1 ms) | 실제 해시와 같은 형식으로 수정. 형식 일치 테스트 + 응답 시간 비교 테스트 |
| 2 동시 요청이 rate limit 우회 | 실패를 비밀번호 확인 **뒤에** 기록 | 확인 **전에** 슬롯을 예약하고 성공 시 반환. 20개 동시 요청, max 3 → 401은 3개 이하 |
| 3 동시 setup으로 owner 여러 명 | 개수 확인과 삽입 사이에 잠금 없음 | 트랜잭션 + `pg_advisory_xact_lock`. 4개 동시 요청 → 201 하나, 409 셋 |
| 4 인코딩 경로(`/%61pi/…`)로 인증 hook 우회 | 원문 URL 접두어로 판단 | **매칭된 route** 기준으로 판단. route는 `config.public`을 선언하지 않으면 모두 비공개. 인코딩 경로 → 403/401, 새 route 기본 401 |
| 5 500 응답에 내부 정보 노출 | 오류 처리기 없음 | 공통 오류 처리기(500은 `{"error":"internal"}`만 반환, 상세는 서버 로그). NUL 문자 → 422. 깨진 쿠키 → 세션 없음(401) |
| minor | — | 같은 세션의 CSRF 토큰이 탭마다 같도록 세션 토큰에서 HMAC로 파생(회전 불필요), `allowed_providers` 열 추가(migration pw_008_0002), archive 재요청은 아무것도 바꾸지 않음, 로그인 시 기존 세션 폐기, Secure일 때 `__Host-` 쿠키, 실패 기록 map 정리, `/api/papers/:x`는 반드시 `:paperId` 사용 |

남은 것:
- spec 02의 `policy_id`는 별도 정책 테이블 대신 열(`external_send_policy`, `data_classification`, `allowed_providers`)로 대체했다(편차로 기록).
- archive된 논문의 PATCH는 허용한다(spec에 금지 규정 없음).
- SSE·blob·search route는 아직 없어 TST-008B의 해당 부분은 not_run이다. 생기면 `:paperId` 규칙과 기본 비공개 규칙으로 같은 테스트에 들어간다.

테스트: PW-008 원래 11 + 리뷰 회귀 10 = 21/21.

## 재리뷰 결과 (2026-10-08)
결론: approve(이전 major 7건 모두 해결 확인). minor 처리:
- 1 CSRF header 바이트 길이 비교: 비ASCII 헤더로 500이 나던 문제. 이제 403(`sessions.ts`, 회귀 시험 PW-009/review-fixes).
- 2 4xx 종류 보존: 413 `payload_too_large`, 415, 404, 405, 429는 이름을 유지하고 내부 정보는 계속 숨긴다.
- 3 public route allowlist: 보류. 기존 PW-008 시험이 임의 public route를 등록하므로, 시험 전용 옵션을 정한 뒤 PW-014에서 처리한다.
- 4 `sessions.csrf_hash` 미사용 열: 보류. 다음 auth migration에서 제거한다.
