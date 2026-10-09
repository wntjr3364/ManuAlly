# PW-026 — Isolated runner·입출력 mount — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `apps/worker/src/runner/`
  - `run-dirs.ts`: P00 PW-004 `prepareRun`을 제품 코드로 옮겼다.
    - run마다 새 폴더를 만든다(재사용 안 함). 안에 work·home·tmp·inputs가 있다.
    - runs root 조건: 실행 사용자 소유, group/world 쓰기 불가, symlink 아님, 위쪽에 에이전트 지시 파일(CLAUDE.md, AGENTS.md, .claude, .codex …)이 없음.
    - 입력은 선택한 파일만 읽기 전용(0444) 복사본으로 넣는다. symlink, 다른 hard link, source root 밖으로 나가는 경로, `..`·절대 경로, 검사 중 바뀐 파일은 거부한다. 거부된 run은 아무것도 남기지 않는다.
    - `defaultRunsRoot`: sudo 없이 `$XDG_RUNTIME_DIR`(사적 폴더) 아래, 없으면 사용자 전용 tmp 폴더 아래.
  - `index.ts`
- `infra/sandbox/`
  - `sandbox.ts`
    - backend 둘: bubblewrap(설치된 곳에서 우선) 또는 util-linux `unshare`(sudo 불필요, 비특권 user namespace).
    - 프로그램이 보는 root는 새로 만든 tmpfs다. 그 안에 다음만 있다.
      - 읽기 전용 시스템 폴더(/usr, 인증서, 이름 해석 파일)와 지정한 읽기 전용 폴더(Node/CLI 설치)
      - 자기 run 폴더(읽기·쓰기, inputs는 읽기 전용)
      - 지정한 추가 쓰기 폴더(런타임 로그인 profile)
      - 사적 /proc, /dev(null·zero·random·urandom만), 크기 제한 tmpfs /tmp
    - host HOME, 다른 사용자 파일, 소스 트리, /run(Docker socket)은 안에 없다.
    - unshare backend 순서: 새 root 구성 → `pivot_root` 후 옛 root를 umount → `setpriv`로 모든 capability 제거·no_new_privs → `env -i`(환경 변수 whitelist) → `prlimit`(CPU, 메모리, 프로세스 수, 파일 크기) → 프로그램.
    - 네트워크: `none`(새 net namespace) 또는 `host`(공급자 접속용).
    - 실행 후 새 root와 설정 script를 지운다.
    - `verifyOuterSandbox`: 모델 호출 없이 이 host에서 sandbox를 시험한다. Codex gate(PW-025)가 요구하는 증거 `{kind, verified, host, checked_at, failures}`를 만든다.
  - `probe.mjs`: sandbox 안에서 돌며 닿을 수 있는 것을 JSON으로 보고한다(시험과 `verifyOuterSandbox`가 쓴다).
- 범위 밖(RFC-009 부록): `packages/providers/src/core/admission.ts` — OuterSandbox kind에 `userns`를 추가했다.
- 시험: `tests/tasks/PW-026/runner.test.ts` 18(리뷰 반영 후)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-026-A / TST-026A run 파일은 자기 sandbox에만, 원본 sentinel·기존 session state 불변 | sandbox 안 프로그램이 work·home·/tmp에 쓴다. 바깥 폴더(가짜 개발 CLI 상태: `.claude/.credentials.json`, `projects/session.jsonl`, sentinel)와 소스 트리 `infra/`의 hash가 실행 전후로 같다. 실행 뒤 run 폴더에는 home·inputs·tmp·work만 남는다 |
| | run 폴더: 사적 폴더, 입력은 읽기 전용 복사본이다. 공개 쓰기 가능하거나 symlink인 runs root는 거부한다 |
| REQ-026-B / TST-026B symlink·path traversal·host HOME·Docker socket·원본 쓰기 경로 접근 불가 | 입력 단계: symlink, hard link, `..`, 절대 경로 입력은 거부하고 아무것도 남지 않는다 |
| | sandbox 안: host HOME의 decoy 파일, HOME 목록, 바깥 credential·session 파일, `/var/run/docker.sock`, `/run`, symlink 탈출, `../..` 탈출이 모두 ENOENT다. 소스 트리·/usr·inputs 쓰기는 EROFS/EACCES/ENOENT다 |
| | 환경 변수는 준 4개뿐이고 host 프로세스가 보이지 않는다. /dev는 4개뿐이다. capability가 없다(CapEff 0) |
| | 탈출 시도: chroot 탈출, `/usr` rw remount, `/tmp` umount가 모두 실패한다. 옛 root가 mount 표에 없다 |
| | `network: none`이면 host loopback 포트에 닿지 않는다. 파일 크기 제한이 걸린다 |
| | 추가 쓰기 폴더(로그인 profile)만 쓸 수 있다 |
| | `verifyOuterSandbox`가 `{kind: 'userns', verified: true, host}`를 낸다 |
| | bubblewrap argv(정적): 시스템 읽기 전용, run 읽기·쓰기, `--clearenv`, `none`이면 `--unshare-net`, /tmp를 run보다 먼저 mount, `/`·/root·/home·Docker socket bind 없음 |

