# RFC-004 — 전용 런타임 OS 사용자 필수화와 auth isolation sentinel
Status: proposed
Trigger task: PW-004
Affected requirements/specs/contracts: REQ-004, REQ-026, REQ-059, REQ-061; docs/specs/07_AGENT_RUNTIME.md, 09_SECURITY_AND_PRIVACY.md, 12_OPERATIONS_AND_BACKUP.md
Problem and evidence:
PW-004 live 음성 검사 결과(reports/tasks/PW-004): 빈 `CLAUDE_CONFIG_DIR`, run 전용 HOME, whitelist env에서도 Claude CLI 2.1.294가 `loggedIn: true (oauth_token)`를 보고했고 `-p` 호출이 성공했다. 호스트 수준 자격증명 공급원이 있으면 env/HOME 격리로는 막을 수 없다. 사용자 PC의 OS keychain도 같은 종류의 위험이다. Codex 0.161.0은 빈 `CODEX_HOME`에서 account=null(격리됨).
같은 검사에서 이 컨테이너의 PID 1이 고아 프로세스를 회수하지 않아 zombie가 남는 것도 확인했다.
Proposed change:
1. 런타임 provider 프로세스는 **전용 non-root OS 사용자**로 실행한다(개발 사용자와 분리). macOS/Windows PC는 별도 로컬 사용자 계정 또는 Linux VM/WSL2. 연구실 서버는 systemd 서비스 사용자 + bubblewrap/컨테이너.
2. provider admission 전에 `checkAuthIsolation` sentinel을 실행한다. 빈 profile에서 `isolated`가 아니면(leak/unknown) 해당 호스트·provider를 admission하지 않는다. 업그레이드 후에도 다시 실행한다.
3. 실제 로그인은 그 다음에 런타임 사용자가 자신의 profile dir에서 한다.
4. runner는 고아를 회수하는 init 아래에서 실행한다(systemd, 또는 컨테이너 `--init`/tini).
5. Linux 서버에는 Codex sandbox용 `bubblewrap` 패키지를 설치한다.
Alternatives considered:
- env/HOME 격리만: 실측으로 불충분함이 확인돼 기각.
- 개발 계정과 같은 OS 사용자에서 keychain 항목만 분리: OS별 동작이 불명확하고 검증 수단이 없어 기각.
Security/privacy/budget/provider terms impact: 개발 세션의 quota·자격증명이 논문 런타임에 섞이는 것을 막는다. 설치 단계가 늘어난다(사용자 1회 작업).
Data migration / backward compatibility: 없음.
Tests and acceptance criteria: sentinel 단위 테스트(통과), 각 배포 호스트에서 sentinel 실측 isolated, 런타임 사용자로 개발 HOME 읽기 시도 실패(PW-026), non-root에서 0444 입력 수정 실패.
Write scope: spikes/isolation/**(완료), P03 PW-026 runner, infra 문서.
User decision / reviewer: P00 gate에서 사용자 승인 필요.
