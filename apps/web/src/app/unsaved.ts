// Unsaved-change registry for the whole app. Components report what is unsaved; leaving the paper,
// logging out or closing the page asks first. Switching tabs inside a paper keeps components mounted,
// so it never needs to ask.
const sources = new Map<string, string>();

export function setUnsaved(key: string, label: string | null) {
  if (label) sources.set(key, label);
  else sources.delete(key);
}
export const hasUnsaved = () => sources.size > 0;

// true when it is fine to leave (nothing unsaved, or the user agreed to discard)
export function confirmLeave(): boolean {
  if (!sources.size) return true;
  return window.confirm(`저장되지 않은 변경이 있습니다: ${[...sources.values()].join(', ')}.\n떠나면 이 변경은 사라집니다. 계속할까요?`);
}

addEventListener('beforeunload', (e) => {
  if (sources.size) {
    e.preventDefault();
    e.returnValue = '';
  }
});
