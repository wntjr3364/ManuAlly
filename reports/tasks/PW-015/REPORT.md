# PW-015 — 에디터·자동저장·IME — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- 새 파일 (`apps/web/src/editor/`)
  - `autosave.ts`: 자동 저장 제어기(React와 무관, fake timer로 시험)
  - `recovery.ts`: 브라우저 임시 복구본(계정·문서별, 7일, 설정, 로그아웃 시 삭제)
  - `patch-gate.ts`: 키보드 밖 변경(AI patch 등)의 관문. IME 조합 중이면 거부한다.
  - `ManuscriptEditor.tsx`: 원고 편집기(PW-014 편집기를 옮겨 확장)
  - `ReadOnlyDocument.tsx`: 저장 JSON을 텍스트로만 표시(HTML 없음)
- 새 파일 (`apps/api/src/documents/index.ts`)
  - `POST /api/papers/:paperId/documents/:documentId/saves`: 편집기 저장
  - 응답을 잃어 같은 요청을 다시 보내면, 이미 저장된 revision으로 답한다(200, `replayed: true`).
- 범위 밖 연결 지점(RFC-007 부록)
  - `ManuscriptTab.tsx`, `App.tsx`, `styles.css`, `server.ts`
  - `packages/config/{test-patterns.ts,playwright.config.ts}`
- 시험: `tests/tasks/PW-015/`
  - `autosave.test.ts` 19, `recovery.test.ts` 12, `patch-gate.test.ts` 3
  - `saves-route.int.test.ts` 9
  - `editor.e2e.ts` 15
- DB migration: 없음. 기존 `document_revisions.reason`의 `autosave`를 쓴다.

## 동작
- **자동 저장**
  - 입력이 1.5초 멈추면 저장한다. 계속 입력해도 10초마다 저장한다.
    - 한글 조합 중에 10초가 되면, 조합이 끝나는 즉시 저장한다(리뷰 4).
  - 요청은 한 번에 하나만 보낸다.
  - 저장된 내용으로 되돌아간 경우는 새 revision을 만들지 않는다.
  - 저장 버튼과 Ctrl/Cmd+S는 즉시 저장이다(reason `manual`).
    - 조합 중에 누르면 조합이 끝나는 즉시 저장한다.
- **"저장됨" 표시**
  - 서버가 화면과 같은 내용을 저장했다고 답한 뒤에만 표시한다(PW-014 save-state 규칙).
  - 실패·오프라인·충돌은 "저장 실패/저장되지 않았습니다"로 표시한다.
- **실패 처리**
  - 네트워크 오류와 5xx는 같은 요청을 그대로 다시 보낸다. 간격은 2·4·8·15·30초다.
    - 그동안 입력이 멈춰도 일찍 다시 보내지 않는다.
    - 브라우저가 online이 되면 즉시 다시 보낸다.
  - 409 충돌이면 자동 저장을 멈춘다. 덮어쓰지 않는다.
  - 새 저장이 422(형식 오류)·401 등으로 거부되면 다음 입력이나 저장 버튼까지 다시 보내지 않는다.
  - 응답을 잃은 요청을 다시 보냈는데 거부되면(예: 로그인 만료) 그 요청을 버리지 않는다(리뷰 MAJOR-1).
    - 저장 버튼이나 네트워크 복구 때 같은 요청을 다시 보낸다.
    - 그동안 서버에 무엇이 있는지 모르므로 "저장됨"으로 바꾸는 지름길을 쓰지 않는다.
  - 401·403이면 세션의 CSRF token을 다시 받아 한 번 더 보낸다(다른 탭에서 다시 로그인한 경우). 안 되면 "로그인이 만료되었습니다"를 표시한다.
  - 보류된 동안 상태는 "저장 중단"이다(재리뷰 3).
    - 입력해도 평범한 "저장 안 됨"으로 바뀌지 않는다.
    - 창이 다시 focus되거나 보이게 되면 한 번 더 보낸다.
    - 보류될 때 대기 중이던 저장 요청은 버린다.
- **응답 유실**
  - 서버는 아래 조건이 모두 맞을 때만 "이미 저장됨"으로 답한다. 나머지는 모두 409다.
    - 현재 head가 같은 owner의 편집기 저장(autosave/manual)이다.
    - head가 요청의 expected head 바로 다음 revision이다.
    - 내용 hash와 schema version이 같다.
