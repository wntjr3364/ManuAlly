// Minimal history router: '/' and '/papers/:id'. Links update the address bar so a page can be
// reopened or reloaded directly. Back/Forward ask before leaving unsaved work, like in-app links.
import { useEffect, useState } from 'react';
import { confirmLeave } from './unsaved.ts';

const listeners = new Set<() => void>();
let current = location.pathname;

export function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, '', path);
  current = path;
  listeners.forEach((l) => l());
}

addEventListener('popstate', () => {
  if (location.pathname === current) return;
  if (!confirmLeave()) {
    history.pushState(null, '', current); // stay: put the page we are on back on top
    return;
  }
  current = location.pathname;
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
