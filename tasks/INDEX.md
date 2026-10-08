# Task index

62개 작업, 62개 요구사항, 124개 인수조건/테스트 설계. 이는 구현되거나 실행된 제품 테스트 수가 아니다.
기본은 순차 진행이다. 병렬화를 원하면 서로 다른 write_scope·DB migration 소유권·기반 계약 안정성을 확인한 별도 Task/RFC를 작성한다.

## P00 — 사전 타당성·위험 검증
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-001](PW-001.md) | 환경·저장소·운영 경계 확인 | 없음 |
| [PW-002](PW-002.md) | Provider 인증·배포 admission | PW-001 |
| [PW-003](PW-003.md) | 문서 선택·포맷 왕복 spike | PW-002 |
| [PW-004](PW-004.md) | 실행 세션·권한 격리 spike | PW-003 |
| [PW-005](PW-005.md) | 집필 품질 baseline fixture | PW-004 |
| [PW-006](PW-006.md) | P00 검토·ADR·버전 고정안 | PW-005 |

## P01 — 정본·승인·수동 workflow 기반
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-007](PW-007.md) | Monorepo와 검증 명령 scaffold | PW-006 |
| [PW-008](PW-008.md) | Owner 인증과 PaperProject | PW-007 |
| [PW-009](PW-009.md) | 불변 revision·snapshot 저장 | PW-008 |
| [PW-010](PW-010.md) | 수동 Story·Outline 승인 | PW-009 |
| [PW-011](PW-011.md) | Claim·Fact·Evidence 최소 모델 | PW-010 |
| [PW-012](PW-012.md) | Shared editor schema·계약 | PW-011 |
| [PW-013](PW-013.md) | DB job·outbox·audit 기반 | PW-012 |
| [PW-014](PW-014.md) | 수동 논문 수직경로 검증 | PW-013 |

## P02 — 선택 편집·diff·복원 첫 완성형
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-015](PW-015.md) | 에디터·자동저장·IME | PW-014 |
| [PW-016](PW-016.md) | Selection toolbar·Short Chat | PW-015 |
| [PW-017](PW-017.md) | Proposal·CAS·원자 적용 | PW-016 |
| [PW-018](PW-018.md) | Highlight·Comment anchor | PW-017 |
| [PW-019](PW-019.md) | Citation·Figure crossref node | PW-018 |
| [PW-020](PW-020.md) | Mock AI·스트리밍 UI | PW-019 |
| [PW-021](PW-021.md) | Version compare·Undo·기본 import | PW-020 |
| [PW-022](PW-022.md) | 선택편집 브라우저 gate | PW-021 |

## P03 — 공식 provider와 격리 실행
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-023](PW-023.md) | Provider registry·이벤트 정규화 | PW-022 |
| [PW-024](PW-024.md) | Claude Agent adapter | PW-023 |
| [PW-025](PW-025.md) | Codex App Server adapter | PW-024 |
| [PW-026](PW-026.md) | Isolated runner·입출력 mount | PW-025 |
| [PW-027](PW-027.md) | Typed tool gateway·scope | PW-026 |
| [PW-028](PW-028.md) | Interrupt·취소·재연결 | PW-027 |
| [PW-029](PW-029.md) | Usage·quota 관측 기본 | PW-028 |
| [PW-030](PW-030.md) | 실제 provider 통합 gate | PW-029 |

## P04 — 문헌·PDF·근거와 그림 연결
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-031](PW-031.md) | 서지 검색 adapter | PW-030 |
| [PW-032](PW-032.md) | 서지 정규화·출판본 관계 | PW-031 |
| [PW-033](PW-033.md) | AI 문헌 후보 선정 | PW-032 |
| [PW-034](PW-034.md) | 원문 권리·안전한 업로드 | PW-033 |
| [PW-035](PW-035.md) | PDF parsing·highlight locator | PW-034 |
| [PW-036](PW-036.md) | Figure/Table/Fact 출처 연결 | PW-035 |
| [PW-037](PW-037.md) | 필요한 근거만 retrieval | PW-036 |
| [PW-038](PW-038.md) | 문헌 이식성·읽기 연동 gate | PW-037 |

## P05 — 개요 주도 과학적 집필
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-039](PW-039.md) | Story 대안·주장 범위 AI | PW-038 |
| [PW-040](PW-040.md) | Detailed outline·영향 추적 | PW-039 |
| [PW-041](PW-041.md) | WritingProfile 생성·승인 | PW-040 |
| [PW-042](PW-042.md) | ParagraphContract·Writer | PW-041 |
| [PW-043](PW-043.md) | Deterministic scientific gate | PW-042 |
| [PW-044](PW-044.md) | 문체·과학 검토와 human review | PW-043 |
| [PW-045](PW-045.md) | 과학적 부정 fixture·rubric gate | PW-044 |
| [PW-046](PW-046.md) | 개요→집필 연구자 workflow | PW-045 |

## P06 — 컨텍스트·한도·중단 복구
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-047](PW-047.md) | Checkpoint·영구기억 재수화 | PW-046 |
| [PW-048](PW-048.md) | Context budget·compact 전환 | PW-047 |
| [PW-049](PW-049.md) | Quota 대기·리셋 재검증 | PW-048 |
| [PW-050](PW-050.md) | 비용 예약·budget guard | PW-049 |
| [PW-051](PW-051.md) | Lease fencing·경합·outbox 복구 | PW-050 |
| [PW-052](PW-052.md) | 오류 분류·bounded retry | PW-051 |
| [PW-053](PW-053.md) | Crash·disk full·stale 재개 시험 | PW-052 |
| [PW-054](PW-054.md) | Run 상태 UI·운영 reliability gate | PW-053 |

## P07 — 투고 출력·복구·개인 배포 완성
| Task | 구현 대상 | 선행 |
|---|---|---|
| [PW-055](PW-055.md) | DOCX import와 손실 보고 | PW-054 |
| [PW-056](PW-056.md) | DOCX·CSL export | PW-055 |
| [PW-057](PW-057.md) | PDF·재현 source archive | PW-056 |
| [PW-058](PW-058.md) | Reviewer·제출판 freeze | PW-057 |
| [PW-059](PW-059.md) | Security release audit | PW-058 |
| [PW-060](PW-060.md) | Backup·restore·migration drill | PW-059 |
| [PW-061](PW-061.md) | 배포·storage·upgrade runbook | PW-060 |
| [PW-062](PW-062.md) | v1 최종 pilot·추적성 gate | PW-061 |
