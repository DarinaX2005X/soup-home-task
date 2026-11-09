import { SseParser, type SseEvent } from './sse.ts';
import { RunData, type LatePoint } from './state.ts';
import type { ByeMessage, PointsMessage, RunStateMessage } from './protocol.ts';

export type StreamPhase =
  /** A request is on its way. */
  | 'connecting'
  /** The stream is open and events are being read. */
  | 'open'
  /** The connection was lost and the next attempt is scheduled. */
  | 'waiting'
  /** The key was rejected or revoked. Terminal. */
  | 'unauthorized'
  /** The run does not exist for this key. Terminal. */
  | 'not_found'
  | 'stopped';

export type StreamLogEntry = { at: number } & (
  | { kind: 'connected'; cursor: number }
  | { kind: 'caught_up'; from: number; to: number }
  | { kind: 'lost'; reason: string; cursor: number }
  | { kind: 'gap'; expected: number; got: number }
  | { kind: 'resync'; reason: string }
  | { kind: 'bye'; reason: string }
);

export interface StreamSnapshot {
  phase: StreamPhase;
  /** Last run state received from the server. */
  run: RunStateMessage | null;
  cursor: number;
  count: number;
  /** Bumped every time the applied points change. */
  version: number;
  connects: number;
  gaps: number;
  resyncs: number;
  /** When the current outage started, or null while connected. */
  lostAt: number | null;
  lastEventAt: number | null;
  log: StreamLogEntry[];
}

export interface RunStreamOptions {
  baseUrl: string;
  apiKey: string;
  runId: string;
  data?: RunData;
  fetch?: typeof fetch;
  onChange?: (snapshot: StreamSnapshot) => void;
  onLate?: (points: LatePoint[]) => void;
  /** No bytes for this long means the connection is dead even if TCP has not noticed. */
  silenceMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const LOG_LIMIT = 40;

/**
 * Keeps a RunData in step with the server over SSE. It reconnects from the
 * last applied cursor, refuses to apply a message that skips ahead, and
 * compares its own point count with the stored one whenever cursors match.
 */
export class RunStream {
  readonly data: RunData;
  private readonly options: RunStreamOptions;
  private state: StreamSnapshot;
  private controller: AbortController | undefined;
  private stopped = false;
  private wakeSleep: (() => void) | undefined;
  private catchingUpFrom: number | null = null;

  constructor(options: RunStreamOptions) {
    this.options = options;
    this.data = options.data ?? new RunData();
    this.state = {
      phase: 'connecting',
      run: null,
      cursor: this.data.cursor,
      count: this.data.count,
      version: 0,
      connects: 0,
      gaps: 0,
      resyncs: 0,
      lostAt: null,
      lastEventAt: null,
      log: [],
    };
  }

  get snapshot(): StreamSnapshot {
    return this.state;
  }

  start(): this {
    void this.loop();
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.wakeSleep?.();
    this.update({ phase: 'stopped' });
  }

  /** Skip the backoff, for example when the browser reports it is back online. */
  retryNow(): void {
    this.wakeSleep?.();
  }

  private update(patch: Partial<StreamSnapshot>, entry?: StreamLogEntry): void {
    const log = entry ? [...this.state.log, entry].slice(-LOG_LIMIT) : this.state.log;
    this.state = {
      ...this.state,
      ...patch,
      cursor: this.data.cursor,
      count: this.data.count,
      log,
    };
    this.options.onChange?.(this.state);
  }

  private async loop(): Promise<void> {
    const minDelay = this.options.minDelayMs ?? 300;
    const maxDelay = this.options.maxDelayMs ?? 5_000;
    let delay = minDelay;
    while (!this.stopped) {
      this.update({ phase: 'connecting' });
      const outcome = await this.connectOnce();
      if (this.stopped) return;
      if (outcome.terminal) {
        this.update({ phase: outcome.terminal });
        return;
      }
      this.update(
        { phase: 'waiting', lostAt: this.state.lostAt ?? Date.now() },
        { at: Date.now(), kind: 'lost', reason: outcome.reason, cursor: this.data.cursor },
      );
      if (outcome.immediate) {
        delay = minDelay;
        continue;
      }
      delay = outcome.receivedData ? minDelay : Math.min(delay * 2, maxDelay);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay / 2 + Math.random() * (delay / 2));
        this.wakeSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeSleep = undefined;
    }
  }

