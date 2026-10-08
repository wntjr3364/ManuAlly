# P00 독립 리뷰 기록

- 리뷰어: 별도 Claude 에이전트. 읽기 전용, 모델 호출 없음, 자격증명 파일을 읽지 않음.
- 1차: diff `5394c0a..c54b009` / 2차: `c54b009..bf76f80`(+ 문서 `031e355`)
- 2차 지적의 수정: `5de9421`과 이후 문서 커밋. **이 수정분에 대한 3차 리뷰는 받지 않았다.**

## Major
| ID | 지적 (요약) | 1차 수정 | 2차 판정 | 2차 이후 조치 | 최종 상태 |
|---|---|---|---|---|---|
| M1 | AI 수정안 범위가 사용자 선택에 묶이지 않음, 재생 가능 | handle 저장·범위 고정, proposal_id 1회, handle 소비 | fixed (ABA는 PW-017) | — | **fixed**; 문서 단위 base revision은 PW-017 |
| M2 | conservative guard 약함, `mode` 우회 | 수치 순서·비교기호·단위·부정·방향·서식·locator·위치, mode 무시 | partial: 방향 동사·단위·철자 숫자·라벨 교환·주장 강도 우회 | 방향 동사, 철자 숫자, 천 단위 구분, 길이·질량·시간 단위, 비교 단어 추가 | **partial (휴리스틱)**, 남은 우회는 RFC-003에 기록 → PW-043/044 |
| M3 | 손실 보고서가 본문 누락 못 봄, figure_ref 행 없음 | 블록별 순서 비교, 서식 비교, figure_ref degraded | partial: 인용 제거·교체·locator·삽입 미탐지 | citeproc 렌더링 원문과 블록별 **정확 일치** 비교 | **fixed (이 fixture 기준)**; 수식 내용은 비교 제외 |
| M4 | 개발 config 우회(symlink, HOME) | realpath·소유자·권한 검사 | fixed(폴더 자체), 내부 링크 미검사 | profile 내부 symlink·hardlink 거부 | **fixed** |
| M5 | sentinel 미연결 | decideModelCall·startProviderRun 연결 | partial: sentinel 결과·admission 객체 위조 가능 | 발급된 frozen 결정만 허용, sentinel은 같은 host·24시간 이내 | **partial**: 프로세스 내 발급 확인은 실수 방지용. 권한 근거는 서버 DB 기록(PW-023/030) |
| M6 | Claude 설정 표면(hooks, CLAUDE.md) | `--restricted`, 상위 agent-config 거부 | partial: live 미실행, 준비 시점만 검사 | 실행 직전 재검사 | **partial**: `--restricted` live 확인은 PW-024 |
| M7 | Codex shell 차단 안 됨 | feature 15개 끔, unified_exec 불가 실측, Codex 비활성 | honestly handled | 정책 문구 정정, bubblewrap 요건(RFC-004) | **Codex 비활성** (bubblewrap 검증 전) |
| M8 | fixture 통계 오류 | 25/40 vs 15/40, χ²=5.0, p=0.025 | fixed | — | **fixed** |
| M9 | 검증기가 깊이·철회·그룹·부정·과장 못 잡음 | 깊이·철회·그룹·null·인과 규칙 | partial: 약어, 방향 동사, 추세 포장, 인과 동사, p/n 값, use_role | 별칭, 방향어 확장, null spin, 인과 동사, p·n 값 일치, use_role | **partial (휴리스틱)**; 문체(장문·보고서식)는 설계상 미판정 |
| N1 | (2차 신규) `-p`/`app-server` 앞 인자 미검사 | — | major | 전체 argv 검증, 테스트용 인터프리터는 `cmdPrefix`로 분리·검증 | **fixed** |
| N2 | (2차 신규) `--mcp-config` 경로 무제한 | — | minor | run 폴더 안으로 제한, `..` 거부 | **fixed** |

## Minor
| 지적 | 상태 |
|---|---|
| 인자 denylist | fixed (allowlist) |
| prepareRun: hardlink, TOCTOU, 부분 폴더, 느슨한 runs root | fixed |
| spawn error 처리 없음 | fixed |
| 재사용된 pgid kill 가능(주석이 사실과 다름) | fixed (`groupStillOurs`: 같은 pgid를 다른 프로세스가 리더로 쓰면 kill 안 함; /proc 없으면 kill 안 함) |
| root로 생략되던 테스트 | fixed (uid 65534로 실행) |
| 임시 폴더 누수 | fixed. 사고 증거 폴더 1개는 사용자 확인 대기 |
| 보고서-코드 불일치(t.after, sentinel 강제, P00 phase 파일 없음) | 정정 기록 + 이 파일과 P00_GATE 작성 |
| 측정 스크립트 미커밋 | `tools/` 아래 커밋 |
| preserve_atom 잘못된 index의 code 누락 | fixed |
| 6개 Task를 리뷰 없이 연속 진행 | 기록함(위임 결정). P01부터 Task 단위 리뷰 제안 |

## Verified (리뷰어 확인)
- 숨겨진 live 테스트 없음, diff에 비밀값 없음.
- 사고(ping 1회) 기록이 transcript와 일치한다(사용량·비용·모델·시각). 기존 세션에는 영향이 없었다.
- quota 정보를 지어내지 않았다(unknown/documented 구분).
- npm 버전 8개 일치, write scope 준수.