- **IME**
  - 조합 중에는 저장하지 않는다(Ctrl+S 포함). 조합이 끝나면 저장한다.
  - 조합 중에는 바깥 변경(`applyExternalPatch`)을 거부한다(`COMPOSING`). PW-017 apply는 이 관문을 써야 한다.
- **서식 버튼**
  - 마우스로 눌러도 초점과 선택이 본문에 남는다.
  - 고치기 전에는 버튼을 누른 직후의 Space가 버튼을 다시 눌러 서식이 풀리고 글자가 사라졌다. TST-015A 브라우저 시험이 처음 실행에서 이 결함을 잡았다.
- **임시 복구본**
  - 저장되지 않은 변경은 이 브라우저 localStorage에 계정·문서·**탭**별로 보관한다(0.4초 지연, 리뷰 3).
    - 탭은 서로의 복구본을 덮어쓰거나 지우지 않는다.
    - 각 탭은 자기 id 이름의 Web Lock을 페이지가 살아 있는 동안 쥔다(재리뷰 1·2).
      - 브라우저가 탭을 닫거나 비정상 종료할 때 lock을 풀어 준다. 백그라운드 timer 지연과 무관하다.
      - 다른 탭은 lock을 쥔 탭의 복구본을 제안하지도 지우지도 않는다.
      - 복제된 탭은 원래 탭이 열려 있으면 lock을 얻지 못하므로 새 id를 받는다.
      - 새로고침이나 비정상 종료 뒤 다시 열면 같은 id를 되찾아 자기 복구본을 바로 제안한다.
    - Web Locks가 없는 브라우저에서는 다른 탭의 복구본을 제안하지 않는다(열려 있는지 알 수 없으므로).
  - 보관 기간은 7일이다. 만료되었거나 문서 형식이 잘못된 항목은 버린다.
  - 화면 내용이 모두 저장되면 이 탭의 복구본을 지우고, 대기 중인 복구본 쓰기도 취소한다(리뷰 2).
  - 저장 중 새 입력이 있으면 새 head 기준으로 다시 쓴다.
  - 다시 열 때:
    - 복구본이 여러 개면 이 탭 것 먼저, 그다음 최신순으로 하나씩 묻는다.
    - 편집을 막는 경우는 이 탭 자신의 복구본이 결정을 기다릴 때뿐이다(입력하면 그 복구본을 덮어쓰므로, 재리뷰 nit 2).
    - 복구본의 기준 revision이 현재 화면의 revision과 같고 미저장 내용이 없으면 "복구본 불러오기/버리기"를 묻는다.
    - 그 밖에는 복구본을 읽기 전용으로 보여 주고 복사하게 한다. 자동으로 합치지 않는다.
  - 원고 아래에 설정(켜기/끄기)이 있다. 끄면 그 계정의 복구본을 지운다.
  - 로그아웃하면 이 브라우저의 모든 복구본과 설정을 지운다.
  - 로그인하면 다른 계정의 복구본과 설정을 지운다(리뷰 8).
  - 다른 탭에서 로그아웃하면 열린 편집기도 그 즉시 복구본을 지우고 더 쓰지 않는다(storage 이벤트, 재리뷰 4).
  - 저장 공간 부족은 화면에 알린다.
  - 브라우저가 사이트 저장소를 막으면 "임시 보관할 수 없습니다"를 표시한다(리뷰 7).

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-015-A / TST-015A 한글 조합·italic·sub/superscript·인용 저장/복구 | e2e "Korean IME, italic, sub/superscript and a citation…": CDP IME로 한→글 조합, 기울임·아래·위첨자, 인용 붙여넣기 → 자동 저장 → DB JSON 확인 → 새로고침 후 표시 확인. 조합 중 jamo가 저장되지 않음 |
| | e2e 복구 3건: 복구본 불러오기 후 저장 / 오래된 복구본은 복사용 표시 / 로그아웃 삭제·설정 끔 |
| | e2e "Korean composition inside a paragraph keeps the paragraph id" |
| | unit `recovery.test.ts` 9: 왕복(한글·서식·인용), 계정·문서 분리, 만료, 잘못된 항목 폐기, 다른 계정 항목 거부, 공간 부족, 설정, 로그아웃, 저장소 예외 |
| REQ-015-B / TST-015B 조합 중 AI patch 적용 금지 | e2e "an outside patch is refused while composing": 실제 조합 중 `COMPOSING` 거부, 조합 후 적용 |
| | unit `patch-gate.test.ts` 3 |
| REQ-015-B / TST-015B 실패한 저장을 성공으로 표시하지 않음 | e2e "failing save": DB 실패 중 상태 기록에 "저장됨" 없음, revision 없음, 복구 후 1회만 저장 |
| | e2e "offline" |
| | e2e "answer was lost": 응답 유실 → 같은 요청 재전송 → 중복 revision 없음, 충돌 표시 없음 |
| | unit `autosave.test.ts` 11 |
| | integration `saves-route.int.test.ts` 9: 신규 201, 재전송 200, 다른 내용·다른 부모·restore head는 409, reason, 422, 다른 owner 404, CSRF 403 |

