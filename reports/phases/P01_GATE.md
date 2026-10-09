# P01 Gate — 수동 논문 작업 기반 (PW-007 ~ PW-014)
작성: 2026-10-09 · 상태: **사용자 승인 대기**

## 결과 요약
| Task | 내용 | 시험(최종) | 독립 리뷰 |
|---|---|---|---|
| PW-007 | monorepo, 명령, 시험 분류, user-owned PostgreSQL | `pnpm test` 전체 | 리뷰 1회 반영 |
| PW-008 | 로그인, 논문 프로젝트, owner 격리, CSRF·Origin | 통합 21 | 리뷰, 재리뷰 approve |
| PW-009 | 불변 revision, 복원, 이름 붙인 스냅샷 | 통합 13 | 리뷰 반영 |
| PW-010 | 스토리·개요 수동 작성, 정확한 버전 승인, AI 초안 gate | 통합 26 | 리뷰, 재리뷰 approve |
| PW-011 | 근거·사실·주장, owner만 검증, p/q 분리, 원문 숫자 보존 | 통합 33 | 리뷰, 재리뷰 approve |
| PW-012 | browser·server 공용 editor-core, 계약 v2 | unit 43, Chromium parity, contracts 13 | 리뷰, 재리뷰 approve |
| PW-013 | DB job·outbox·감사 기록, lease·fencing, crash 회복 | 통합 31 | 리뷰, 재리뷰 approve |
| PW-014 | 웹 화면과 수동 수직 경로 E2E | E2E 25, 통합 1, unit 19 | 리뷰(major 4)·재리뷰(major 2)·최종 확인(major 1, 내 회귀)·검증(minor 2 + 반복 실행에서 찾은 입력 유실 2) 반영 |

최종 회귀 `pnpm test` exit 0:
- unit 71, integration 130, contracts 13, e2e 25, spikes 70
- 의존성: lockfile 270개 전부 14일 이상(overrides 포함), 모두 라이선스 확인(MIT 계열·Apache-2.0)
- evals PASS, pack-check PASS

## 사용자 결정이 필요한 항목
1. **RFC-006(P01 write scope 보완) 확인.** 앱 조립 파일과 Task 사이 연결 지점을 각 Task 범위 밖에서 고쳤고, 모두 RFC-006 부록에 기록했다. 특히 다음 공유 변경을 확인해 달라.
   - editor-core schema `doc: block*`(빈 원고 허용)
   - `DomainError` 구조 변경
   - 원고 검증을 domain 저장 함수로 이동
   - root `pnpm.overrides`(14일 규칙용 하위 의존성 고정)
2. **개요 승인 방식.** 현재는 보수적으로, 모든 문단 계획이 승인되어야 AI 초안이 열린다.
   - spec 03의 "범위별 승인 → 해당 문단 생성"과 다르다.
   - 유지(권장) 또는 문단별 허용 중 선택.
   - "계속"으로 진행했으므로 현재 유지 중이다.
3. **연구실 서버 접속 방식.** 원격 접속은 SSH 터널(`ssh -L`)을 기본으로 한다. https 배포는 P07에서 한다.
4. **P00 사건 임시 폴더 `/tmp/pw004-live-neg-*` 삭제 여부**(이전 세션부터 보류). 사용자 PC에 있는 경우에 해당한다.

## 다음 phase로 넘기는 위험 (확인만)
- **공유 연구실 서버에서 개발 서버(5173)와 API(8787)는 127.0.0.1에만 열리지만, 같은 서버의 다른 사용자 계정도 그 주소에 접속할 수 있다.**
  - 첫 계정을 만들기 전에는 다른 로컬 사용자가 먼저 계정을 만들 수 있다. proxy를 거치면 모든 요청이 loopback으로 보이기 때문이다. 설치 직후 바로 계정을 만들어야 한다.
  - 로그인 후에도 세션 쿠키와 비밀번호는 보호되지만, 공유 서버 운영은 P07의 unix socket 또는 사용자 전용 인증 프록시 설계로 다룬다.
- **앱 DB 계정이 superuser다.** trigger를 끌 수 있으므로 runtime role 분리를 연구실 서버 운영 전에 반드시 해야 한다(P07, RFC 예정).
- **worker 상시 루프가 아직 없다.** relay와 recoverJobs 호출, WAITING 재개 스케줄, 재발행 상한은 P02/P03 provider 연결과 함께 한다.
- **편집기 IME·다중 탭·붙여넣기 정리·자동 저장**은 PW-015/022에서 한다.
- **그림·표·문헌 자료 입력(asset/reference API)**은 P04에서 한다.
- **RFC-003(승인 전 보수적 교정)** 결정은 P02 시작 시 한다.
- **사용자 PC와 서버의 preflight·인증 격리 sentinel 실측**은 P03(실제 provider) 전에 필요하다.

## 승인 요청
P01을 완료로 승인하고 P02(provider adapter, Mock 기반 제안 경로)를 시작할지 결정해 달라. 승인 전에는 P02를 시작하지 않는다.
