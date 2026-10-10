# 사용자 pilot (PW-062, spec 11 "주요 workflow 사용자가 직접 검토")

사용자가 자기 기계에서 직접 해 보고 결과를 `reports/release/pilot.json`에 기록한다. AI는 이 기록을 채우지 않는다.

## 준비
- [docs/runbooks/DEPLOY.md](../../docs/runbooks/DEPLOY.md)대로 설치한다. `pwctl check`, `migrate`, `run`을 거친다.
- 실제 AI 공급자를 쓰기 전에는 AI 답이 **MOCK**으로 표시된다. 실제 공급자 사용은 아래 6번 뒤에만 한다.

## 해 볼 workflow
1. **논문과 구상**: 논문 하나를 만든다. Story를 쓰고 승인한다. 개요(문단 계획)를 쓰고 승인한다.
2. **근거**
   - 실험 근거와 사실(수치)을 등록하고 확인 상태로 바꾼다. 주장을 만들고 근거에 잇는다.
   - 문헌을 추가한다. 가능하면 Zotero나 DOI로 한다.
   - 원문 PDF를 올려 텍스트를 추출하고, 인용할 구절에 anchor를 단다.
3. **원고**
   - 한국어 입력기로 문단을 직접 쓴다. 인용과 그림 참조를 넣는다.
   - 저장, 새로고침, 다른 탭 충돌, 되돌리기를 해 본다.
4. **선택 수정**: 문장을 선택해 짧게 고쳐 달라고 한다(MOCK). 차이를 보고 적용한 뒤 되돌린다.
5. **검토와 제출**
   - 과학 검사를 실행하고 결과를 확인한다.
   - DOCX·PDF·source archive를 내보내 Word나 한글 뷰어, PDF 뷰어에서 연다.
   - 리뷰 의견에 응답하고 제출판을 확정한다.
6. **실제 AI**(선택, 사용자 결정)
   - 별도 runtime 로그인 프로필로 Claude Code 또는 Codex의 live smoke를 sandbox 안에서 실행한다(MAN-LIVE-SANDBOX).
   - registry에 live evidence를 기록한다.
   - 그 다음 4번과 문단 초안을 실제 공급자로 해 본다.
7. **운영**: `pwctl status`, `pause-ai` / `resume-ai`, `stop` / `run`을 해 본다. 백업을 만들어 다른 DB·폴더로 복원해 본다.
8. **다른 기기**(선택): TLS reverse proxy 뒤에서 열어 본다(MAN-DEPLOY-TLS).

## 기록(`pilot.json`)
```json
{ "status": "passed" | "failed", "checked_by": "user", "checked_at": "YYYY-MM-DD", "evidence": "어디에 무엇을 남겼는지(메모·스크린샷 경로)", "workflows": ["1", "2", ...], "note": "문제와 의견" }
```
- 문제가 있으면 `failed`로 두고 note에 적는다.
- 고칠 일은 새 Task로 만든다.
