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
      - paragraph·heading에 UUID block id를 붙인다. ~~id가 중복되면 새 id를 준다~~ — **최초 커밋에서는 원본이 id를 잃었다**(리뷰 M4). 수정 후: 기존 블록이 id를 유지하고 복사본만 새 id를 받는다.
      - mark 4종, inline atom 3종
      - ~~편집기가 모르는 요소(예: 표)가 있으면 읽기 전용으로 열어 손실을 막는다.~~ **최초 커밋에서는 거짓이었다**(리뷰 M1: 빈 편집기로 열리고, 저장하면 덮어썼다). 수정 후에는 저장된 JSON을 그대로 보여 주고 저장할 수 없다.
    - `SnapshotsTab`: 이름 붙인 스냅샷과, 스냅샷이 고정한 story/outline 표시
- **서버**
  - 원고 저장 시 editor-core `validateDocument`로 검사(PW-012 이월). 거부하면 422와 `errors`를 돌려준다.
    - 처음에는 route(`apps/api/src/routes/revisions/index.ts`)에 두었다가, 리뷰 후 domain `saveRevision`으로 옮겼다(아래).
    - 복원(restore)은 이미 검증되어 저장된 내용을 복사하므로 다시 검사하지 않는다.
  - `packages/domain/src/shared/db.ts`: `DomainError`의 parameter property를 제거했다. **PW-008 이후 `pnpm --filter @pw/api dev`(node strip-types)가 시작조차 안 되던 결함**이다. 시험이 모두 vitest(변환 실행)라서 드러나지 않았고, 실제 실행 smoke에서 발견했다. 재발 방지 시험을 추가했다.
  - `packages/editor-core/src/schema.ts`: `doc` 내용을 `block+`에서 `block*`로 바꿨다. 새 원고는 빈 문서로 시작한다.
- **시험**
  - `tests/tasks/PW-014/save-state.test.ts`: 단위 6
  - `tests/tasks/PW-014/runtime-load.test.ts`: API·worker·editor-core가 dev runtime에서 로드되는지
  - `tests/tasks/PW-014/save-route.int.test.ts`: 서버 문서 검증
  - `tests/e2e/manual-paper/{manual-paper.e2e.ts,harness.ts}`: 실제 Chromium, 실제 API, 임시 PostgreSQL, Vite 개발 서버
  - `tests/tasks/PW-009/revisions.int.test.ts`: fixture block id를 `b-1`에서 UUID로 바꿨다(저장 검증 도입에 따름).
- **의존성**(모두 MIT; "모두 14일 이상"이라는 최초 기재는 prosemirror-transform 1.12.2가 13.4일이라 부정확했다. 리뷰 후 전체 lockfile 기준으로 정정, 아래 참고)
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
- 승인과 검증은 화면에 보이는 버전의 hash로만 한다. 숫자는 원문 텍스트 그대로다. (**최초 커밋에서는 거짓이었다**: 리뷰 M3에서 화면과 저장본이 다를 때 저장본을 승인했다. 수정 후 그 경우 승인 버튼이 비활성화된다.)
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

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 4, minor 9). 모두 수정했다.
- 회귀 시험
  - 브라우저 `tests/e2e/manual-paper/review-fixes.e2e.ts` 9건
  - 단위 `tests/tasks/PW-014/block-ids.test.ts` 5건
- RED: 수정 전 웹 앱(커밋본)에서 M1·M2·M3·n 시험 4건이 지적 그대로 실패했다(`review-red-e2e.log`).
  - 첫 실행은 웹 앱이 리팩터링 중이라 페이지가 열리지 않아 무효였고, 커밋본으로 다시 돌렸다.
  - block-id 시험의 RED는 모듈 부재로 인한 import 실패뿐이다(의미 있는 RED 아님).

