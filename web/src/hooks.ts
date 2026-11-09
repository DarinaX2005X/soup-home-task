import { useCallback, useEffect, useRef, useState } from 'react';
import { RunData, RunStream, type StreamSnapshot } from '@simmer/sdk';
import type { LateMark } from './Chart.tsx';
import { API_BASE, handleAuthError, signOut, type Session } from './session.ts';

/** Wall clock that ticks while the tab is visible, for "12 s ago" labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => !document.hidden && setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface Polled<T> {
  data: T | undefined;
  error: string | null;
  /** When the data on screen was fetched. */
  fetchedAt: number | null;
  refresh: () => void;
}

/** Fetches on mount, then on an interval while the tab is visible. */
export function usePolled<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Omit<Polled<T>, 'refresh'>>({ data: undefined, error: null, fetchedAt: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(fetcher);
  latest.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const run = async () => {
      if (!document.hidden) {
        try {
          const data = await latest.current(controller.signal);
          if (!stopped) setState({ data, error: null, fetchedAt: Date.now() });
        } catch (error) {
          if (stopped || handleAuthError(error)) return;
          // Keep what is on screen. It is labelled with the time it was fetched.
          setState((previous) => ({ ...previous, error: (error as Error).message }));
        }
      }
      if (!stopped) timer = setTimeout(run, intervalMs);
    };
    void run();
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}

const LATE_VISIBLE_MS = 2200;
/** A run page hidden for this long gives its connection back to the browser. */
const HIDDEN_PAUSE_MS = 5000;

export interface LiveRun {
  data: RunData;
  snapshot: StreamSnapshot;
  /** Points that recently arrived behind newer ones, by metric, for highlighting. */
  late: Map<string, LateMark[]>;
}

/**
 * Subscribes to one run for as long as the component is mounted. Stream events
 * can arrive hundreds of times a second during catch-up, so renders are
 * limited to one per animation frame.
 */
export function useLiveRun(session: Session, runId: string): LiveRun {
  const [, setFrame] = useState(0);
  const ref = useRef<{ stream: RunStream; late: Map<string, LateMark[]> } | null>(null);

  if (ref.current === null) {
    ref.current = {
      late: new Map(),
      stream: new RunStream({ baseUrl: API_BASE, apiKey: session.apiKey, runId, data: new RunData() }),
    };
  }

  useEffect(() => {
    const late = new Map<string, LateMark[]>();
    let scheduled = 0;
    const render = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        setFrame((n) => n + 1);
      });
    };
    const stream = new RunStream({
      baseUrl: API_BASE,
      apiKey: session.apiKey,
      runId,
      data: new RunData(),
      onChange: (snapshot) => {
        if (snapshot.phase === 'unauthorized') signOut('revoked');
        render();
      },
      onLate: (points) => {
        const now = Date.now();
        // During a catch-up nearly everything is "late". Rings on hundreds of
        // points would say nothing, so only small arrivals are marked, and
        // only the most recent few per metric stay on screen.
        if (points.length > 24) return;
        for (const point of points) {
          const list = (late.get(point.key) ?? []).filter((m) => now - m.at < LATE_VISIBLE_MS);
          list.push({ step: point.step, at: now });
          late.set(point.key, list.slice(-6));
        }
        setTimeout(render, LATE_VISIBLE_MS + 50);
      },
    });
    ref.current = { stream, late };
    stream.start();
    render();
    const retry = () => !document.hidden && stream.retryNow();
    // Browsers allow about six connections per site over HTTP/1.1, and every
    // live page holds one. A background tab lets go of its own after a short
    // wait and catches up from its cursor when it is looked at again.
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      clearTimeout(pauseTimer);
      if (document.hidden) pauseTimer = setTimeout(() => stream.pause(), HIDDEN_PAUSE_MS);
      else {
        stream.resume();
        stream.retryNow();
      }
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      stream.stop();
      clearTimeout(pauseTimer);
      cancelAnimationFrame(scheduled);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session.apiKey, runId]);

  const { stream, late } = ref.current;
  const now = Date.now();
  const visible = new Map<string, LateMark[]>();
  for (const [key, marks] of late) {
    const fresh = marks.filter((m) => now - m.at < LATE_VISIBLE_MS);
    if (fresh.length > 0) visible.set(key, fresh);
  }
  return { data: stream.data, snapshot: stream.snapshot, late: visible };
}
