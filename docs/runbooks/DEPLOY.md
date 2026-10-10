# 배포 runbook (PW-061)

개인 PC와 연구실 Linux 서버에 **사용자 계정으로, sudo 없이** 설치한다. 한 설치는 한 사용자의 것이다. 앱과 worker는 loopback에만 열린다. 다른 기기에서 쓰려면 TLS reverse proxy를 앞에 둔다.

## 0. 준비물
- Node.js와 PostgreSQL 16 도구. 버전은 `infra/deploy/versions.json`의 pin과 같아야 한다(다르면 [UPGRADE.md](UPGRADE.md)).
- pnpm과 저장소 checkout(앱 설치 폴더). 예: `~/paper-workspace`.
- 선택: LibreOffice(PDF 내보내기, PW-057).

## 1. 전용 data root
원본 PDF·그림·내보낸 파일(assets), 로그, 임시 파일, 실행 상태가 모두 이 아래에 생긴다.

```sh
mkdir -m 0700 /data/paper-workspace     # 예시 경로: 사용자가 정한다
df -h /data/paper-workspace              # 용량 확인
```

조건(`pwctl check`가 확인한다)
- 절대 경로, 사용자 소유, 0700, symlink 아님.
- 홈 폴더 자체가 아니다. 앱 설치 폴더 밖, `~/.claude`·`~/.codex`·`~/.config/claude` 밖이다.
- tmpfs·ramfs·overlay(컨테이너 층)가 아니다.
- **크기 상한 `max_data_bytes`가 필수다.**
  - 상한에 닿으면 새 업로드와 새 파일은 507로 거부된다. 읽기와 편집은 계속된다.
  - `pwctl status`의 `disk.pressure`로 보인다.

## 2. 운영 DB(테스트·개발 DB와 분리)
- 운영 DB는 `pw_test*`나 `pw_dev`가 아닌 이름이다. `PW_TEST_DATABASE_URL`과 같은 DB면 거부된다.
- 같은 기계면 unix socket을 쓴다. 다른 기계의 DB는 `sslmode=verify-full`이어야 한다.
- 사용자 소유 클러스터(sudo 없음) 예시:
  ```sh
  PW_PG_DIR=/data/paper-workspace-pg PW_PG_PORT=54330 sh infra/dev/pg-dev.sh start   # 개발용 스크립트를 운영 포트·폴더로
  createdb -h /data/paper-workspace-pg/socket -p 54330 -U pw paper_workspace
  ```
  - 클러스터 폴더는 data root 밖에 둔다. data root 상한은 파일 저장소를 위한 것이다.
  - 같은 디스크라면 둘 다 디스크 용량에 함께 넣어 계산한다.
- 연결 URL은 환경 파일에 둔다. `~/.config/paper-workspace/env`, 0600, git 밖이다.
  ```
  PW_DATABASE_URL=postgres://pw@localhost:54330/paper_workspace?host=/data/paper-workspace-pg/socket
  ```

## 3. 설정 파일
`infra/deploy/deploy.example.json`을 `~/.config/paper-workspace/deploy.json`으로 복사해 고친다.

| 키 | 뜻 |
|---|---|
| `data_root` | 1의 폴더 |
| `max_data_bytes` | data root 크기 상한(1 GiB 이상) |
| `database_url_env` | DB URL이 든 **환경 변수 이름** |
| `listen` | `127.0.0.1` 또는 `::1`, 포트 1024 이상 |
| `public_origin` | 사용자가 여는 주소. 이 기계만이면 `http://127.0.0.1:포트`, 다른 기기면 `https://…`(reverse proxy). https면 쿠키가 `Secure`(`__Host-`)가 된다. |
| `web_dist` | `pnpm --filter @pw/web build` 결과 폴더 |
| `log` | 로그 파일당 최대 크기와 보관 개수(로그 상한 = (keep+1)×max_bytes, 프로세스마다) |
| `backup_dir` | PW-060 백업 위치. migration 전 백업과 `status`의 백업 경과 시간에 쓴다. |

## 4. 설치와 첫 실행
```sh
cd ~/paper-workspace && pnpm install --frozen-lockfile && pnpm --filter @pw/web build
export PW_DEPLOY_CONFIG=~/.config/paper-workspace/deploy.json; set -a; . ~/.config/paper-workspace/env; set +a
node --experimental-strip-types infra/deploy/pwctl.ts check      # 문제 목록이 비어야 한다
node --experimental-strip-types infra/deploy/pwctl.ts migrate    # 빈 DB: 바로 적용. 데이터가 있으면 먼저 백업
node --experimental-strip-types infra/deploy/pwctl.ts run        # supervisor(API+웹, worker)
```

계속 실행하기
- 사용자 systemd: `infra/deploy/paper-workspace.service`. 서버에서 로그아웃 후에도 돌리려면 `loginctl enable-linger`가 필요하다. 관리자 허가가 없으면 tmux나 screen 안에서 `pwctl run`을 실행한다.
- 첫 계정은 브라우저에서 만든다(이 컴퓨터에서만, PW-008).

## 5. 다른 기기에서 쓰기(선택)
- 앱은 loopback에만 열린다. 같은 기계의 reverse proxy가 TLS로 받아 `127.0.0.1:포트`로 넘긴다.
- 예: 사용자 권한의 Caddy·nginx, 또는 연구실이 제공하는 proxy.
- `public_origin`은 proxy의 https 주소로 한다.
- 수동 확인 MAN-DEPLOY-TLS(`reports/security/manual-checks.json`)
  - 배포한 주소에서 쿠키 `Secure`와 `__Host-`를 확인한다.
  - 다른 origin의 요청이 거부되는지 확인한다.
  - 응답 헤더(CSP `frame-ancestors 'none'`, `nosniff`, `no-referrer`)를 확인한다.
  - 사용자가 확인한 날짜와 근거를 기록한다.

## 6. 일상 운영
[OPERATIONS.md](OPERATIONS.md): 상태, AI 일시 중지, 안전 중단, 로그, 디스크, 백업.