## RED → GREEN
- RED: 모듈이 없어 실패했다(`red.log`).
- 개발 중 발견하고 고친 것
  - **chroot 탈출(중요).** 첫 설계는 namespace root 상태로 `chroot`만 했다. 그러면 프로그램이 capability를 가진 채 chroot를 다시 해서 host 트리 전체로 나갈 수 있었다. `escape-demo.log`에 재현이 있다(이전 설계: host `/root`·저장소가 보임 / 현재: `PermissionError`). → `pivot_root` 후 옛 root umount, `setpriv`로 capability 전부 제거·no_new_privs.
  - 제한을 주지 않으면 `prlimit`이 한도 표를 stdout에 찍었다. → 제한이 없으면 `prlimit`을 쓰지 않는다.
  - run 폴더가 /tmp 아래에 있으면 사적 /tmp에 가려졌다. → /tmp를 먼저, run 폴더를 나중에 mount.
  - 설정 script가 run 폴더에 남았다. → 실행 후 지운다.
  - `describe.skipIf`는 PW-007 규칙(조건부 skip 금지)에 걸렸다. → 사용 가능 여부를 시험 하나로 바꿨다. 지원하지 않는 host에서는 보이게 실패한다.
- mutation(`mutation.log`): 13종 모두 탐지했다.
  - 시스템 폴더 쓰기 가능, host HOME 노출, inputs 쓰기 가능, 환경 변수 미정리, network none 무시, 파일 크기 제한 무시
  - symlink 입력 허용, hard link 입력 허용, pid namespace 없음, host /dev 전체 노출
  - pivot_root 없음(chroot), capability 유지, 설정 script 잔류
