# Paper Workspace — Build Constitution

## Authority
사용자의 명시 지시 > 본 Constitution의 안전·데이터 불변조건 > 승인된 ADR/Spec > 현재 Task > 코드 주석. 지시가 안전·데이터 불변조건과 충돌하면 실행을 멈추고 충돌을 설명한다. 초안 ADR은 승인된 결정이 아니다. Spec을 몰래 바꿔 테스트를 통과시키지 않는다.

## Product invariants
- PaperProject 1개 = 논문 1편. Outline·Manuscript·References·Figures·Review·Versions가 그 안에 속한다.
- AI의 새 원고 생성에는 승인된 StoryRevision과 해당 OutlineRevision/Node가 필요하다. 사용자 메모·수동 편집·기존 원고 가져오기는 막지 않는다.
- DB와 불변 asset이 정본이다. 대화·summary·CLI working file은 정본이 아니다.
- 논문의 수치·Methods·주장·인용·승인을 AI가 임의로 만들어 확정하지 않는다.
- AI는 proposal만 만든다. 정본 변경은 서버의 authorization, base revision, schema, protected span, approval 검증 후 트랜잭션으로만 실행한다.
- 선택 수정은 선택 범위를 벗어나지 않는다. 변경 중 원문이 달라졌다면 무음 덮어쓰기 대신 STALE 상태로 전환한다.
- outline 승인, profile 채택, 외부 전송 허용, 결제/공급자 전환, 제출판 확정은 사용자 행위다.
- 기존 개발/연구 세션의 continue/resume, 원본 작업폴더 쓰기, 기존 홈·credential 디렉터리 전체 공유를 금지한다.
- 동일 계정의 할당량·동일 호스트 자원은 세션을 나누어도 완전 격리되지 않는다. 보장하지 않는다.
- 관측 불가한 usage·context·reset 시간은 UNKNOWN이다. 0 또는 임의 시각을 만들지 않는다.

## Engineering workflow
현재 Task와 관련 spec/contract/기존 코드·테스트부터 읽는다. acceptance test를 먼저 작성해 이유 있는 RED를 확인하고 최소 구현 → GREEN → refactor → regression → 독립 review 순서로 진행한다. 한 작업이 끝나면 in_review로 기록하고 다음 작업을 자동 시작하지 않는다.

Task 필수 산출: REQ/AC/TST 매핑, 수정 파일, 테스트 명령과 실제 결과, 실행하지 못한 테스트, 보안·과학적 실패 경로, 잔여 위험, 다음 작업. 검증 증거 없는 completed 표시는 금지한다. 원격 공급자 테스트는 자격증명·허용 예산이 없으면 blocked/not_run이지 pass가 아니다.

## Scope and change control
현재 Task의 write_scope 밖 파일·새 의존성·공유 schema·DB migration·인증·청구 모델 변경은 RFC로 분리한다. 신규 Task는 requirements와 tests 매핑을 추가한다. 구현 중 유용해 보이는 다른 연구 플랫폼의 기능을 가져오지 않는다.

## Safety
`--dangerously-skip-permissions`, unrestricted shell, Docker socket mount, host network, credential 복제, 전역 settings 수정, `git reset --hard`, 미승인 파일 삭제·git push·외부 업로드를 금지한다. 운영 데이터 대신 합성 fixture로 작업한다. 비밀을 stdout·테스트 artifact·git에 쓰지 않는다. 런타임 AI는 이 개발용 CLAUDE.md 또는 저장소 전체를 읽지 않는다.

## Versions and dependencies
P00에서 실제 설치 버전·공식 지원·라이선스를 확인하고 lockfile/container digest를 고정한다. latest 태그·문서의 예제 모델명·없는 SDK API를 추정해 사용하지 않는다. Claude·Codex의 최신 문서가 로컬 버전과 다르면 로컬 계약 테스트를 기준으로 capability를 제한한다.

## Context handoff for the coding agent
길어지기 전에 PROGRESS.md와 현재 Task의 checkpoint를 갱신한다. 승인된 결정·실행한 테스트·미완료·수정 허용범위·미해결 RFC를 기록한다. 새 세션은 START_HERE, CLAUDE, PROGRESS와 해당 Task만 읽고 git diff를 확인한다. compact는 프로젝트의 완료·승인 상태를 변경하지 않는다.
