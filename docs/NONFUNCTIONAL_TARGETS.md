# Proposed non-functional acceptance targets
아래는 측정 후 조정할 **제품 목표**이며 현재 구현 성능이나 작업 소요시간 예측이 아니다.

- 기준 fixture: 20,000단어 원고, reference 200개, figure/table asset 30개. 정확한 측정 머신/브라우저를 보고서에 남긴다.
- 수동 입력·선택에 눈에 띄는 지속 정지 없음; 로컬 정상환경의 입력 반응 p95 100ms 이내를 초기 목표로 측정한다. LLM completion 시간은 별도 측정한다.
- 로컬 정상환경의 autosave ack p95 1초 이내 목표. timeout/오프라인에서는 성공 상태를 표시하지 않는다.
- 처리 중인 하나의 paper에는 writer 1개. 전체 provider concurrency는 초기 1로 두고 사용자가 예산·호스트 성능에 맞춰 조정한다.
- UI는 상태/선택범위/모델 호출 여부/미저장/경고를 키보드와 스크린리더로 파악할 수 있어야 한다.
- 정본 변경의 unauthorized/duplicate/stale 경로는 deterministic critical fixture에서 통과 허용 0건을 목표로 한다. 이는 모든 현실 오류가 0건이라는 보장이 아니다.
- 백업 복구 목표와 retention은 실제 데이터량·저장위치·기관 정책을 확인해 정한다. 아직 RPO/RTO를 충족했다고 주장하지 않는다.