## RED → GREEN
- RED
  - unit·integration(구현 전): 모듈 없음 3 파일, route 404로 6건 실패(`red.log`)
  - 브라우저(PW-015 이전 앱 코드, 시험만 새것): 9건 중 8건 실패(`red-e2e.log`)
  - 통과한 1건은 "조합 중 단락 id 유지"다. PW-014의 id 처리로 이미 되던 동작이라 회귀 시험으로 둔다.
- GREEN
  - unit 23/23, integration 9/9, 브라우저 9/9
- mutation 14개 모두 탐지(`mutation.log`)
  - 조합 검사 제거(제어기·편집기 연결), 재전송 대신 현재 내용 전송, 서버 replay 제거(통합·브라우저)
  - replay의 부모 검사 제거(처음에는 살아남음 → A→B→A 시험 추가 후 탐지)
  - replay가 restore revision 허용, patch 관문 조합 검사 제거, 로그아웃 시 미삭제, 저장 후 복구본 유지
  - 오래된 복구본을 병합 제안, 보관 기간 없음, 5xx를 성공 처리, 서식 버튼 초점 탈취
- 회귀: `pnpm test` exit 0(`pnpm-test.log`)
  - typecheck·lint
  - unit 94, integration 139, contracts 13, e2e 34(PW-014 25 포함), spikes 70
  - evals/pack PASS
- 화면 증거(합성 데이터): `screens/1-ime-marks-citation-reloaded.png`, `2-save-failed.png`, `3-recovery-offer.png`

## 보안·과학적 실패 경로
- 원고 정본은 서버 revision이다. 복구본은 사용자가 고른 경우에만 화면에 올라가고, 다시 서버 저장 규칙(검증·expected head)을 거친다.
- 오래된 복구본은 자동으로 합치지 않는다. 다른 곳의 변경을 조용히 덮어쓰지 않는다.
- 복구본은 브라우저 localStorage에 **평문**으로 남는다.
  - 공유 PC를 위해 로그아웃 시 삭제하고 끌 수 있게 했다.
  - 로그아웃 없이 세션이 만료되면 7일 동안, 또는 다른 계정이 로그인할 때까지 남는다.
- 다른 계정의 복구본은 표시하지 않는다(키와 내용 모두 계정 확인).
- 복구본의 형식은 editor-core로 다시 검증한다.
- 서버 replay는 내용 hash·부모·작성자·reason이 모두 맞을 때만 성공으로 답한다.
- 시험용 handle(`window.__pwManuscript`)은 Vite 개발 모드이면서 `__PW_TEST_HOOKS__`가 켜진 경우에만 생긴다. 운영 build에는 없다.

## 미실행 / 남은 위험
- **실제 한글 IME(ibus/fcitx, macOS·Windows 입력기)와 Firefox/Safari는 시험하지 않았다.**
  - 브라우저 시험은 Chromium에서 CDP로 조합 이벤트를 만든다.
  - 사용자 PC에서 수동 확인이 필요하다(PW-022 브라우저 gate).
- 인용 **입력 UI**는 아직 없다.
  - 현재는 붙여넣기와 저장된 인용 보존만 된다.
  - 문헌 선택 삽입은 PW-019(인용 노드)·P04(문헌)에서 한다.
- 자동 저장마다 불변 revision이 생긴다(최대 10초에 1개, 내용이 같으면 생략).
  - 긴 작업에서는 revision이 많이 쌓인다.
  - 버전 비교 화면(PW-021)에서 묶어 보여 주거나, 보존 정책(P07)이 필요하다.
