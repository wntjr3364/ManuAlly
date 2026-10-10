# PW-061 — 배포·storage·upgrade runbook — REPORT
상태: in_review (2026-10-10)

## 무엇을 했나
sudo 없이 사용자 계정으로 돌리는 개인 설치 하나를 위한 배포 도구와 runbook이다(사용자 결정: 개인 PC와 연구실 서버, 자기 계정).

- **`infra/deploy/check.ts`**: 배포 확인. 통과하지 않으면 아무것도 시작하지 않는다.
  - **data root**: 절대 경로, 사용자 소유, 0700, symlink 아님. 홈 자체 아님. 앱 폴더 밖, `~/.claude`·`~/.codex`·`~/.config/claude|codex` 밖. tmpfs·ramfs·overlay·aufs·squashfs 아님(내구성 없는 층).
  - **크기 상한** `max_data_bytes`(1 GiB 이상)는 필수. 로그도 파일 크기와 개수로 제한한다.
  - **네트워크**: listen은 loopback만, 포트 1024 이상(권한 불필요). 다른 기기용 public origin은 https만.
  - **DB**: `pw_test*`·`pw_dev` 이름 거부, `PW_TEST_DATABASE_URL`과 같은 DB 거부, 다른 기계의 DB는 `sslmode=verify-full` 필수.
  - **버전**
    - pin은 정확한 버전만 받는다(latest, 범위, 태그 거부).
    - 설치된 버전이 pin과 다르면 거부한다. 단, 그 버전에 대해 통과한 `verify-upgrade` 기록이 있으면 경고만 한다.
    - pin 없이 설치된 구성 요소도 거부한다.
- **`infra/deploy/serve.ts`**: 운영 서버. API와 빌드된 웹 앱을 한 origin, loopback에서 낸다.
  - **보안 헤더**(PW-059 F-02): CSP(`frame-ancestors 'none'` 등), `X-Frame-Options`, `nosniff`, `no-referrer`, COOP·CORP. route가 직접 정한 더 엄격한 정책(원본의 sandbox CSP)은 덮어쓰지 않는다.
  - https origin이면 `Secure`, `__Host-` 쿠키를 쓴다.
  - schema가 현재가 아니면 시작하지 않는다.
  - disk pressure 동안 업로드·내보내기·가져오기는 507이다. 읽기와 편집은 계속된다.
  - 웹 파일은 빌드 폴더 안의 것만 낸다(경로 탈출 시 앱 화면). 앱 화면은 공개이고, `/api`는 세션 확인을 그대로 한다.
- **`infra/deploy/pwctl.ts`**: 운영 명령.
  - `check`
  - `migrate`: 데이터가 있으면 PW-060 백업을 먼저 만들고, 백업 폴더가 없거나 백업이 실패하면 거부.
  - `run`: supervisor.
    - API와 worker를 만든 환경으로 띄운다.
    - 로그는 제한된 회전 파일에 쓴다. 임시 폴더는 data root 아래이고 시작할 때 비운다.
    - 죽은 자식은 다시 띄운다(10분에 5번 초과면 멈춤).
    - 1분마다 data root 크기를 재서 disk pressure를 켜고 끈다(기록 남음).
  - `status`: 관측 불가 값은 `UNKNOWN`, 백업 없음은 `none`.
  - `pause-ai` / `resume-ai`: 이유 필수, 기록.
  - `stop`: 안전 중단. worker가 손의 작업을 끝낸 뒤 API.
  - `verify-upgrade`: `versions.json`의 확인 명령을 실행해 기록한다.
- **AI 일시 중지**: `db/migrations/pw_061_0001_ops_controls.sql`, `apps/worker/src/ai-pause/index.ts`
  - 멈춘 동안 AI 작업은 시도 횟수를 쓰지 않고 기다린다.
  - 멈춤이 온 뒤 끝난 호출의 결과는 적용하지 않고 다시 실행한다.
  - 제어 행이 없으면 멈춘 것으로 본다.
- **`infra/deploy/logs.ts`**: 회전 로그. 프로세스마다 최대 (keep+1)×max_bytes, 파일 0600.
- **기타**: `infra/deploy/versions.json`(pin과 확인 명령), `deploy.example.json`, `paper-workspace.service`(systemd --user).
- **runbook**: `docs/runbooks/{DEPLOY,OPERATIONS,UPGRADE}.md`.

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-061-A / TST-061A(깨끗한 전용 환경에서 private deployment·상태조회·안전중단) | `tests/tasks/PW-061/deploy.int.test.ts` "TST-061A"(실제 `pwctl` CLI, 운영 이름의 새 DB, 실제 웹 빌드, 실제 Chromium) | 통과 |
| REQ-061-B / TST-061B(root overlay 무제한 저장·공개 agent port·운영/테스트 DB 혼용·latest 무검증 업데이트 불허) | `tests/tasks/PW-061/check.test.ts`(10), `deploy.int.test.ts` "TST-061B"(3), `ai-pause.int.test.ts`(4) | 통과 |

TST-061A가 보이는 것
- `check` 통과, 이주 전 `run` 거부, `migrate`(빈 DB는 백업 없이).
- `run`
  - 보안 헤더 7종. `/`·client route는 앱, 경로 탈출은 앱 화면, 없는 `/api`는 404.
  - LAN 주소로는 닿지 않는다(LAN 주소가 있는 환경에서).
  - 브라우저로 로그인했을 때 CSP 위반이나 페이지 오류가 없다.
