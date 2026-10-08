# 06. Scientific writing engine and evaluation

## 목표와 비목표
목표: 연구자의 의도와 실제 근거를 보존하면서 읽기 좋은 과학 논문을 작성. 비목표: AI 탐지기 점수 최적화, 특정 저자의 문구 복제, 글을 더 길거나 더 화려하게 만드는 것. ‘Furthermore’ 같은 단어 자체를 금지하지 않는다. 과도한 반복·빈 강조·불필요한 설명을 문맥별로 검토한다.

## WritingProfile
article_type, target_audience, journal_rule_snapshot, preferred_English_variant, terminology_registry, section_roles, rhetoric_patterns, concision_preference, claim_strength_policy, anti_examples, accepted_examples, source_reference_versions, approved_at. 저널 rules는 원문·확인일·적용 article type을 저장 [S18]. 사용자 피드백을 profile 개선 후보로 기록하지만 한 번의 수정을 전역 스타일로 자동 고정하지 않는다.

우수 논문 후보의 해당 본문을 실제 읽고 ‘문단의 역할과 정보 배치 원칙’을 추출한다. 논문별 문장을 통째로 writer context에 반복 주입하지 않는다. 여러 논문에서 공통 원칙과 반례를 비교한다. 과도한 문구 재현은 source-similarity warning을 제공하며 법적 표절 판정기라고 부르지 않는다. 재현성 필수 Methods 표현을 단지 비슷하다는 이유로 왜곡하지 않는다.

## ParagraphContract
approved_story/outline/node ID + purpose + mandatory claims + exact approved facts + evidence locators + preceding/following context + terminology + prohibited inferences + target length + allowed operation + scope + source transmission policy. 모델은 부족한 근거에 대해 needs_evidence로 반환할 수 있어야 한다. 최소 단위는 보통 한 문단/한 논리 단위. 전체 원고 생성은 기본 동작이 아니다.

## 섹션 역할
Introduction: 필요한 배경·지식 공백·질문을 좁혀가며 과도한 교과서 설명 제한.
Methods: 수행이 확인된 절차/조건만. 없는 실험·장비·반복수·software version을 채우지 않음.
Results: 정확한 관찰·통계·figure/table 연결. 설명이 필요한 경우만 해석 범위를 허용하며 저널의 Results & Discussion 구조를 존중.
Discussion: 의미·선행연구 비교·대안 설명·한계. 결과 반복만 하지 않음.
Abstract: 본문에 확정된 결과에서 작성하고 수치·결론 일치 검사.
Resource/Software/Methods 논문에는 맞는 구조를 제공하며 고정 IMRaD를 강제하지 않음.

## 수정 모드
Conservative: 문법/가독성, 사실·범위·논리 순서 최대 보존.
Scientific Rewrite: 같은 주장과 근거에서 서술 재작성.
Structural Revision: 문단 순서/구성 변경 제안; outline 변경이 필요하면 먼저 RFC-like outline proposal.
모드를 바꿔도 사실·인용·승인·version 검증은 동일하다.

## 검증 층
A. Deterministic: schema, scope, approved version, citation ID, FactRecord와 수치·단위/그룹 매칭, 보호된 span 변경, crossref 존재. 정확한 mapping이 불가능하면 UNKNOWN이지 통과 아님.
B. Scientific reviewer: 과장, 관찰/인과 혼동, 논리 비약, 반대 근거 누락, 섹션 역할, 부정어 반전. AI 판단은 finding+source+confidence로 저장.
C. Writing reviewer: 반복·정보 밀도·문단 연결·불필요한 장문. 단어 blacklist나 고정 문장 길이로 판정하지 않음.
D. Human: 핵심 주장·의미·승인·최종 채택.

writer와 reviewer는 역할/context를 분리하되 매 교정에 복수 LLM을 호출하지 않는다. 기본 한 번 생성+필요한 검토, 최대 repair 1회(초기 제안값). 계속 실패하면 사용자에게 근거 부족/명세 충돌을 보여준다. 같은 모델의 self-review를 독립적 사실 검증이라고 부르지 않는다.

## 안전한 실패와 export
hard structural/auth/version violation은 적용 차단. unsupported scientific assertion은 원고 proposal 적용을 차단하거나 사실 정정 task로 분리. 스타일 문제는 경고와 대안이지 사용자의 수동 문장을 차단하는 검열이 아니다. draft export는 미해결 상태를 보고서로 첨부 가능; clean submission snapshot은 중요 불일치 해결을 요구한다. unsupported 내용을 사용자가 force-accept해 verified로 바꾸는 일반 버튼은 두지 않는다.

## 품질 평가
합성 fixture로 factual constraints·인용·negation·단위·p/q·상관/인과·범위 준수 테스트. 본문 품질은 사용자가 제공/사용 허용한 paragraph gold set으로 블라인드 pairwise 평가. 사실 보존, 논리, 간결함, 논문 장르 적합성, author intent를 별도 측정. accepted-edit rate와 재수정량은 참고 지표이며 정답과 동일하지 않음. live LLM 결과는 고정 문자열 비교 대신 rubric과 회귀 사례로 검증. 초기 30개 합성 hard cases + 권리 확인된 10개 이상 수동 rubric 사례를 release fixture로 구축한다. 수치는 제안된 최소 gate이지 품질 보장 확률이 아니다.
