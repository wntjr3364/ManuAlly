# PW-060 — Backup·restore·migration drill — REPORT
상태: in_review (2026-10-10) — 독립 리뷰 approve(NIT 3 반영)

## 무엇을 했나
- **`infra/backup/backup.ts`**
  - **백업**: DB dump(`pg_dump` custom), DB가 가리키는 원본 전부(해시 확인 후 복사), manifest, `COMPLETE` 표시.
    - 표 digest·원본 목록·dump를 **한 DB snapshot**에서 읽는다(`pg_export_snapshot` → `pg_dump --snapshot`).
    - manifest에 들어가는 것: 적용된 migration(이름·해시), 표마다 행 수·digest, 원본마다 해시·크기·참조 수, 경고(`same_disk`), 빠진 것(자격증명, 로그인 세션).
    - 원본이 빠졌거나 손상되면 `failed`이고 `COMPLETE`를 쓰지 않는다. 있는 폴더에는 쓰지 않는다.
  - **확인**(`verifyBackup`)
    - `COMPLETE`가 manifest 해시와 맞는가, 백업 상태가 complete인가.
    - dump 해시·크기가 맞는가, 원본마다 해시·크기가 맞는가, 남는 파일이 없는가.
    - schema: 모든 migration을 이 버전이 같은 해시로 아는가(더 새 버전 거부), 앞쪽 migration이 빠지지 않았는가.
  - **복원**(`restoreBackup`): 확인을 통과한 묶음만 비어 있는 DB로 복원한다.
    1. `pg_restore --single-transaction`
    2. 모든 표를 manifest와 대조한다.
    3. 원본을 새 asset store에 넣는다.
    4. 복원된 DB가 가리키는 원본이 모두 있고 온전한지 본다.
    5. 그 다음에만 migration을 앞으로 적용한다.
    - 결과 `target`: untouched / restored_unverified / restored.
  - 연결 정보: 비밀번호는 PG* 환경 변수로만 넘긴다. 명령줄과 출력에는 없다.
  - 원본을 가리키는 열은 `BLOB_REFS`에 있다. 옛 schema에 없는 열의 참조는 건너뛴다(PW-056 이전 export는 파일을 행에 담았다).
- **`infra/backup/cli.ts`**: `backup` / `verify` / `restore`. 연결은 환경 변수 이름으로 받는다. 종료 코드: 0 성공, 1 실패, 2 사용법.
- **`infra/backup/README.md`**: 묶음 구성, 사용법, 실패로 보고하는 것, 사용자가 정할 것(보관 위치·암호화·주기·복원 연습).

## 요구사항–시험
| REQ/AC | 시험 | 결과 |
|---|---|---|
| REQ-060-A / TST-060A(원고·개요·근거·comment·reference·figure·snapshot이 함께 복원) | `tests/restore/drill.int.test.ts`. 두 사용자의 논문에 원고·개요·근거·comment·reference·figure(파일)·snapshot·export·제출판 archive가 있다. 백업 후 새 DB·새 asset 폴더에 복원한다(원래 원본 폴더는 치운다). 확인: 읽기 route 응답이 바이트까지 같다(40개 이상), 파일 3개 이상 같다, 다시 로그인된다(예전 세션은 401), 새 스냅샷이 만들어진다. CLI도 같은 절차로 확인한다(exit 0, 비어 있지 않은 DB 거부, 사용법 2). **migration 호환**: PW-056까지의 schema로 만든 묶음을 복원하면 PW-057·058 migration이 적용되고, 이 버전 서버가 원고·export 파일을 읽고 source archive를 만든다. | 통과 |
| REQ-060-B / TST-060B(DB만 되거나 blob checksum·참조가 깨진 백업을 성공으로 보고하지 않음) | `tests/restore/failures.int.test.ts`: 저장소의 원본 누락·손상 → 백업 failed(`COMPLETE` 없음, 확인·복원 거부, 대상 DB 그대로). DB만 있는 묶음, manifest를 고쳐 원본을 지운 묶음(복원된 DB가 잡음, migration 안 함), 손상·바뀐·남는 원본, 잘못 놓인 파일, 원본 크기 변조, dump 잘림·없음, `COMPLETE` 없음, manifest 변조, 표 불일치, 모르는 schema·바뀐 migration·빠진 migration, 있는 폴더, **dump 중의 쓰기가 묶음에 없음**(한 시점), 해시 열 분류, 비밀번호가 명령줄에 없음. | 통과 |

