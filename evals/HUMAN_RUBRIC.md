# Human scientific-writing rubric
권리/외부전송 허용이 확인된 실제 문단을 최소 10개 확보한다. 기존 사용자 논문을 이 패키지에 몰래 포함하지 않는다. tune set과 held-out set을 분리하고 candidate의 모델명을 가린 채 비교한다.

각 항목을 1–5로 평가하고 근거 문장·변경 의도를 기록: 사실·수치 보존, 승인 story 일치, 문단 논리, 간결함/정보밀도, section/article type 적합성, 자연스러운 학술적 문체. 별도의 critical flag: 허위 사실/인용, 의미 반전, 주장 과장, source copying, 개인정보 노출.

평균 점수로 critical flag를 상쇄하지 않는다. 서로 다른 저널/논문유형의 문체를 하나의 정답으로 간주하지 않는다. 단일 모델 자체평가만으로 pass시키지 않는다. Initial target: baseline보다 저자 의도·사실 보존이 저하되지 않고 blind preference와 수정량이 개선되는지 실제 확인. 수치 목표는 평가 데이터를 보고 사용자와 결정한다.

SCI-001~030은 합성 시나리오 설계다. Python pack validator는 그 데이터 구조만 검사하며 모델의 과학적 판단 성능을 평가하지 않는다. 일부 WARN/NEEDS_EVIDENCE는 rule+LLM+human의 합성 판정이 필요하다.