- GREEN: unit 12.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`): unit 253, integration 198, contracts 15, e2e 77, spikes·evals·pack-check 통과.

## 보안·과학적 실패 경로
- 이 Task는 **격리 수단**만 만든다. 실제 Claude·Codex를 sandbox 안에서 돌리는 연결은 PW-027~030에서 한다. 등록부 행이 아직 requires_verification이라 gate가 실제 호출을 막는다.
- 바깥 sandbox 증거는 같은 host, 24시간 이내여야 Codex gate가 받는다(PW-025). `kind: 'userns'`를 추가했다.

## 미실행 / 남은 위험
- **bubblewrap 실행: not_run.** 이 컨테이너에 설치돼 있지 않다. argv만 정적으로 확인했다. 사용자 PC·연구실 서버에 bwrap이 있으면 PW-030에서 `verifyOuterSandbox({backend: 'bwrap'})`로 확인한다.
- **실제 provider CLI를 sandbox 안에서 돌린 적은 없다**(live 금지). CLI가 읽는 추가 경로(설치 폴더, 인증서)가 더 필요할 수 있다. 그때는 읽기 전용 폴더로만 더한다.
- **host 네트워크 모드는 없앴다(리뷰 MAJOR).** 공급자 접속은 `proxy` 모드로만 한다. sandbox는 항상 자기 network namespace를 가진다. 그래서 host loopback 서비스(DB, API)와 abstract Unix socket(X11, D-Bus)에 닿지 않는다. 나가는 길은 host egress proxy 하나뿐이고, 허용 목록의 host:port로 가는 CONNECT만 통과한다.
- **CLI가 `HTTPS_PROXY`를 따르는지는 실측 전이다(documented_not_verified).** Claude Code와 Codex는 문서상 proxy 환경 변수를 지원한다. PW-030 live smoke에서 확인한다. 따르지 않으면 접속이 안 될 뿐이다(우회 경로 없음).
- **proxy 모드는 namespace 안에서 loopback을 켜는 데 `python3`이 필요하다**(sudo 없이 `ip` 대신 ioctl 한 번). 없으면 `sandboxAvailable(…, {network: 'proxy'})`가 false이고 Codex gate가 거부한다. bubblewrap은 스스로 loopback을 켠다.
- 공급자 허용 목록(호스트 이름)은 PW-028/030에서 정한다. DNS는 host 쪽 proxy가 푼다. 그 주소가 사설·loopback이면 거부한다(DNS rebinding 방지).
- **커널 취약점 방어는 보장하지 않는다.** 비특권 user namespace를 쓰므로 그 커널 공격면이 열린다. user namespace가 막힌 host(일부 서버 정책)에서는 sandbox가 없고, Codex gate가 거부한다(안전한 쪽).
- 동일 계정이라 같은 사용자의 다른 프로세스에 대한 신호·ptrace는 pid namespace로만 막는다. 할당량·CPU는 완전 격리가 아니다(CLAUDE.md 불변조건).
- runs root가 NFS 같은 공유 파일 시스템이면 소유자·권한 검사가 맞지 않을 수 있다. 기본값은 `$XDG_RUNTIME_DIR` 또는 로컬 tmp다.

## 독립 리뷰 반영 (2026-10-09)
리뷰 결론: 변경 요청. MAJOR 1, minor 5, nit 1. 리뷰어는 unshare backend 설계(pivot_root, capability 제거, nested userns 실패)가 버틴다고 확인했다.
- **MAJOR — host 네트워크에서 abstract Unix socket에 닿는다.**
  - 리뷰어 재현: sandbox 안에서 host의 `\0` socket에 연결해 양방향 통신이 됐다. 데스크톱의 X11 `@/tmp/.X11-unix/X0`도 같은 길로 닿는다.
  - 고침: `host` 모드를 없앴다. 모든 실행에 `--net`을 준다. 공급자 접속은 `proxy` 모드로 한다.
    - `egress-proxy.ts`: host 쪽. run 폴더 안의 Unix socket 파일로 듣는다(0600). CONNECT만 받고, 허용 목록의 host:port만 통과시킨다. 사설·loopback·link-local 주소로 풀리는 대상은 거부한다. 평문 HTTP 요청도 거부한다.
    - `forwarder.mjs`: sandbox 안. 127.0.0.1:3128을 socket 파일로 이어 주고, 프로그램을 자식으로 실행한다. 프로그램은 `HTTPS_PROXY` 등을 받는다. 호출자는 이 변수들을 직접 줄 수 없다.
  - 시험: none·proxy 두 모드 모두 host abstract socket과 loopback 포트에 닿지 않는다. `host` 모드는 거부한다. 허용 대상은 proxy로 통과하고, 그 밖은 403이다.
- MINOR-1: `verifyOuterSandbox`
  - 진짜 저장소 대신 스스로 만든 decoy 폴더만 대상으로 쓴다(이전 mutation 실행에서 저장소에 파일이 생긴 원인).
  - `probeFailures`가 모든 결과를 판정한다. 대상: 읽기·쓰기(저장소, /usr, inputs, 바깥 session), capability, no_new_privs, /dev, 옛 root가 mount 표에 있는지, remount·umount·nested userns, abstract socket·host TCP, proxy 거부, 환경 변수.
  - verification은 proxy 모드로 돈다.
- MINOR-2: bwrap `/dev`는 `--dev` 대신 네 장치만 `--dev-bind`한다.
- MINOR-3: sandbox 자체가 거부하는 경로
  - 홈 디렉터리와 그 상위
  - 홈 아래 개발 CLI 상태와 자격증명(`.claude`, `.codex`, `.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `.docker`, `.kube`, `.netrc` 등)과 그것을 포함하는 상위 폴더
  - `/run`·`/proc`·`/sys`·`/dev` 아래, `/etc` 전체
- MINOR-4: bwrap에 `--unshare-net --unshare-cgroup-try --disable-userns --cap-drop ALL`을 더했다. bwrap 0.8 미만은 사용 불가로 본다.
- MINOR-5
  - 사용자 한 명짜리 `/etc/passwd`·`/etc/group`을 넣는다(home은 run의 home).
  - `/etc/resolv.conf`는 넣지 않는다. 이름은 host proxy가 푼다.
- nit: run 폴더가 symlink이거나 symlink 아래에 있으면 거부한다. 설정 파일(새 root, script, passwd, forwarder)은 run 폴더 안 `.pw-setup-*`에 두고, sandbox 안에서는 읽기 전용이다. 실행 뒤 지운다.
- 증거
  - `review-red.log`: 옛 구현에서는 모듈이 없어 실패했다. 동작 차원의 RED는 아래 mutation이다.
  - `mutation.log` 아래쪽: 13종 모두 탐지했다. net namespace 제거, 허용 목록 무시, 사설 주소 허용, 평문 HTTP 통과, bwrap 전체 /dev, bwrap nested userns 허용, 홈 거부 목록 비움, 검증의 쓰기·탈출 무시, passwd 없음, symlink run 허용, loopback 미기동, host 모드 허용.
  - unit 18.

## 다음
PW-027: typed tool gateway·scope