- 기존 `POST .../revisions`는 replay 규칙 없이 남아 있다. 편집기는 쓰지 않는다.
- 여러 탭에서 같은 원고를 편집하면 뒤에 저장하는 탭이 충돌(409)로 멈춘다.
  - 내용은 그 탭의 복구본에 남는다(탭별 복구본, 브라우저 시험으로 확인).
  - 자동 병합은 v1 범위 밖이다(spec 04 STALE 원칙).
- 탭 id를 받기 전(페이지 로드 직후 수 ms)에는 편집기를 잠근다.
- Web Locks가 없는 환경에서는 다른 탭이 남긴 복구본을 이 탭에서 볼 수 없다. 7일 뒤 만료된다.
  - 지원 브라우저: Chromium·Firefox·Safari 최신판. 시험은 Chromium만 했다.
- focus·visibility 복귀 시 보류 요청 재전송은 unit으로만 확인했다. 브라우저 이벤트 연결은 시험하지 않았다.
- 복구본 설정 기본값은 **켜짐**이다.
  - spec 04의 "명시 설정"을 화면의 설정 상자로 충족한다고 판단했다.
  - 개인 PC·연구실 계정에서 입력 유실을 막는 쪽을 택했다.
  - P02 gate에서 사용자 확인이 필요하다.

## 다음
- 독립 리뷰를 받은 뒤 PW-016(선택 도구·짧은 채팅)으로 간다.
- PW-016/017 전에 RFC-003(개요 승인 전 보수적 교정 허용)을 사용자에게 확인한다.

## 독립 리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(major 1, minor 7, nit 3). 리뷰어가 probe로 재현했다.
- 서버 replay 규칙, CSRF·owner 격리, 복구본 표시(XSS 없음), 시험 handle의 운영 제외는 문제없다고 확인했다.

| 지적 | 조치 |
|---|---|
| **MAJOR-1 응답 유실 → 재전송이 401 → 원래 글로 되돌리면 "저장됨"(서버는 다른 내용)** | 재전송이 거부되어도 그 요청을 보류로 남긴다. 결과를 모르는 동안 "저장됨" 지름길을 쓰지 않는다. 저장 버튼·네트워크 복구 때 같은 요청을 다시 보낸다. unit 시험 |
| m2 빠른 Ctrl+S 뒤 대기 중이던 복구본 쓰기가 저장된 글을 다시 남김 | 모두 저장되면 대기 중인 쓰기를 취소한다. 브라우저 시험 |
| m3 탭끼리 복구본을 덮어쓰고 지움(보고서 문구도 틀림) | 탭별 복구본과 열린 탭 표시. 브라우저 시험(두 탭 + 세 번째 탭), unit 3건. 보고서 정정 |
| m4 한글을 계속 입력하면 10초 최대 대기가 동작하지 않음 | 조합 때문에 미룬 최대 대기·수동 저장은 조합이 끝나는 즉시 실행한다. unit 2건 |
| m5 재시도 대기 중 Ctrl+S마다 재시도 timer가 늘어남 | 보내기 전에 재시도 timer를 지운다. unit 시험 |
| m6 거부된 뒤 저장 버튼이 아무것도 안 함, 재로그인 안내 없음 | 저장 버튼은 다시 보낸다. 401·403이면 세션 token을 새로 받아 한 번 더 보내고, 안 되면 재로그인을 안내한다. unit 시험 |
| m7 저장소 차단을 알리지 않음(보고서와 다름) | 쓰기·읽기 확인(`storageWorks`) 후 안내를 표시한다. 브라우저 시험, unit 시험 |
| m8 복구본 기본 켜짐, 공유 기기 잔류 | 로그인 시 다른 계정의 복구본을 지운다. 브라우저·unit 시험. 기본값은 P02 gate에서 사용자 확인 |
| nit: 아무것도 안 보낸 수동 저장 뒤 다음 자동 저장이 `manual`로 기록 | reason을 요청과 함께 만든다(`SaveRequest.manual`). unit 시험 |
| nit: 조합 중 Ctrl+S가 1.5초 지연 저장이 됨 | 조합이 끝나는 즉시 저장. unit 시험 |
| nit: 시험 실행이 `reports/` 스크린샷을 덮어씀 | `PW_SAVE_EVIDENCE=1`일 때만 저장한다 |

