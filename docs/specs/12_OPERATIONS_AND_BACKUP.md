# 12. Operations, storage, backup and maintenance

## 기본 배포
전용 data root를 설치 시 정한다. 예: `/data/paper-workspace`는 예시 경로이며 존재·권한·용량을 확인한 뒤 사용자 승인으로 지정한다. 앱 설치경로와 연구 원본경로, 개발 .claude/.codex 디렉터리와 구분. root filesystem/Docker overlay에 원문 PDF·logs·parser temp가 무제한 증가하지 않게 한다.

필수 runtime: web/api, worker, postgres, durable blob volume. GROBID/export runner는 resource-limited profile. non-root, read-only app image, 특정 temp dir만 writable, DB/agent port 외부 공개 금지. loopback 또는 안전한 reverse proxy. 개발 test DB와 운영 DB를 같은 이름·credential로 사용하지 않는다.

## 저장 정책
원본 asset immutable + sha256 + size + mime. 텍스트 추출/index/thumbnail은 재생성 가능한 derived data. 원고 revision·승인·출판 snapshot·reference metadata는 재생성 불가능한 primary data. 별도 retention policy. autosave를 전부 영구 저장해 무한증가시키지 않되 named snapshot/approved revision이 참조하는 항목은 보존. blob GC는 참조 무결성/대기 job/restore window 확인 후 실행.

## Backup
DB consistent backup + 같은 시점 manifest가 지칭하는 immutable blobs + 설정/schema version. credential은 독립적인 secret recovery 정책으로 관리. 같은 디스크의 다른 폴더만으로 재해복구라고 부르지 않음. 암호화된 별도 저장위치/오프호스트 사본을 사용자가 지정. archive의 접근권한과 DOI 원문 재배포권한도 확인.

기본 제안: 주기적인 DB/asset 백업 + 중요 snapshot 직후 추가 백업, 정기적인 별도 환경 복원. 목표 RPO/RTO는 운영환경 검증 후 설정하며 일단 임의의 ‘0 데이터손실’을 약속하지 않는다. 배포 전 최소 한 번 실제 restore drill: reference/citation/figure/approval/proposal/version이 모두 연결되는지 검사.

## 관측과 알림
run/job 상태, queue 대기, repeated failure, provider capability 변경, usage 미확인, orphan process, blob errors, save failure, backup age, disk pressure. UI status와 운영 logs 일치. 민감 원문/keys를 telemetry에 포함하지 않음. 유료 observability SaaS는 기본 의존성 아님.

## 비상 중단
AI global pause는 queued task와 running task에 반영하되 사용자 수동 편집은 유지. disk/db 장애는 저장상태를 false로 표시하고 local recovery 옵션을 제공. quota/Auth 일시 중단은 원고 접근을 막지 않음. 안전하게 저장할 수 없는 상태에서 ‘autosaved’ 표시 금지.

## 업그레이드
model/SDK/CLI/parser/editor/citeproc 업데이트를 개별 식별. contract/eval/export fixture로 regression 후 pin 변경. 깨진 provider만 disabled하고 manual editor는 계속 사용. migration rollback은 데이터 파괴적인 down migration보다 검증된 backup restore/forward fix를 우선 검토. 실행 중 paper job은 maintenance checkpoint로 멈춘다.

## 릴리스 수준
Demo(Mock) → private alpha(실제 허용 provider 1개) → private beta(두 adapter와 reliability) → 개인 사용 v1(전체 gate+restore+pilot). 각 수준을 명시해 미검증 기능을 지원한다고 홍보하지 않음.
