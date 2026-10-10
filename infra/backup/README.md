# 백업·복원 (PW-060)

데이터베이스와 원본 파일(asset store)을 **한 시점**으로 묶어 백업하고, 새 환경에 복원한다. sudo는 필요 없다. 사용자 계정의 PostgreSQL 도구(`pg_dump`, `pg_restore`)만 쓴다.

## 백업 묶음에 들어가는 것
- `db.dump`: PostgreSQL custom 형식 dump.
- `blobs/sha256/..`: DB가 가리키는 원본 전부. 원본 PDF, 그림 파일, 제출판 source archive가 해당한다. 각 파일은 해시로 확인한 뒤 넣는다.
- `manifest.json`
  - schema 버전(적용된 migration과 그 해시)
  - 표마다 행 수와 내용 digest
  - 원본마다 해시와 크기
  - 경고와 문제
- `COMPLETE`: manifest의 sha256. **맨 마지막에** 쓴다. 이 파일이 없으면 끝나지 않은 묶음이다.

DB dump와 원본 목록과 표 digest는 같은 DB snapshot에서 읽는다. dump 도중에 들어온 쓰기는 어느 쪽에도 없다.

## 들어가지 않는 것
- 자격증명과 AI 실행 로그인 프로필은 들어가지 않는다. 따로 복구한다(spec 12).
- 로그인 세션 행도 빠진다. 복원한 사본은 예전 로그인을 받지 않으므로 다시 로그인한다.

## 사용법
연결 정보는 환경 변수 **이름**으로만 받는다. 비밀번호가 명령줄이나 출력에 나오지 않는다.

```sh
# 백업: 새 폴더에만 쓴다(있는 폴더는 거부)
PW_DATABASE_URL=... PW_ASSET_DIR=... node --experimental-strip-types infra/backup/cli.ts backup --out /backup/pw-2026-10-10

# 확인: 묶음이 온전한가(파일 해시, dump 해시, 빠진 원본·남는 파일, 이 버전이 아는 schema인가)
node --experimental-strip-types infra/backup/cli.ts verify /backup/pw-2026-10-10

# 복원: 비어 있는 새 DB와 asset 폴더로. 확인을 모두 통과해야 migration을 앞으로 적용한다
PW_RESTORE_URL=... node --experimental-strip-types infra/backup/cli.ts restore /backup/pw-2026-10-10 --target-env PW_RESTORE_URL --asset-dir /new/assets
```

종료 코드
- 0: complete / verified / restored
- 1: failed. 출력 JSON의 `problems`가 이유다.
- 2: 사용법 오류

복원 결과의 `target` 필드
- `untouched`: 대상 DB는 그대로 비어 있다.
- `restored_unverified`: 데이터는 들어갔지만 확인을 통과하지 못했다. 그 DB는 지우고 쓰지 않는다.
- `restored`: 확인과 migration까지 끝났다.

## 실패로 보고하는 것
아래는 성공으로 보고하지 않는다.
- DB만 있는 묶음
- 원본이 빠졌거나 손상된 묶음
- 남는 파일이 있는 묶음
- dump 해시가 다른 묶음
- `COMPLETE`가 없거나 manifest와 맞지 않는 묶음
- 이 버전이 모르는 schema(더 새 버전이나 바뀐 migration)의 묶음
- 복원한 표가 manifest와 다른 경우
- DB가 가리키는 원본이 복원된 asset store에 없는 경우

## 사용자가 정할 것(spec 12)
- **보관 위치**
  - 같은 디스크의 다른 폴더는 재해복구가 아니다. 묶음이 asset store와 같은 디스크에 있으면 manifest에 `same_disk` 경고가 남는다.
  - 다른 기기나 오프호스트 사본을 사용자가 지정한다.
- **암호화**
  - 묶음 자체는 암호화하지 않는다. 원고 원문이 그대로 들어 있다.
  - 암호화된 저장 위치에 두거나, 사용자가 고른 도구로 암호화해 옮긴다.
  - 묶음 폴더는 0700으로 만든다.
- **주기**
  - 정기 백업과, 중요한 스냅샷이나 제출판 직후의 추가 백업을 권한다.
  - 목표 RPO/RTO는 운영 환경에서 확인한 뒤 정한다. "데이터 손실 0"은 약속하지 않는다.
- **복원 연습**
  - 배포 전에 한 번, 그 뒤 정기적으로 다른 DB와 폴더에 복원해 본다.
  - 자동 시험 `tests/restore/drill.int.test.ts`가 같은 절차를 합성 데이터로 수행한다.