- 추가 발견: 커밋 d6080be에 넣은 RFC-007에 `User decision / reviewer` 항목이 없었다.
  - PW-006 RFC 형식 시험이 실패한다. **d6080be는 `pnpm test`가 실패한 상태로 push되었다.**
  - 원인: 마지막 전체 실행 뒤에 RFC를 작성했다.
  - 항목을 추가해 고쳤다.
- 저장된 내용의 비교 기준을 편집기의 첫 JSON이 아니라 저장된 revision 자체로 바꿨다.
  - 빈 원고는 편집기에서 빈 단락 하나로 열린다. 그래서 둘이 다를 수 있다.
- RED: 리뷰 시험을 d6080be의 앱 코드로 실행했다.
  - unit 6건, 브라우저 3건 실패(`review-red.log`)
  - 리뷰 4·5 시험은 처음 설계로는 이전 코드에서도 통과했다. 리뷰어가 보고한 조건대로 고친 뒤 이전 autosave에서 실패를 확인했다(`review-red-4-5.log`).
- mutation: 리뷰 수정 10개 중 9개 탐지(`mutation.log`)
  - 살아남은 1개("결과를 모르는 동안 저장 기준 유지")는 지금 구조에서 관찰할 수 없다. 보류된 재전송이 항상 먼저 실행되기 때문이다. 이중 안전장치로 남겼다.
- 실행
  - PW-015: unit 32, 통합 9, 브라우저 13
  - `pnpm test` exit 0: unit 103, integration 139, contracts 13, e2e 38, spikes 70, evals/pack PASS

## 재리뷰 결과 반영 (2026-10-09)
- 결론: changes requested(minor 4, nit 3). MAJOR-1과 이전 minor는 모두 고쳐졌다고 재현 시험으로 확인했다.
- 재리뷰어는 "저장됨"이 서버와 다른 내용에서 표시되는 경로를 더 찾지 못했다.
- CSRF 재요청은 다른 계정으로 저장하거나 반복되지 않는다고 확인했다.

| 지적 | 조치 |
|---|---|
| m1 복제된 탭이 같은 탭 id를 써서 열린 탭의 복구본을 제안·삭제 | heartbeat 대신 Web Lock. 원래 탭이 lock을 쥐고 있으면 복제 탭은 새 id. unit(가짜 Web Locks), 브라우저 시험 |
| m2 백그라운드 탭 timer 지연(15초 창보다 김)으로 열린 탭을 닫힌 것으로 판단 | 같은 Web Lock으로 해결(lock은 timer와 무관). 실제 지연은 headless에서 재현할 수 없어 unit으로 lock 판정만 시험 |
| m3 보류 후 입력하면 실패 표시가 사라지고 자동 저장이 영영 멈춤 | "저장 중단" 상태(입력해도 유지). focus·visible 복귀 시 재전송. unit 시험 |
| m4 다른 탭에서 로그아웃한 뒤 열린 편집기가 복구본을 다시 씀(d6080be부터) | 로그아웃 tab이 알림 key를 쓰고, 다른 탭은 storage 이벤트로 이 페이지의 복구를 끈다. 브라우저 시험 |
| nit 1 보류된 재전송 뒤 대기 중이던 수동 저장이 저절로 실행 | 보류 시 대기 저장을 버린다. unit 시험 |
| nit 2 복구 후에도 다른 복구본이 남으면 편집 잠김 | 이 탭 자신의 복구본이 결정을 기다릴 때만 잠근다. 브라우저 시험 |
| nit 3 비정상 종료 직후 다시 열면 자기 복구본을 바로 못 받음 | Web Lock은 종료와 함께 풀리므로 같은 id를 되찾는다. unit 시험 |

- 범위 밖 변경: `apps/web/src/features/paper/save-state.ts`에 `blocked` 상태를 추가했다(RFC-007 부록).
- 시험 정정 2건
  - 다른 탭 복구본이 편집기를 잠근다고 가정하던 시험을 nit 2 동작에 맞췄다.
  - 탭 id를 비동기로 받기 전에 읽던 시험이 받은 뒤 읽게 했다.
- RED: 4341b61의 앱 코드에서 재리뷰 시험 4건(unit 2, 브라우저 2)이 실패했다(`rereview-red.log`).
- mutation: 재리뷰 수정 7개 모두 탐지(`mutation.log`).
- 실행
  - PW-015: unit 34, 통합 9, 브라우저 15
  - `pnpm test` exit 0: unit 105, integration 139, contracts 13, e2e 40, spikes 70, evals/pack PASS
