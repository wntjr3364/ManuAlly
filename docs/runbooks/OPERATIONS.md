# 운영 runbook (PW-061)

모든 명령은 `node --experimental-strip-types infra/deploy/pwctl.ts <명령>` 형태다. 설정은 `PW_DEPLOY_CONFIG` 또는 `--config`로 준다. 종료 코드는 0 정상, 1 거부·실패, 2 사용법 오류다.

## 상태: `pwctl status`
JSON으로 보여 준다.
- 프로세스: supervisor, API, worker
- health
- schema: 현재인가, 남은 migration
- AI 일시 중지: 여부, 이유, 시각
- 디스크: 사용량, 상한, pressure
- queue: 상태별 개수, 실행 중인 AI 작업, 가장 오래 기다린 작업
- 마지막 백업과 경과 시간
- 로그 크기

관측할 수 없는 값은 0이 아니라 `"UNKNOWN"`이다. 예: 백업 폴더가 설정되지 않음, 디스크를 아직 재지 않음. 완성된 백업이 하나도 없으면 `"none"`이다.

## AI 일시 중지(비상 중단): `pwctl pause-ai --reason "…"` / `pwctl resume-ai --reason "…"`
- 중지 중
  - 새 AI 작업은 시작하지 않고 기다린다(시도 횟수를 쓰지 않음).
  - 이미 돌던 AI 호출은 끝나지만 **결과는 적용되지 않는다**. 재개 후 다시 실행된다.
  - 사용자 수동 편집, PDF 해석, 내보내기는 계속된다.
- 이유는 필수다. 모든 변경은 `ops_control_log`에 남는다(지울 수 없음).
- 공급자 장애, 할당량·인증 문제, 업그레이드 점검 때 쓴다.

## 안전 중단: `pwctl stop`
1. worker가 손에 든 작업을 끝내고 새 작업을 받지 않는다.
2. 그 다음 API가 멈춘다. supervisor가 끝나고 `run/state.json`이 지워진다.
3. 강제로 끊긴 실행이 있으면 다음 시작 때 PW-053 복구 절차가 정리한다.

## 장애
- **자식 프로세스가 죽으면** supervisor가 다시 띄운다. 10분에 5번을 넘으면 멈춘다(`status`로 확인하고 로그를 본다).
- **디스크 상한**
  - `disk.pressure: true`이면 업로드, 새 내보내기, 가져오기가 507로 거부된다.
  - 원고·원본·내보내기는 지우지 않는 기록이다. 디스크를 늘리고 상한을 올린다(설정을 고치고 다시 시작).
  - 다음 측정(1분 간격)에서 풀린다.
- **DB 연결 실패**: `status`의 `db.reachable: false`. 편집 저장은 실패로 표시된다. 저장되었다고 표시하지 않는다(PW-014).

## 로그
- `<data_root>/logs/{api,worker}.log`. 크기 상한에 닿으면 `.1`, `.2`, …로 밀려나고 `keep`개를 넘는 것은 지워진다.
- API 로그에는 요청 방법·경로·상태와 오류가 남는다. Fastify 기본 로그는 요청 본문(원고 원문)을 쓰지 않는다.
- AI 실행 오류는 PW-052 규칙으로 가린 뒤 저장된다.
- 로그 폴더는 0700, 파일은 0600이다.

## 임시 파일
- PDF 해석 등의 임시 파일은 `<data_root>/tmp`에 생긴다(worker의 `TMPDIR`).
- supervisor가 시작할 때 비운다.

## 백업
- [infra/backup/README.md](../../infra/backup/README.md) 참고.
- 권장 주기: 매일, 그리고 중요한 스냅샷이나 제출판 직후.
- `status`의 `last_backup.age_hours`로 확인한다.
- 정기적으로 다른 DB와 폴더에 복원해 본다.
