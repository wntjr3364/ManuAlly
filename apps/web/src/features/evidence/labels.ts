// Words for figure/table changes and review flags (PW-036).
export function reasonText(r: string): string {
  const [kind, panel] = r.split(':');
  const p = panel ? `패널 ${panel}` : '';
  switch (kind) {
    case 'new_file': return '그림 파일이 바뀜';
    case 'caption_changed': return '캡션이 바뀜';
    case 'unit_changed': return `${p} 단위가 바뀜`;
    case 'groups_changed': return `${p} 그룹이 바뀜`;
    case 'panel_added': return `${p} 추가됨`;
    case 'panel_removed': return `${p} 없어짐`;
    case 'fact_unit_differs': return `사실 값의 단위가 ${p}의 새 단위와 다름`;
    default: return r;
  }
}
export const TARGET: Record<string, string> = { paragraph: '원고 문단', claim: '주장', fact: '사실 값' };