  private async connectOnce(): Promise<{
    reason: string;
    receivedData: boolean;
    immediate?: boolean;
    terminal?: 'unauthorized' | 'not_found';
  }> {
    const controller = new AbortController();
    this.controller = controller;
    const silenceMs = this.options.silenceMs ?? 15_000;
    let silence: ReturnType<typeof setTimeout> | undefined;
    let abortReason = 'aborted';
    const armSilence = () => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        abortReason = `no data for ${Math.round(silenceMs / 1000)} s`;
        controller.abort();
      }, silenceMs);
    };
    let receivedData = false;
    try {
      armSilence();
      const fetchImpl = this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));
      const base = this.options.baseUrl.replace(/\/$/, '');
      const response = await fetchImpl(`${base}/runs/${this.options.runId}/events`, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.options.apiKey}`,
          'last-event-id': String(this.data.cursor),
        },
        signal: controller.signal,
        ...({ cache: 'no-store' } as object),
      });
      if (response.status === 401) return { reason: 'unauthorized', receivedData, terminal: 'unauthorized' };
      if (response.status === 404) return { reason: 'not found', receivedData, terminal: 'not_found' };
      if (!response.ok || !response.body) return { reason: `http ${response.status}`, receivedData };

      this.catchingUpFrom = this.data.cursor;
      this.update(
        { phase: 'open', connects: this.state.connects + 1, lostAt: null },
        { at: Date.now(), kind: 'connected', cursor: this.data.cursor },
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { reason: 'stream ended', receivedData };
        armSilence();
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          receivedData = true;
          const verdict = this.handle(event);
          if (verdict === 'unauthorized') return { reason: 'key revoked', receivedData, terminal: 'unauthorized' };
          if (verdict === 'not_found') return { reason: 'run gone', receivedData, terminal: 'not_found' };
          if (verdict === 'reconnect') return { reason: 'resuming from cursor', receivedData, immediate: true };
        }
      }
    } catch (error) {
      const reason = controller.signal.aborted
        ? abortReason
        : error instanceof Error
          ? error.message
          : 'network error';
      return { reason, receivedData };
    } finally {
      clearTimeout(silence);
      controller.abort();
    }
  }

  private handle(event: SseEvent): 'continue' | 'reconnect' | 'unauthorized' | 'not_found' {
    const now = Date.now();
    if (event.event === 'points') {
      const message = JSON.parse(event.data) as PointsMessage;
      const result = this.data.apply(message);
      if (result.kind === 'gap') {
        this.update(
          { gaps: this.state.gaps + 1, lastEventAt: now },
          { at: now, kind: 'gap', expected: result.expected, got: result.got },
        );
        return 'reconnect';
      }
      if (result.kind === 'applied') {
        this.update({ version: this.state.version + 1, lastEventAt: now });
        if (result.late.length > 0) this.options.onLate?.(result.late);
        this.noteCaughtUp(now);
      }
      return 'continue';
    }
    if (event.event === 'run') {
      const run = JSON.parse(event.data) as RunStateMessage;
      // Cursors match, so the same batches have been applied on both sides and
      // the counts must agree. If they do not, this view cannot be trusted.
      const diverged =
        this.data.cursor > run.head ||
        (this.data.cursor === run.head && this.data.count !== run.points);
      if (diverged) {
        const reason =
          this.data.cursor > run.head
            ? `cursor ${this.data.cursor} is ahead of the server at ${run.head}`
            : `${this.data.count} points here, ${run.points} stored`;
        this.data.reset();
        this.update(
          { run, resyncs: this.state.resyncs + 1, version: this.state.version + 1, lastEventAt: now },
          { at: now, kind: 'resync', reason },
        );
        return 'reconnect';
      }
      this.update({ run, lastEventAt: now });
      this.noteCaughtUp(now);
      return 'continue';
    }
    if (event.event === 'reset') {
      this.data.reset();
      this.catchingUpFrom = 0;
      this.update(
        { resyncs: this.state.resyncs + 1, version: this.state.version + 1, lastEventAt: now },
        { at: now, kind: 'resync', reason: 'the server asked to start over' },
      );
      return 'continue';
    }
    if (event.event === 'bye') {
      const bye = JSON.parse(event.data) as ByeMessage;
      this.update({ lastEventAt: now }, { at: now, kind: 'bye', reason: bye.reason });
      if (bye.reason === 'key_revoked') return 'unauthorized';
      if (bye.reason === 'run_gone') return 'not_found';
      return 'continue';
    }
    return 'continue';
  }

  private noteCaughtUp(now: number): void {
    const run = this.state.run;
    if (this.catchingUpFrom === null || !run || this.data.cursor < run.head) return;
    const from = this.catchingUpFrom;
    this.catchingUpFrom = null;
    if (this.data.cursor > from) {
      this.update({}, { at: now, kind: 'caught_up', from, to: this.data.cursor });
    }
  }
}

/** In step with the server, as far as the last run state says. */
export function isLive(snapshot: StreamSnapshot): boolean {
  return snapshot.phase === 'open' && snapshot.run !== null && snapshot.cursor >= snapshot.run.head;
}
