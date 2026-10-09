# PW-014 — 수동 논문 수직경로 검증 — REPORT
Status: in_review (독립 리뷰 대기) / Phase: P01 / Requirement: REQ-014

## 변경 파일
- **웹 앱(신규)** `apps/web/`
  - `index.html`, `vite.config.ts`: 개발 서버는 `/api`를 API(127.0.0.1:8787)로 proxy한다. 브라우저 입장에서는 한 origin이다.
  - `src/main.tsx`, `src/app/{App,Login,api,router}.ts(x)`, `styles.css`
    - 로그인
    - 첫 계정 만들기: 이 컴퓨터(loopback)에서만 가능
    - history 기반 주소: `/papers/<id>`
  - `src/features/paper/`
    - `PapersPage`: 목록·생성
    - `PaperPage`: 탭 구상·개요 / 자료 / 원고 / 버전
    - `StoryOutlineTab`
      - 스토리·개요를 손으로 작성
      - 화면에 보이는 버전의 hash로 명시 승인
      - 비어 있는 필수 항목을 표시
    - `EvidenceTab`
      - 근거(방법·실험 기록)와 사실 입력
      - 숫자는 원문 그대로 입력
      - 각각 명시적으로 검증
    - `ManuscriptTab`
      - Tiptap 편집기
      - 명시 저장(버튼, Ctrl/Cmd+S)
      - 서버가 화면 내용 그대로 저장했을 때만 "저장됨"
      - 실패·충돌은 미저장 상태를 유지
      - 미저장 상태로 페이지를 떠나면 확인을 묻는다
    - `save-state.ts`: 저장 상태 기계(단위 시험)
    - `editor-extensions.ts`: Tiptap을 editor-core schema와 같게 구성
      - paragraph·heading에 UUID block id를 붙인다. 분할·붙여넣기로 id가 중복되면 새 id를 준다.
      - mark 4종, inline atom 3종
      - 편집기가 모르는 요소(예: 표)가 있으면 읽기 전용으로 열어 손실을 막는다.
    - `SnapshotsTab`: 이름 붙인 스냅샷과, 스냅샷이 고정한 story/outline 표시
- **서버**
  - `apps/api/src/routes/revisions/index.ts`: 원고 저장 시 editor-core `validateDocument`로 검사(PW-012 이월). 거부하면 422와 `errors`를 돌려준다.
  - `packages/domain/src/shared/db.ts`: `DomainError`의 parameter property를 제거했다. **PW-008 이후 `pnpm --filter @pw/api dev`(node strip-types)가 시작조차 안 되던 결함**이다. 시험이 모두 vitest(변환 실행)라서 드러나지 않았고, 실제 실행 smoke에서 발견했다. 재발 방지 시험을 추가했다.
  - `packages/editor-core/src/schema.ts`: `doc` 내용을 `block+`에서 `block*`로 바꿨다. 새 원고는 빈 문서로 시작한다.
- **시험**
  - `tests/tasks/PW-014/save-state.test.ts`: 단위 6
  - `tests/tasks/PW-014/runtime-load.test.ts`: API·worker·editor-core가 dev runtime에서 로드되는지
  - `tests/tasks/PW-014/save-route.int.test.ts`: 서버 문서 검증
  - `tests/e2e/manual-paper/{manual-paper.e2e.ts,harness.ts}`: 실제 Chromium, 실제 API, 임시 PostgreSQL, Vite 개발 서버
  - `tests/tasks/PW-009/revisions.int.test.ts`: fixture block id를 `b-1`에서 UUID로 바꿨다(저장 검증 도입에 따름).
