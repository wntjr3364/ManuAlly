// Minimal history router: '/' and '/papers/:id'. Links update the address bar so a page can be
// reopened or reloaded directly. Back/Forward ask before leaving unsaved work, like in-app links;
// when the user stays, the browser history is moved back by the same distance (not rewritten).
import { useEffect, useState } from 'react';
import { confirmLeave } from './unsaved.ts';

const listeners = new Set<() => void>();
const idxOf = (state: unknown) => (state && typeof state === 'object' && typeof (state as { idx?: unknown }).idx === 'number' ? (state as { idx: number }).idx : 0);
if (!history.state || typeof (history.state as { idx?: unknown }).idx !== 'number') history.replaceState({ idx: 0 }, '');
let currentIdx = idxOf(history.state);
let restoring = false;

export function navigate(path: string) {
  if (location.pathname !== path) {
    currentIdx += 1;
    history.pushState({ idx: currentIdx }, '', path);
  }
  listeners.forEach((l) => l());
}

addEventListener('popstate', (e) => {
  const idx = idxOf(e.state);
  if (restoring) {
    // the history.go() below landed back where we were
    restoring = false;
    return;
  }
  if (!confirmLeave()) {
    restoring = true;
    history.go(currentIdx - idx);
    return;
  }
  currentIdx = idx;
  listeners.forEach((l) => l());
});

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);
  return path;
}
