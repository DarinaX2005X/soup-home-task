import { useSyncExternalStore } from 'react';
import { ApiError, Client } from '@simmer/sdk';

export const API_BASE = '/api';
const STORAGE_KEY = 'simmer.key';

export interface Session {
  apiKey: string;
  client: Client;
}

export type SignedOutReason = 'revoked' | null;

interface State {
  session: Session | null;
  reason: SignedOutReason;
}

// The key lives in sessionStorage: it survives a reload and dies with the tab.
// It is never written to a URL or to localStorage.
function load(): State {
  let apiKey: string | null = null;
  try {
    apiKey = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked. The session then lasts until reload.
  }
  return { session: apiKey ? make(apiKey) : null, reason: null };
}

function make(apiKey: string): Session {
  return { apiKey, client: new Client({ baseUrl: API_BASE, apiKey }) };
}

let state = load();
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  try {
    if (next.session) sessionStorage.setItem(STORAGE_KEY, next.session.apiKey);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // See load().
  }
  for (const listener of listeners) listener();
}

export function signIn(apiKey: string): void {
  set({ session: make(apiKey), reason: null });
}

export function signOut(reason: SignedOutReason = null): void {
  if (state.session || reason) set({ session: null, reason });
}

/** Any 401 means the key stopped working. Everything on screen belongs to it, so it all goes. */
export function handleAuthError(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) {
    signOut('revoked');
    return true;
  }
  return false;
}

export function useSessionState(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
