# P00 Gate 보고서 — 사전 타당성·위험 검증

일자: 2026-10-08 / 판정 제안: **CONDITIONAL GO (Mock 전용 P01)** / **사용자 승인 전에는 P01을 시작하지 않는다**

## 1. Task별 증거
| Task | REQ / AC | 자동 테스트 | 실환경 증거 | not_run / blocked |
|---|---|---|---|---|
| PW-001 | REQ-001 A,B | 7/7 | 개발 컨테이너 preflight (`reports/tasks/PW-001/preflight.cloud-dev-container.json`) | 사용자 PC·서버 preflight |
| PW-002 | REQ-002 A,B | 10/10 | CLI `--version` probe, Codex schema inventory | Claude/Codex live smoke |
| PW-003 | REQ-003 A,B | 17/17 | DOCX/HTML 출력 + 블록별 손실 보고서, 거부 사례 목록 | 브라우저 selection·IME, PDF, DOCX import |
| PW-004 | REQ-004 A,B | 15/15 | auth sentinel 실측(claude=leak, codex=isolated), Codex feature 실측, 의도치 않은 Claude 호출 1회(사고) | 실제 resume/interrupt/quota, bubblewrap, 사용자 머신 sentinel |
| PW-005 | REQ-005 A,B | 14/14 | mutation check(결정적 오류 8/8 탐지, 문체 2건은 설계상 미판정) | 모델 출력 평가, 실제 문단 gold |
| PW-006 | REQ-006 A,B | 4/4 | 결정 기록, RFC 5건, 버전·라이선스 | — |

- 전체: `node --test --test-timeout=30000 'tests/tasks/PW-00*/*.test.mjs'` → **67/67 pass, skip 0**
- `python3 -I scripts/validate_pack.py` → PASS (계획 문서 정합성 검사이며 제품 테스트가 아니다)
- 모든 자동 테스트는 fake CLI / fixture 기반(mock)이다. 실제 provider 호출로 검증한 항목은 없다. 사고로 생긴 1회 호출의 관측값은 참고 자료로만 쓴다.

## 2. 다음 phase로 넘기면 안 되는 blocker
없음 — 단, 아래 "명시적 제한"이 P01 범위에서 지켜진다는 전제다.

## 3. 유지되는 명시적 제한
1. 외부 AI 호출 0회(Mock 전용). Claude 활성화는 RFC-004 승인 + 사용자 머신 sentinel isolated + live smoke 후. Codex는 bubblewrap 검증 후.
2. AI guard와 baseline 검증기는 **휴리스틱**이다. 알려진 우회는 RFC-003과 P00_REVIEW에 기록했고, PW-043/044의 회귀 사례로 넘긴다.
3. admission 발급 확인은 프로세스 내 실수 방지다. 실제 권한 근거는 서버 DB 기록이어야 한다(PW-023/030).
4. DOCX 손실 검사는 fixture 1개로만 측정했다. 수식 내용은 텍스트 비교에서 제외했다.
5. RFC-003(승인 전 교정)은 proposed다. 승인 전까지 승인 전 AI 교정은 구현하지 않는다.

## 4. 이전 phase 불변조건 회귀
해당 없음(첫 phase). P00 spike 사이의 회귀는 전체 테스트 67/67로 확인했다.

## 5. 사용자 승인 요청
- P00 → P01 승급
- RFC-003, RFC-004, RFC-005, ADR-013~015 승인
- 결정 기록 6장의 확인 항목: 분리 로그인 동의, 서버 sudo, 사용자 머신에서 preflight·sentinel 실행, data root/백업, 민감 자료 범위, 사고 증거 폴더 삭제
