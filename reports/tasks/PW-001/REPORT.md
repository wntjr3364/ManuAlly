# PW-001 — 환경·저장소·운영 경계 확인 — 보고서

상태: **in_review** (구현·테스트 완료, 독립 review 및 사용자 승인 대기)
일자: 2026-10-08

## 변경 파일
- `spikes/preflight/preflight.mjs` — 비파괴 preflight. 경로를 생성·수정하지 않고, 보호 경로는 `lstat`만 수행(내용 읽기/목록 조회 없음). 출력은 호출자가 지정한 `--out` 파일뿐.
- `tests/tasks/PW-001/preflight.test.mjs` — 7개 테스트.
- `reports/tasks/PW-001/{red.log,green.log,preflight.cloud-dev-container.json}`

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-001-A 승인/미정/보호 경계 구분 | TST-001A (3 cases) | pass |
| REQ-001-B 확인 불가 시 blocked, 파일 생성 안 함 | TST-001B (4 cases: 없음·파일/symlink·여유공간 불명·여유공간 부족) | pass |

## RED → GREEN
- RED: `node --test 'tests/tasks/PW-001/*.test.mjs'` → `ERR_MODULE_NOT_FOUND` (구현 전). `red.log`
  - 참고: 최초 RED 시도는 디렉터리 인자를 사용해 테스트 파일 자체가 로드되지 않은 잘못된 RED였음. glob 패턴으로 재실행해 올바른 RED를 기록함.
- GREEN: 같은 명령 → 7 pass / 0 fail. `green.log`

## 실제 환경 실행
`node spikes/preflight/preflight.mjs --label ... --out reports/tasks/PW-001/preflight.cloud-dev-container.json`
→ exit 0. **이 결과는 개발용 클라우드 컨테이너이며, 사용자의 PC나 연구실 서버가 아니다.**
확인된 도구: node 22.22.0, pnpm 10.28.0, psql 16.15 (client only), docker 29.8.2, pandoc 3.1.3, git 2.43, claude 2.1.294. codex는 PATH에 없음(PW-002에서 scratch에 0.161.0 별도 설치해 조사).

## 미실행 / blocked
- 사용자 PC(PERSONAL_LOCAL)와 연구실 서버(PRIVATE_SELF_HOSTED)에서의 preflight: **not_run** — 사용자가 각 머신에서 실행해야 함:
  `node spikes/preflight/preflight.mjs --data-root <경로> --protect <기존 연구 폴더> --out preflight.<머신>.json`
  (`--approved`는 사용자가 해당 경로를 운영 data root로 승인한 경우에만 붙인다.)
- data root, 백업 위치, runtime OS 사용자, provider 전용 config dir: 미정(undecided).

## 보안·데이터 경계
- 보호 경로(`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/claude`, 사용자가 지정한 연구 폴더)는 존재 여부만 기록. 테스트가 `readFileSync/readdirSync/openSync` 호출이 없음을 기록 fs로 검증.
- 도구 버전 조사 시 child에 `HOME=os.tmpdir()`만 전달해 개발 CLI 설정을 읽지 않게 함.

## 잔여 위험
- Windows 환경은 테스트하지 않음(`statfsSync`, symlink 동작 차이). 사용자 PC가 Windows면 WSL2 사용 권장 — PW-006 결정 항목.
- 여유공간 최소값 20 GiB는 제안값이며 운영 데이터량 확인 후 조정.

## 다음 Task
PW-002 Provider 인증·배포 admission.