- `status`: 프로세스·health·schema·AI·디스크·queue·백업 `none`/`UNKNOWN`·로그.
- `pause-ai`
  - 이유 없으면 exit 2.
  - 멈춘 동안 AI 작업은 `[ai_paused]`로 기다리고, 수동 story 편집은 201이다.
  - `resume-ai` 뒤에는 작업이 끝난다.
- worker를 SIGKILL하면 새 worker가 뜬다. 로그는 상한 안이다.
- `stop`: supervisor exit 0, state 파일 삭제, `status`에서 not running. 두 번째 `stop`은 "was not running".

TST-061B가 보이는 것
- 거부되는 설정(`0.0.0.0`, 테스트 DB)은 아무것도 띄우지 않는다.
- 데이터가 있는 DB의 migration: 백업 폴더가 없으면 거부, 있으면 완성 백업(`COMPLETE`) 뒤 PW-061 migration을 적용한다.
- 상한이 차면 업로드 507, 읽기 200, 기록이 남는다. 풀리면 업로드 201이고, 원본 응답은 자기 sandbox CSP를 유지한다.

## RED → GREEN
- **순서 위반**: 이 Task는 구현을 먼저 쓰고 시험을 나중에 썼다. Engineering workflow 순서를 어겼다.
- 대신 규칙을 뺀 상태로 시험을 돌려 실패를 재현했다(`red.log`).
  - 규칙 없는 check: 5개 실패.
  - 아무것도 안 하는 pause: 2개 실패(`completed` ≠ `deferred`).
  - 헤더 없는 서버: 1개 실패.
- 첫 시도의 pause RED는 무효로 버렸다(정의되지 않은 함수로 다른 이유에서 실패).
- GREEN으로 가는 동안 drill이 실제 결함 5개를 찾았다.
  1. node 타입 제거 모드는 생성자 매개변수 속성을 거부한다. `RotatingLog`를 일반 필드로 바꿨다.
  2. PostgreSQL 버전을 잘못된 열에서 읽어 `NaN`이었다(check가 정당하게 거부).
  3. `status`가 이주 전 DB를 "닿지 않음"으로 보고했다. 항목별로 보고하도록 고쳤다.
  4. 웹 route가 세션 확인에 걸려 `/`가 401이었고, `/*`는 `/`를 받지 않았다.
  5. `stop`이 끝났지만 거두어지지 않은 supervisor(zombie)를 살아 있다고 보았다(`red.log` 끝). `/proc/<pid>/stat` 상태로 판단한다.

## Mutation(`mutation.log`)
- 빠른 시험 22종 중 21종을 잡았다. 남은 1종(이유 없는 pause)은 DB CHECK가 같은 것을 거부하는 동치다.
- drill 7종 중 6종을 잡았다(상한 초과 업로드, 원본의 sandbox CSP 덮어쓰기, 백업 없는 migration, 빌드 밖 파일, 재시작 없음, worker의 pause 누락).
- 살아남은 1종: supervisor가 운영자 환경 전체를 자식에게 넘기는 것. 정적 점검은 `process.env` 펼침만 찾는다. `childEnv` 키 목록 시험을 더해 잡았다(R2).

## 변경 파일
- write scope
  - `infra/deploy/{check.ts, serve.ts, pwctl.ts, logs.ts, versions.json, deploy.example.json, paper-workspace.service}`
  - `docs/runbooks/{DEPLOY,OPERATIONS,UPGRADE}.md`
  - `db/migrations/pw_061_0001_ops_controls.sql`
  - `tests/tasks/PW-061/{check.test.ts, ai-pause.int.test.ts, deploy.int.test.ts}`
  - `reports/tasks/PW-061/**`
- 범위 밖(RFC-014 부록 PW-061)
  - `apps/worker/src/ai-pause/index.ts`(새), `apps/worker/src/main.ts`(wrapper 연결)
  - `tests/security/static.test.ts`: 검토 목록에 `pwctl`의 자식 프로세스와 loopback health 확인을 넣었다.
- 새 의존성 없음. 정적 파일은 직접 낸다(`@fastify/static`을 쓰지 않음).

## 보안·과학 경계
- 운영자 행위(AI 일시 중지, migration, 업그레이드 확인)는 명령으로만 하고 모두 기록된다. AI가 하지 않는다.
- AI가 멈춘 동안 만든 결과는 정본에 들어가지 않는다.
- supervisor는 운영자 환경 전체를 자식에게 넘기지 않는다(정적 점검 대상). 비밀번호는 환경 파일(0600, git 밖)에만 둔다.
- 관측하지 못한 값은 `UNKNOWN`이다(0으로 만들지 않음).

## 미검증·남은 위험
- **실제 사용자 PC와 연구실 서버 배포는 하지 않았다.** 사용자가 runbook대로 해야 한다.
  - 사용자 systemd와 linger, reverse proxy와 TLS(MAN-DEPLOY-TLS, 수동)가 포함된다.
  - 이 컨테이너에서는 사용자 systemd를 시험하지 못했다.
- disk pressure의 압력 상태는 1분 간격 측정이다. 그 사이의 급증과 DB 자체 크기는 상한에 들어가지 않는다(DB 클러스터는 data root 밖 권장).
- 실행 중인 AI 호출은 멈춤 때 즉시 끊지 않는다. 결과를 버리고 나중에 다시 한다. 실제 공급자에서는 그 호출만큼 사용량이 든다.
- `verify-upgrade`의 기본 확인은 typecheck, unit, contract다. 통합 시험은 DB가 있는 개발 환경에서 따로 돌려야 한다.
- 컨테이너(Docker) 배포는 다루지 않는다(사용자 결정: sudo 없음). Docker socket은 쓰지 않는다.

## 다음
PW-062(최종 pilot gate)
