import { useSyncExternalStore, type MouseEvent } from 'react';

export type Route =
  | { page: 'runs' }
  | { page: 'run'; id: string }
  | { page: 'keys' }
  | { page: 'unknown' };

function parse(path: string): Route {
  if (path === '/' || path === '/runs') return { page: 'runs' };
  if (path === '/keys') return { page: 'keys' };
  const run = path.match(/^\/runs\/([0-9a-fA-F-]{36})$/);
  if (run) return { page: 'run', id: run[1]!.toLowerCase() };
  return { page: 'unknown' };
}

const listeners = new Set<() => void>();
let current = parse(location.pathname);
let currentPath = location.pathname;

function sync(): void {
  if (location.pathname === currentPath) return;
  currentPath = location.pathname;
  current = parse(currentPath);
  for (const listener of listeners) listener();
}
window.addEventListener('popstate', sync);

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  sync();
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Props for an <a> that navigates in place but still opens in a new tab on request. */
export function link(path: string) {
  return {
    href: path,
    onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(path);
    },
  };
}