| 지적 | 조치 |
|---|---|
| **M1 표가 있는 원고가 빈 편집기로 열리고, 저장하면 덮어씀** | 편집기가 모르는 요소가 있거나 내용 검사가 실패하면 저장된 JSON을 텍스트로만 그려 읽기 전용으로 연다. 저장 버튼과 Ctrl+S 없음. E2E: 표 내용이 보이고, Ctrl+S 후에도 head가 그대로 |
| **M2 탭 이동·홈·로그아웃 시 미저장 원고 소실** | 연 탭은 숨김으로 유지(unmount 안 함). 앱 전역에 미저장 등록부를 두고, 홈 이동·로그아웃·페이지 닫기 전에 확인한다. 스토리·개요 폼도 등록. E2E |
| **M3 승인 버튼이 화면이 아닌 저장본을 승인하고 화면 편집을 버림** | 화면 내용이 저장본과 다르면 승인 비활성 + "저장한 뒤 승인". 서버 응답은 사용자가 손대지 않은 부분만 덮어쓴다(첫 로드 전·저장 중 입력 보존). E2E 3건. 고치는 중에 새로 생긴 경쟁 조건(첫 로드가 입력을 덮어씀)도 E2E로 잡아 고쳤다 |
| **M4 붙여넣기·제목 변환 시 block id 이동** | `block-ids.ts` `reconcileBlockIds`: 변경 전 블록 위치를 mapping으로 따라가 그 블록이 id를 유지한다(setBlockType처럼 attr이 사라져도). 복사본·새 블록만 새 id. 단위 5건: 위·아래 붙여넣기, 여러 블록 제목 변환, 분할, id 없음·삭제 |
| m1 붙여넣은 atom 속성 소실 | atom 속성을 data-* 속성으로 parse/render(DOM setAttribute라 markup 주입 없음). E2E: 붙여넣은 인용의 referenceId·locator 저장 |
| m2 충돌 문구에 "저장됨" 포함 | 문구 변경. E2E는 정확히 '저장됨'을 비교 |
| m3 같은 tick에서 입력+Ctrl+S 시 "저장 중" 고착 | 편집 버전을 ref로 동기 증가, saveStart가 보낸 버전을 지닌다 |
| m4 Ctrl+S 전역 | 편집기 영역에 focus가 있을 때만 |
| m5 n 비정수 무음 누락 | 클라이언트에서 거부하고 오류 표시. E2E |
| m6 의존성 나이 | prosemirror-transform을 1.12.1로 낮춤(editor-core 포함). 전체 lockfile(270개)을 감사해 14일 미만 29개를 overrides로 이전 버전에 고정: rolldown 1.2.11, postcss 8.5.28, pg-protocol 1.16.0, pino 10.3.1 등. 재감사 결과 0개, 전체 시험 통과 |
| m7 dev server가 저장소 파일 제공 | `server.fs.strict` + allow(웹 앱, editor-core, node_modules), .env·키 파일 거부. (**재리뷰: pnpm 링크 `node_modules/.pnpm/node_modules/@pw/*`로 우회 가능했고, deny 지정이 Vite 기본 deny를 덮어썼다.** 아래에서 수정) E2E: CLAUDE.md·PROGRESS.md·서버 소스·.env.example 403. **공유 서버의 다른 로컬 사용자가 127.0.0.1:5173에 접근하는 위험과, proxy 경유 첫 계정 생성 위험**은 gate 위험 목록에 기록 |
| m8 범위·검증 위치 | 원고 검증을 domain `saveRevision`으로 옮겨 모든 저장 경로에 적용(route 중복 검사 제거). 범위 밖 변경은 RFC-006 부록과 gate에서 확인 요청 |
| m9 빈 문서·옛 id의 화면/저장 차이 | 기록만 한다. 빈 문서는 빈 문단 하나로 보이고, 내용 차이는 없다. 비UUID id는 이제 서버가 저장을 거부하므로 생길 수 없다 |

- 실행
  - 브라우저 11/11(`e2e.log`). 반복 실행에서 8개 시험을 3회 돌려 24/24
  - `pnpm test` exit 0: unit 66, integration 130, contracts 13, e2e 11, spikes 70, evals/pack PASS

## 재리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 2, minor 8).
- 회귀 시험
  - 브라우저 `tests/e2e/manual-paper/rereview-fixes.e2e.ts` 7건
  - 단위 block-id 1건
- RED: 수정 전 6건 실패(`rereview-red-e2e.log`).
  - "단락 처음에서 Enter" 브라우저 시험은 수정 전에도 통과했다(Tiptap이 실제 Enter를 다르게 처리한다). 대신 단위 시험(`tr.split`)이 수정 전 실패를 보였다.

| 지적 | 조치 |
|---|---|
| **MA1 브라우저 뒤로 가기가 미저장 내용을 묻지 않고 버림** | router의 popstate에서 미저장 등록부를 확인한다. 머무르기를 고르면 원래 주소를 다시 넣는다. E2E: `goBack()` → 확인 창, 취소하면 주소와 텍스트 유지 |
| **MA2 끝 줄바꿈·앞 공백이 있는 한계 항목 때문에 저장 후에도 "미저장" → 승인 영구 불가** | 화면 비교와 서버 데이터 병합을 실제 전송 payload(정리된 목록) 기준으로 한다. E2E: `' small n\n\n'` 저장 → 승인 가능, 홈 이동 시 확인 창 없음 |
| m1 Vite 차단 우회(pnpm 링크), 기본 deny 소실 | Vite 기본 deny(.git, .npmrc, 키 파일 등)를 유지하고 `**/node_modules/.pnpm/node_modules/@pw/**`, `**/node_modules/@pw/**`를 추가. E2E: pnpm 링크 경로와 .git/config가 원문·`?raw` 모두 403. 존재하지 않는 파일은 앱 페이지로 대체되므로 시험 대상에서 뺐다 |
| m2 단락 처음에서 split하면 id가 빈 블록으로 이동 | 블록 시작이 아니라 블록 안 첫 위치를 추적한다. 단위 시험 추가, 기존 5건 유지 |
| m3 `ignore` override가 eslint의 ^5 범위를 깸 | `@typescript-eslint/eslint-plugin>ignore`로 범위를 좁혔다(eslint는 5.3.2, 2024-08) |
| m4 다른 schema_version 원고가 편집 가능하게 열림 | 현재 버전이 아니면 읽기 전용(변환 필요 표시). E2E |
| m5 다른 곳에서 먼저 저장(409)한 뒤 최신본을 불러올 방법 없음 | 오류 옆에 "최신 스토리 불러오기"(화면 변경을 버린다는 확인 후 강제 로드). E2E |
| m6 근거·사실 입력 중 텍스트가 미저장 등록부에 없음 | 등록한다. E2E: 근거 메모 입력 후 홈 이동 시 확인 |
| m7 코드 nit | 주석 정정. 문서가 바뀐 transaction에서만 reconcile하고, reconciler가 설치되지 않으면 오류. 새 개요 첫 행은 논문마다 새 node id |
| m8 보고서 정확도 | 위 변경 파일·m7 항목 정정. "모든 저장 경로" 문구에 restore 예외를 명시 |

- 실행
  - 브라우저 18/18(`e2e.log`). 전체 2회 반복 36/36. 충돌 시험 8회 반복 8/8. 최초 실행에서 충돌 시험 1건이 시험 자체의 타이밍 문제로 실패했다(다른 창이 로드 중에 입력). 로드를 기다리도록 고쳤다.
  - `pnpm test` exit 0: unit 67, integration 130, contracts 13, e2e 18, spikes 70, evals/pack PASS
