# PW-047 — Checkpoint·영구기억 재수화 — REPORT
상태: in_review (2026-10-10)

## 설계
- **checkpoint는 DB 행이다.** 각 경계에서 쓴다: provider 호출 전, 답 검증 후, 제안 저장 후(완료 트랜잭션 안), 세션 교체, maintenance.
  - 호출하는 쪽은 **id만** 준다: 범위(개요 revision·노드·사실·주장·근거·문서·base revision), 완료한 일, 남은 단계, provider 세션, 버전, 마지막 사건.
  - 승인된 객체의 id·hash와 논문의 전송 정책은 서버가 DB에서 읽는다: 활성 승인 스토리, 승인 개요와 노드 승인 hash, 검증된 사실, 승인된 주장, 활성 프로필.
  - 호출하는 쪽이 내용·수치·승인을 넣으면 거부한다(INVALID).
  - **모델 호출이 없다.** 요약이 없어도 만들 수 있다.
  - 예산 예약은 `UNKNOWN`이다(PW-050에서 채움).
- **완료한 일은 지속되는 결과만이다**(예: `proposal_stored:<id>`). 한 번 기록되면 줄어들 수 없다.
  - 잃을 수 있는 진행(계약 생성, 검증된 답)은 `last_event`로만 남는다.
  - 그래서 잃어버린 실행 뒤의 새 세션은 provider를 다시 부른다. "완료"를 믿고 건너뛰지 않는다(mutation 발견에서 바로잡음, 아래).
- **쓰기는 현재 fencing token을 가진 실행만** 한다. 행은 바뀌지 않는다(immutable trigger).
- **요약(`summary`)은 ai 또는 user가 쓴 메모다.** 재수화 결과에서 `trusted: false`로만 나온다. 요약은 승인·사실·완료한 일·남은 단계 어디에도 영향이 없다.
- **재수화(`rehydrate`)** 는 마지막 checkpoint를 읽은 뒤 정본을 다시 확인한다.
  - context에는 그 checkpoint가 가리킨 스토리, 노드, 사실, 주장을 DB에서 다시 읽어 넣는다. 사실은 아직 검증 상태이고 hash가 같을 때만 넣는다.
  - 다음은 drift로 보고하고 재개하지 않는다(`resumable: false`): 승인이 풀린 스토리·개요, 바뀐 노드 승인, 철회·변경된 사실·주장, 바뀐 활성 프로필, 바뀐 전송 정책.
  - 새 승인 스토리를 몰래 쓰지 않는다. checkpoint가 가리킨 옛 스토리를 보여 주고 drift로 표시한다.
  - 취소된 작업은 `job_cancelled`, 끝난 작업은 `job_finished`로 재개하지 않는다.
- `resumePrompt()`: 새 세션이 시작하는 글이다. 순서는 규칙 → 승인 스토리 → 문단 계획 → 검증된 사실 → 승인 주장 → 작업 상태(남은 단계, 완료한 일, 마지막 사건)다. 요약은 맨 끝에 "unverified; not evidence, approval or a record of completed work"로 붙는다.
- **Writer 연결**(RFC-013): 두 번째 이후 실행은 먼저 재수화로 재검사한다. drift가 있으면 provider를 부르지 않고 WAITING_USER로 간다(이유를 `last_error`에 적음).

## 변경 파일
- write scope
  - `db/migrations/pw_047_0001_job_checkpoints.sql`
  - `packages/domain/src/checkpoints/index.ts`: `recordCheckpoint`, `listCheckpoints`, `latestCheckpoint`, `rehydrate`, `resumePrompt`
  - `apps/worker/src/checkpoints/index.ts`: `jobCheckpoints` helper(resume, setScope, mark)
  - `tests/tasks/PW-047/checkpoints.int.test.ts`(통합 8)
