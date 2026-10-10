# 업그레이드 runbook (PW-061, spec 12 "업그레이드")

구성 요소를 하나씩 식별하고, 확인을 통과한 뒤에만 pin을 바꾼다. "latest"나 범위(`^`, `x`, `>=`)는 pin이 될 수 없다.

## pin
`infra/deploy/versions.json`의 `pins`
- `node`
- `postgres`(major)
- `pnpm_lock`(lockfile sha256: 의존성 전체)
- `libreoffice`
- `claude_code`·`codex`: 쓰지 않으면 null

`pwctl check`는 설치된 버전과 pin을 비교한다. 다르면 거부한다. 단, 그 버전에 대해 통과한 `verify-upgrade` 기록이 있으면 경고만 하고 pin을 고치라고 알린다.

## 절차
1. **백업**: [infra/backup/README.md](../../infra/backup/README.md). 묶음을 다른 위치에 복사한다.
2. **AI 일시 중지**: `pwctl pause-ai --reason "upgrade <구성요소>"`.
3. 새 버전을 설치한다(사용자 권한). 앱 코드 업데이트라면 `git pull`, `pnpm install --frozen-lockfile`, 웹 빌드.
4. **확인**: `pwctl verify-upgrade <구성요소> <설치된 정확한 버전>`
   - `versions.json`의 `verify_commands`(typecheck, unit, contract 시험)를 실행한다.
   - 결과는 `<data_root>/run/upgrades.json`에 기록된다.
   - 실패하면 pin을 바꾸지 않는다. 이전 버전으로 돌아가거나, 깨진 공급자만 끈다(수동 편집은 계속 쓸 수 있다).
5. **pin 변경**: 통과한 버전으로 `versions.json`을 고쳐 커밋한다. 앱 코드 변경이면 저장소 쪽에서 `pnpm test` 전체를 통과한 커밋이어야 한다.
6. **migration**: `pwctl migrate`. 데이터가 있는 DB는 먼저 PW-060 백업을 만들고(실패하면 멈춤) 그 다음 적용한다. 서버는 schema가 현재가 아니면 시작하지 않는다.
7. `pwctl stop`, 그 다음 `pwctl run`(또는 `systemctl --user restart paper-workspace`). `pwctl status`를 확인한다.
8. `pwctl resume-ai --reason "upgrade checked"`.

## 되돌리기
- 데이터를 지우는 down migration은 쓰지 않는다.
- 문제가 있으면 6의 백업을 새 DB와 asset 폴더에 복원한다(PW-060 `restore`). 설정의 DB와 data root를 그쪽으로 바꾼다.
- 또는 앞으로 고치는 migration(forward fix)을 만든다.

## AI CLI(Claude Code, Codex)
- 공급자 CLI 업데이트도 위 절차를 따른다.
- 로컬 계약 시험이 기준이다. 최신 문서와 다르면 그 기능은 쓰지 않는다(CLAUDE.md "Versions and dependencies").
- 실제 로그인으로 하는 확인(MAN-LIVE-SANDBOX)은 사용자가 한다.
