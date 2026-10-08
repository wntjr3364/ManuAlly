# Risk register
| 위험 | 실패 사례 | 예방 / 검증 |
|---|---|---|
| 인증·구독 사용범위 오해 | UI 완성 후 구독 runtime 사용 불가 | P00 admission, API/허용 local 모드, 비용 자동 전환 금지 |
| 기존 세션/파일 간섭 | 최신 세션 attach, 원본 분석폴더 덮어쓰기 | explicit session + 별도 HOME/cwd + read-only snapshot + sentinel tests |
| shared quota 간섭 | 논문 작업으로 개발 계정 한도 소진 | app budget/concurrency 표시; 완전 격리 불가 명시 |
| outline drift | AI가 다른 novelty로 전체 원고 생성 | approved IDs·paragraph contract·impact graph |
| hallucinated methods/numbers | 없는 실험조건이나 p-value 추가 | verified FactRecord + missing evidence 상태 + human review |
| 잘못된 인용 | DOI만 맞고 claim은 무관 | source depth, excerpt locator, citation support review |
| style overfitting | 참고 논문 문구/과장 복제 | rhetoric pattern 추출, source similarity warning, human rubric |
| stale edit | 기다리는 동안 수동 수정한 문장을 덮음 | CAS/hash/STale proposal 재생성 |
| comment 위치 유실 | 삭제된 문장 코멘트가 다른 문장에 부착 | mapped/orphaned 상태, exact anchor 테스트 |
| 중복 retry | 동일 제안 2회 적용·두 worker 경합 | transaction idempotency+lease fencing; 외부 호출 중복 가능 명시 |
| compact 기억 손실 | 승인되지 않은 사실을 승인됐다고 요약 | source version IDs와 server authority, summary는 비신뢰 |
| reset 오판 | weekly limit인데 5시간 후 무한 재시도 | multi-bucket+unknown+bounded retry+circuit breaker |
| 비용 폭주 | 검색/작성/리뷰 루프가 연속 실행 | turn/tool/repair/output 상한, reserve+actual ledger |
| prompt injection | PDF 지시로 credential/다른 원고 접근 | tool scope·network·OS 경계·부정 tests |
| Word 상호운용성 | 공동저자 tracked changes 유실 | import loss report·원본 보존·v1 round-trip 비지원 고지 |
| PDF 해석 오류 | 2단 읽기 순서·표 수치 깨짐 | 페이지 locator·추출 quality·사용자 검증 |
| storage full | autosave 실패를 성공처럼 표시 | free-space limits·save ack·tmp retention·recovery |
| backup 무용 | DB만 복구돼 figure/PDF 없음 | consistent manifest+blob checksums+실제 restore drill |
| scope 폭발 | Zotero+Word+분석+SaaS 동시 구현 | v1 non-goals·phase gate·작은 vertical slice |
| 평가 착시 | model이 자기 글에 높은 점수 | deterministic tests+blind human rubric+negative fixtures |