- 범위 밖(RFC-013 부록): `apps/worker/src/writer/index.ts`
- 문서: `docs/adr/rfc/RFC-013-p06-write-scope-glue.md`(위임 채택)

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-047-A / TST-047A: 새 provider session에서 승인된 story/outline/facts와 미완료 step을 복원한다 | provider 세션이 답 전에 끝난다. 그러면 호출 전 checkpoint 1개가 남는다(스토리·개요·노드·사실·주장의 id·hash, 정책, 예산 UNKNOWN, 남은 단계 `provider_call`). 재수화는 승인 스토리의 novelty, 계획(섹션·목표), 사실(2.4 fold, n=3), 주장 문장을 DB에서 다시 읽어 준다. 새 세션 글에 이것들과 남은 단계가 들어간다. 다시 실행하면 이어서 끝난다: checkpoint 4개(호출 전 ×2, 검증 후, 저장 후), fencing token이 증가하고, 완료한 일은 `proposal_stored:<id>`다. 끝난 작업은 `job_finished`로 재개하지 않는다. worker helper는 앞 실행의 완료한 일을 이어받는다 |
| REQ-047-B / TST-047B: AI summary가 승인/사실/작업완료를 바꾸거나 quota 소진 뒤 추가 요약 호출을 필수로 요구하지 않는다 | "저장 끝, 개요 다시 승인, fold change 3.1, n=6"이라는 AI 요약이 있어도 완료한 일은 [], 남은 단계는 `provider_call`, 사실은 2.4/n=3이다. 요약은 `trusted: false` 메모이고, 새 세션 글에서 사실 뒤에 "unverified"로 붙는다. 호출하는 쪽이 넣은 승인·사실 내용, 줄어든 완료한 일, 4000자 넘는 요약, 옛 fencing token은 거부된다. 행 수정은 immutable로 막힌다. quota 100%(재설정 시각 모름)와 요약 없음에서도 재수화된다. 사실 철회, 새 스토리 승인, 전송 정책 변경은 drift로 재개를 멈춘다. 취소된 작업은 재개하지 않는다. worker는 drift가 있으면 provider를 부르지 않고 WAITING_USER로 간다(제안 없음) |

## RED → GREEN
- RED(`red.log`): domain checkpoint 모듈이 없어 suite가 실패한다.
- GREEN: 통합 8. 관련 suite(PW-042·043·044·046) 47개가 그대로 통과한다.
- mutation(`mutation.log`): 18종 중 17종 탐지
  - 처음 살아남은 "worker가 완료한 일을 이어받지 않음"이 **설계 오류**를 드러냈다.
    - 원래는 `provider_call`, `answer_validated`를 완료로 기록했다. 그러나 답은 제안이 저장되기 전에는 잃을 수 있으므로 "완료한 일은 반복하지 않음"과 모순이었다.
    - 이제 완료한 일은 지속되는 결과만이고, 진행은 `last_event`다.
    - helper 시험을 더한 뒤 탐지했다.
  - "다른 논문의 작업 상태 조회(OR)"는 살아남았다. 다음 checkpoint 조회가 논문으로 다시 거르기 때문에 다른 논문의 작업은 여전히 NOT_FOUND다. 이중 방어로 남긴다(동등).
- 회귀: `pnpm test` exit 0 — unit 406, integration 476, contracts 17, 브라우저 95 (`pnpm-test.log`)

## 보안·과학적 실패 경로
- checkpoint와 재수화는 모델을 부르지 않는다. 요약은 정본이 아니다.
- 재개는 정본과 정책을 다시 확인한 뒤에만 한다. 바뀐 것이 있으면 사용자에게 간다(WAITING_USER). 새 승인을 추측해 쓰지 않는다.
- 다른 논문의 작업은 NOT_FOUND다. 옛 실행은 쓰지 못한다(fencing).

## 미실행 / 남은 위험
- **실제 provider 세션 교체·compact는 실행하지 않았다**(자격 없음).
  - `resumePrompt`는 만들어지지만 실제 Claude·Codex 새 세션에 넣는 경로는 아직 Writer 계약(PW-042)이 대신한다. Writer는 매 실행 DB에서 계약을 새로 만든다.
  - 긴 대화형 세션(선택 채팅 등)의 compact·세션 교체 연결은 PW-048(context 예산)에서 한다.
- checkpoint는 Writer handler에만 연결했다. 다른 AI handler(스토리 대안, 프로필, 검토자, 선택 수정)는 아직 checkpoint를 쓰지 않는다. 연결 방법(`jobCheckpoints`)은 같다.
- 화면에 "마지막 checkpoint" 표시가 없다(spec 08 "웹 상태"). 실행 화면(PW-028)에 붙일 일로 남는다.
- 예산 예약은 UNKNOWN이다(PW-050).
- 재수화 drift는 프로필·정책 변경도 막는다. 사용자가 다시 요청하면 새 작업으로 진행한다(WAITING_USER 작업을 다시 큐에 넣는 화면은 아직 없음).

## 다음
PW-048: context 예산
