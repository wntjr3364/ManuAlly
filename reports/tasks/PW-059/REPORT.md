# PW-059 — Security release audit — REPORT
상태: in_review (2026-10-10)

보안 감사 보고서는 `reports/security/RELEASE_AUDIT.md`, 게이트 기록은 `reports/security/audit.json`이다.
**게이트 결정은 `pending_manual`**이다. 자동 8영역 263개 시험이 통과했고 critical·high는 open이 아니다. 실제 기계 확인 2건이 남았다.

## 무엇을 했나
- **전 route sweep**(`tests/security/sweep.int.test.ts`, `routes.ts`, `world.ts`)
  - route는 서버 자신의 route table에서 읽는다(152개). 논문 route 수가 서버의 paper-scoped 목록과 일치하는지도 본다.
  - 두 사용자가 29종 기록을 가진 논문을 만든다. 모든 글에 사용자별 canary를 넣는다.
  - 점검: 세션 없음 401, CSRF·Origin 403, 다른 사용자 논문 404, 자기 논문에 다른 사용자 id(경로·본문·변형).
  - 판정: 유출, 변경, 교차 참조, 500이 없어야 한다.
- **정적 점검**(`static.test.ts`): 비밀 문자열·키 파일, 네트워크 모듈·fetch 사용처, 자식 프로세스 사용처와 환경 명시, 자격증명 파일 처리, 브라우저 저장소. 모두 검토된 목록과 이유가 있고, 새 사용처는 실패한다.
- **egress**(`egress.test.ts`): URL·주소 거부 53+3개, DNS rebinding.
- **prompt injection**(`injection.int.test.ts`): 심은 지시를 따르는 모델 시나리오. 도구 이름 점검.
- **공급망**(`supply-chain.test.ts`): `pnpm licenses`로 운영 의존성 라이선스 허용 목록, 버전 지정 규칙, lockfile
- **F-01 수정**(`credentials.test.ts`, RED → GREEN): 로그인 프로필 검사
- **release gate**(`gate.ts`, `gate.test.ts`, `run-audit.ts`): 시험 실행기 결과로 영역 상태를 만든다. findings 등록부는 `reports/security/findings.json`이다. 결정은 allowed / pending_manual / refused 셋이다.

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-059-A / TST-059A(최소권한·비밀 가림·명시 외부전송 정책 부정 시험과 보고서) | sweep(인증·CSRF·IDOR), static(비밀·egress·spawn env·자격증명·저장소), egress, injection, credentials(F-01), supply-chain, 기존 PW-008·026·027·034·035·052·055·057 묶음; 보고서 `reports/security/RELEASE_AUDIT.md` | 통과(`audit-run.log`) |
| REQ-059-B / TST-059B(critical leak·IDOR·host 접근이 남았거나 시험 미실행을 숨기면 release 거절) | `gate.test.ts`: open critical·high, AI의 위험 수용, 근거 없는 fixed, 실패·미실행·누락·0개·skip 영역, 수동 미확인, 형식 오류. `run-audit.ts`는 실행기 결과만 쓴다. | 통과. 실제 결정 `pending_manual`(exit 2) |

## RED → GREEN
- F-01: `red-F01.log`(2 실패) → 수정 → 통과
- sweep: 처음 실행부터 통과했다. 그래서 IDOR를 심어 시험이 무는 것을 보였다(아래 mutation).
- gate·static·egress·injection·supply-chain은 구현과 함께 썼다. 각 규칙은 mutation으로 확인했다.

## Mutation(`mutation.log`)
- IDOR와 인증 심기
  - export 파일·제출판·리뷰 의견 조회의 논문 필터 제거, 본문 id의 논문 범위 제거, owner check 우회, CSRF 제거
  - 6종 중 5종을 잡았다. 리뷰 의견 조회는 본문 변형을 넣은 뒤 잡혔다(FK가 막아 500으로 드러남).
- 게이트 규칙 7종, F-01, egress 2종(IP 리터럴은 목록 시험 보강 뒤), 정적 점검 심기 4종(API의 fetch, env 없는 spawn, 서버 env 전달, 자격증명 읽기): 모두 잡았다.

## 변경 파일
- write scope
  - `tests/security/{routes.ts, world.ts, sweep.int.test.ts, static.test.ts, egress.test.ts, injection.int.test.ts, credentials.test.ts, supply-chain.test.ts, gate.ts, gate.test.ts, run-audit.ts}`
  - `reports/security/{RELEASE_AUDIT.md, findings.json, audit.json}`
  - `reports/tasks/PW-059/**`
- 범위 밖(RFC-014 부록 PW-059): `apps/worker/src/provider-runs/index.ts`(F-01 수정)

## 보안·과학 경계
- 게이트는 skip이나 미실행을 통과로 치지 않는다.
- 위험 수용은 사용자만 한다.
- 수동 확인은 근거 없이 통과시키지 않는다.

## 미검증·남은 위험
- 수동 2건(실제 CLI sandbox, 배포 TLS·헤더)은 사용자 기계에서 해야 한다.
- F-02(low, 헤더)는 PW-061에서 다룬다.
- sweep은 각 route의 첫 검증을 넘는 깊이가 제한적이다. 깊은 경로는 각 Task 시험이 맡는다(SEC 묶음에 포함).
- 브라우저 XSS 자동 탐색, 경합 공격, 외부 침투 시험은 하지 않았다.

## 다음
PW-060(백업·복구 drill)
