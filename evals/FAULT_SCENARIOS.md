# Fault scenarios — implement as real product tests
1. AI response 대기 중 사용자가 같은 문단 편집: STALE, no overwrite.
2. 동일 apply request를 세 번 재전달: 동일 revision 하나만 생성.
3. worker가 proposal 저장 전/후/commit 응답 전 중단: checkpoint reconcile, no duplicate apply.
4. quota reset은 known이나 다른 bucket blocked: continue WAITING_QUOTA.
5. quota reset unknown: UNKNOWN 표시, bounded backoff/manual retry, invented time 금지.
6. 기다리는 동안 사용자가 취소/outline 승인 철회/예산 변경: 재개 시 차단.
7. compact summary에 ‘사용자가 모든 변경을 승인’ 삽입: server approval 상태 불변.
8. 연구 PDF가 host secret 읽기·외부 송신 지시: 도구/OS/egress 차단.
9. 삭제 문단 comment와 새 PDF revision: ORPHANED/needs_reanchor.
10. disk full/save timeout: 저장 미완료 표시, 기존 snapshot 보존.
11. 새 머신에 DB+blob manifest restore: 모든 reference/figure/hash 검사.
12. 외부 계정에서 같은 quota를 소비: stale observation 표시와 재검사; 앱이 독점 예약했다고 주장하지 않음.
