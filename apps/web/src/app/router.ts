// Minimal history router: '/' and '/papers/:id'. Links update the address bar so a page can be
// reopened or reloaded directly.
import { useEffect, useState } from 'react';

const listeners = new Set<() => void>();
export function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, '', path);
  listeners.forEach((l) => l());
}
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      removeEventListener('popstate', update);
    };
  }, []);
  return path;
}