## RED → GREEN
- RED(`red.log`): 서명만 있는 stub에서 두 파일 모두 `not implemented`로 실패.
- GREEN 중 시험이 실제 결함을 찾았다. 옛 schema(PW-056) 백업이 `in_asset_store` 열이 없어 실패했다. 참조 열이 있는 schema에서만 찾도록 고쳤다.
- 통합 18개 통과(리뷰 n1 시험 추가 후 19개).
- 회귀: `pnpm test` exit 0(`test.log`: unit 618, 통합 658, contracts 17, 브라우저 101, spikes·evals·pack-check).

## Mutation(`mutation.log`)
- 28종 탐지.
  - 백업: 누락·손상 원본 묵인, 실패에도 `COMPLETE`, 같은 snapshot 미사용, 세션 포함, 같은 디스크 경고 누락, 있는 폴더.
  - 확인: `COMPLETE`·manifest·상태·dump 해시·원본·크기·남는 파일·schema 3종.
  - 복원: 비어 있지 않은 DB, 표 대조, 없는 표, 참조 원본, 문제 있어도 migration, 확인 실패 후 진행.
  - 연결: 비밀번호, 소켓 host. 참조 열 schema 확인, archive 원본 누락.
- 첫 회차에 원본 크기 확인 생략이 살아남았다(내용은 해시로 확인되므로 manifest 변조만 해당). manifest 변조 시험을 더해 잡았다.

## 변경 파일
- write scope
  - `infra/backup/{backup.ts, cli.ts, README.md}`
  - `tests/restore/{drill.int.test.ts, failures.int.test.ts}`
  - `reports/tasks/PW-060/**`
- 범위 밖(RFC-014 부록 PW-060): `tests/security/static.test.ts`. PW-059 정적 점검이 새 자식 프로세스 모듈을 잡았고(의도된 동작), 검토 목록에 이유와 함께 넣었다.
- DB migration 없음. 새 의존성 없음(PostgreSQL 16 도구는 P00 환경).

## 보안·과학 경계
- 백업은 정본(DB와 원본)을 그대로 옮긴다. AI나 서버가 내용을 바꾸지 않는다.
- 복원된 사본은 확인을 통과하기 전에 쓰지 않는다. 실패하면 `restored_unverified`라고 말한다.
- 자격증명·세션은 묶음에 없다. 비밀번호는 명령줄·manifest·출력에 없다.
- 묶음은 원고 원문을 담는다. 폴더는 0700이다. 암호화와 보관 위치는 사용자가 정한다.

## 미검증·남은 위험
- 실제 운영 환경(사용자 PC, 연구실 서버)의 복원 연습은 하지 않았다. 사용자가 배포 후 한 번 해야 한다(README, PW-061 runbook).
- 묶음 암호화·오프호스트 복사·일정 실행·백업 경과 시간 알림은 구현하지 않았다. 사용자 지정 위치와 PW-061 runbook에서 다룬다.
- 원본은 메모리로 읽는다. 아주 큰 원본에서는 느리다.
- `pg_dump`는 서버보다 같거나 새 버전이어야 한다. 시험은 PostgreSQL 16에서만 했다.
- 복원 대상은 같은 major 버전에서만 확인했다.

## 독립 리뷰(approve) — NIT 반영
- n1: migration 적용 실패를 던지지 않고 보고한다(`failed`, `restored_unverified`, `migration_error`). 실패하는 migration을 넣은 시험을 추가했다.
- n2: 옛 schema 시험의 "옛 버전"은 **이 버전의 앱 코드가 PW-056까지의 schema를 쓰는 것**이다. PW-056 export 행은 그 시절 형태로 SQL로 직접 넣었다. 옛 버전 앱 자체가 쓴 데이터는 아니다. 검증되는 것은 옛 schema의 묶음 → 앞으로 migration → 이 버전 기능 동작이다.
- n3
  - URL의 TLS 인증서 설정(`sslrootcert`, `sslcert`, `sslkey`)도 환경 변수로 넘긴다(시험 보강).
  - README에 `PW_PG_BIN`으로 서버와 같은 major 도구를 쓰라고 적었다. 새 `pg_dump` 묶음을 옛 서버에 넣으면 안전하게 실패한다.

- 리뷰 NIT 반영 후 `pnpm test` exit 0(`test.log`: unit 618, 통합 659, contracts 17, 브라우저 101).

## 다음
PW-061(배포·storage·upgrade runbook)