- **의존성**(모두 MIT, 2026-09-25 이전 공개)
  - `apps/web`: react·react-dom 19.3.0, @tiptap/* 3.31.3(3.31.4는 14일 미만), vite 8.3.0(dev), @types/react·react-dom 19.3.0
  - root devDep: vite 8.3.0(E2E harness용)
  - `apps/api`: @pw/editor-core
  - `pnpm.overrides`: 하위 의존성 중 14일 미만인 것을 이전 버전으로 고정
    - fast-equals 5.4.3
    - prosemirror-changeset 2.4.3, prosemirror-history 1.5.0, prosemirror-view 1.42.5
    - @tiptap/extension-bubble-menu·floating-menu 3.31.3
  - prosemirror-model 1.25.12와 prosemirror-transform 1.12.2는 editor-core와 같은 버전으로 통일했다.
  - Vite React plugin은 쓰지 않는다. Vite 8이 JSX를 자체 변환한다.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-014-A 브라우저 재접속 후 원고·승인·근거·snapshot 재현 | TST-014A(E2E): 화면 조작으로 근거 추가·검증 → 사실(2.4 fold, 그룹·비교·n) 추가·검증 → 스토리 작성·승인 → 개요(근거 연결) 작성·승인 → 원고 두 문단 입력, 저장 전 "저장됨" 아님 → 저장 후 "저장됨" → 스냅샷 생성. **새 브라우저 context**(쿠키·로컬 상태 없음)로 다시 로그인한 뒤 원고 두 문단, 저장됨, 스토리·개요 APPROVED, 핵심 메시지, 근거·사실 VERIFIED와 값, 스냅샷과 고정 story를 확인 | pass |
| REQ-014-B DB 실패 시 저장됨 미표시, 미저장 상태 유지 | TST-014B(E2E): DB에 trigger를 넣어 원고 INSERT를 실제로 실패시킨다. 저장하면 "저장 실패 — 저장되지 않았습니다", "저장됨" 아님, 텍스트 유지, 떠날 때 beforeunload 확인. DB가 회복되면 같은 텍스트가 저장되고 새로고침 후에도 유지. 단위: 늦은 응답, 저장 중 입력, 충돌, 재시도 | pass |
| 보강 | 서버 저장 검증(중복 id·HTML·비UUID·버전 불일치 422, 빈 문서 허용); dev runtime 로드 | pass |

- RED
  - 단위: 모듈 없이 실패(`red-unit.log`)
  - 저장 검증: 중복 id 201 → 기대 422(`red-int.log`)
  - runtime 로드: 수정 전 API·worker 로드 실패(`red-runtime.log`)
  - **E2E는 UI보다 먼저 작성했지만, UI 작성 전에 실행해 RED를 기록하지는 않았다(TDD 증거 부족).** 대신 아래 mutation으로 시험의 탐지력을 확인했다.
- E2E mutation 3종 모두 탐지
  - 저장 실패를 "저장됨"으로 표시 → TST-014B 실패
  - 서버에 보내지 않고 저장 처리 → TST-014A/B 실패
  - beforeunload 제거 → TST-014B 실패
- GREEN
  - E2E 2/2(`e2e.log`). 화면 증거: `screens/1-manuscript-saved.png`, `2-new-session-plan-approved.png`, `3-new-session-snapshot.png`, `4-db-failure-not-saved.png`(합성 데이터)
  - 단위 9, 통합 1
- 실제 실행 smoke
  - `node --experimental-strip-types apps/api/src/index.ts`(PW_DATABASE_URL=pw_dev)와 `vite`를 띄웠다.
  - `/api/health`가 proxy를 통해 200, 익명 세션은 401
- 회귀: `pnpm test` exit 0
  - unit 61, integration 130, contracts 13, e2e 3, spikes 70
  - evals PASS, pack-check PASS

## 사용 방법 (개인 PC / 연구실 서버, 같은 Linux 계정, sudo 없음)
```sh
pnpm install
sh infra/dev/pg-dev.sh start          # 출력된 export 두 줄을 실행 (PW_DATABASE_URL 등)
node --experimental-strip-types apps/api/src/index.ts   # API: 127.0.0.1:8787, migration 자동 적용
pnpm --filter @pw/web dev             # 웹: http://127.0.0.1:5173 (처음이면 "계정 만들기")
```
연구실 서버는 원격에서 열지 말고 `ssh -L 5173:127.0.0.1:5173 서버` 터널로 접속한다.
- 웹 hash 계산에 쓰는 WebCrypto는 https나 localhost에서만 동작한다.
- 계정 만들기는 loopback에서만 가능하다.

## 보안·과학적 실패 경로
- 저장 표시가 거짓말하지 않는다. 서버 ack와 버전 일치가 있어야 "저장됨"이고, 실패·충돌은 화면에서 지워지지 않는다.
- 서버가 원고 JSON을 공유 schema로 검사하므로 raw HTML·모르는 노드·중복 id를 저장할 수 없다.
- 승인과 검증은 화면에 보이는 버전의 hash로만 한다. 숫자는 원문 텍스트 그대로다.
- 편집기가 모르는 요소가 있는 원고는 읽기 전용으로 열어 손실을 막는다.

## 미실행 / 남은 위험 / 이월
- **한글 IME 조합, 다중 탭 충돌 UI, 붙여넣기 U+FFFC 정리, 접근성(키보드·스크린리더), 1366×768 배치는 미검증이다.** PW-015/022에서 한다.
- **자동 저장과 브라우저 임시 복구 저장은 없다.** 현재는 명시 저장과 떠날 때 확인뿐이다.
- **표 편집, 인용·그림 atom 생성 UI는 없다.** 표시와 보존만 한다(P04).
- **그림·표·문헌 근거는 asset·reference API가 없어 입력할 수 없다(P04).**
- **운영 배포 구성은 P07이다.** build 결과 정적 제공, https, runtime DB role이 여기에 속한다.
- **AI 초안 요청과 job 연결, 승인 함수의 pw.actor 설정은 P02로 이월한다.**

## 다음
P01 gate(사용자 승인). `reports/phases/P01_GATE.md`
