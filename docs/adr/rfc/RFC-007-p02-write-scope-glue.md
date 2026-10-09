# RFC-007 — P02 write scope 보완: 기존 화면·서버·시험 설정과의 연결 지점
Status: accepted (delegated) — P02 gate에서 사용자 확인 요청
Trigger task: PW-015
Affected requirements/specs/contracts: REQ-015 이후 P02 Task (write_scope만 변경, 요구사항·인수조건 변경 없음)

Problem and evidence:
- P02 Task의 write scope는 새 기능 폴더만 연다(예: PW-015 `apps/web/src/editor/**`, `apps/api/src/documents/**`).
- 새 기능을 쓰려면 기존 화면과 서버에 연결해야 한다.
  - 원고 탭이 새 편집기를 열어야 한다.
  - 서버에 route를 등록해야 한다.
  - 로그아웃 시 브라우저 복구본을 지워야 한다.
  - Task 폴더의 브라우저 시험이 `pnpm test:e2e`에서 실행되어야 한다.
- 이 연결 파일들은 P01 Task(RFC-006) 소유다.

Proposed change:
- 연결에 필요한 최소 수정만 각 P02 Task 범위에 추가한다.
- 아래 부록에 Task별로 기록한다.
- 동작 변경은 해당 Task 시험과 기존 회귀 시험으로 확인한다.

Alternatives considered:
- 연결하지 않고 새 폴더 안에서만 구현: 사용자가 기능을 쓸 수 없고 E2E로 확인할 수 없다.
- 기존 파일 소유 Task를 다시 열기: 완료된 Task 기록이 섞인다.

Security/privacy/budget/provider terms impact:
- 로그아웃 시 이 브라우저의 원고 복구본을 모두 지운다(spec 04 shared device 요구).

Data migration / backward compatibility:
- 없음. 기존 `POST .../revisions`는 그대로 둔다. 편집기는 새 `POST .../saves`를 쓴다.

Tests and acceptance criteria:
- 각 Task의 TST와 기존 `pnpm test` 전체가 통과해야 한다.
- PW-007 guard(모든 시험 파일이 정확히 한 명령에 속함)가 Task 폴더의 `*.e2e.ts`도 검사한다.

Write scope: 아래 부록의 파일(Task별)

User decision / reviewer:
- 사용자가 P01 gate에서 RFC-006(같은 방식의 P01 연결 지점)을 확정했다(2026-10-09 "해라").
- 이 RFC는 같은 원칙을 P02에 적용한 위임 결정이다. P02 gate에서 사용자 확인을 요청한다.
- PW-015 독립 리뷰가 연결 파일(App.tsx 로그아웃·로그인 정리, ManuscriptTab)을 함께 검토했다.

## 부록 — Task별 연결 지점
- PW-015
  - `apps/web/src/features/paper/ManuscriptTab.tsx`
    - 원고를 불러와 `apps/web/src/editor/ManuscriptEditor.tsx`로 연다.
    - 기존 편집기 본문과 읽기 전용 표시는 `apps/web/src/editor/`로 옮겼다.
  - `apps/web/src/app/App.tsx`
    - 로그인한 계정을 복구 저장소에 알린다.
    - 로그아웃 시 이 브라우저의 복구본을 모두 지운다.
    - 로그인 시 다른 계정의 복구본과 설정을 지운다(PW-015 리뷰 8).
    - 로그아웃을 다른 탭에 알린다(storage 이벤트). 이 탭에서 다시 로그인하면 복구를 다시 켠다(PW-015 재리뷰 4).
    - 다른 탭의 로그아웃 알림을 앱 전체에서 받는다(편집기가 없는 탭 포함, PW-015 최종 확인 nit 2).
  - `apps/web/src/features/paper/save-state.ts`
    - `blocked` 상태 추가(PW-015 재리뷰 3). 입력해도 유지되고, 다시 보내면 해제된다.
    - PW-014 시험은 그대로 통과한다.
  - `apps/web/src/app/styles.css`: 복구 안내 상자 스타일(`.notice`)
  - `apps/api/src/server.ts`: `registerDocumentSaveRoutes` 등록
  - `packages/config/test-patterns.ts`, `packages/config/playwright.config.ts`
    - 브라우저 시험 폴더를 `tests/e2e`에서 `tests`로 넓혔다(`tests/tasks/PW-xxx/*.e2e.ts`).
    - Playwright 설정이 test-patterns의 값을 그대로 쓴다.
- PW-016
  - `apps/web/src/editor/ManuscriptEditor.tsx`
    - FrozenSelection extension 추가
    - SelectionChat 표시(저장 상태·잠금·개요 승인 여부 전달)
    - 개발용 시험 handle `selectText`
  - `apps/web/src/features/paper/{ManuscriptTab,PaperPage}.tsx`: 개요 승인 여부(`active_outline_revision_id`) 전달
  - `apps/web/src/app/styles.css`: 선택 도구·popup·고정 범위 스타일
- PW-017
  - `apps/api/src/server.ts`: `registerProposalRoutes` 등록
  - `apps/web/src/editor/ManuscriptEditor.tsx`: 선택 요청을 서버 handle로 보냄, 제안 패널, 적용 결과 반영(`pw-remote` transaction)과 head 채택, 적용 중 잠금
  - `apps/web/src/editor/autosave.ts`: `adopt()`(화면이 서버의 새 head와 같을 때만)
  - `apps/web/src/features/selection-chat/SelectionChat.tsx`: `onRequest` 결과 표시
  - `apps/web/src/app/styles.css`: diff 표시
- PW-018
  - `apps/api/src/comments/**`(새 route 폴더; Task 범위에 API 경로가 없음)과 `apps/api/src/server.ts` 등록
  - `apps/web/src/editor/ManuscriptEditor.tsx`: 코멘트 패널, 강조 extension, 코멘트 보내기·다시 연결용 선택 고정, 개발용 `moveBlock`
  - `apps/web/src/features/selection-chat/SelectionChat.tsx`: "코멘트" 동작
  - `packages/domain/src/proposals/index.ts`: `verifySelection` 공용화
  - `apps/web/src/app/styles.css`

