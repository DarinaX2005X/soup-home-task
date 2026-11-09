import { ApiError, type Client } from './client.ts';
import {
  encodeValue,
  uuidv4,
  type BatchRequest,
  type BatchResult,
  type Point,
} from './protocol.ts';

export interface RetryOptions {
  /** Time allowed for one attempt before it is abandoned and retried. */
  timeoutMs?: number;
  maxAttempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, reason: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryReason(error: unknown): string | null {
  if (error instanceof ApiError) {
    const transient = error.status === 408 || error.status === 429 || error.status >= 500;
    return transient ? `http ${error.status}` : null;
  }
  // fetch rejects on a refused, reset or timed out connection. The batch may
  // or may not have been stored, which is why the retry keeps its batch_id.
  return error instanceof Error ? error.name : 'network';
}

/**
 * Sends one batch until the server acknowledges it. Every attempt carries the
 * same batch_id, so a batch whose answer was lost is not stored twice.
 */
export async function sendBatch(
  client: Client,
  runId: string,
  batch: BatchRequest,
  options: RetryOptions = {},
): Promise<{ result: BatchResult; attempts: number }> {
  const { timeoutMs = 10_000, maxAttempts = 10, minDelayMs = 100, maxDelayMs = 5_000 } = options;
  let delay = minDelayMs;
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await client.sendMetrics(runId, batch, controller.signal);
      return { result, attempts: attempt };
    } catch (error) {
      const reason = retryReason(error);
      if (reason === null || attempt >= maxAttempts) throw error;
      options.onRetry?.(attempt, reason);
    } finally {
      clearTimeout(timer);
    }
    await sleep(delay / 2 + Math.random() * (delay / 2));
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

export function makeBatch(points: Point[], batchId: string = uuidv4()): BatchRequest {
  return {
    batch_id: batchId,
    points: points.map((p) => ({ key: p.key, step: p.step, value: encodeValue(p.value) })),
  };
}

export interface LoggerOptions extends RetryOptions {
  maxBatch?: number;
  flushMs?: number;
  onResult?: (result: BatchResult, attempts: number) => void;
  onError?: (error: unknown) => void;
}

/** Buffers points and ships them in batches, the way a training script would. */
export class MetricLogger {
  private buffer: Point[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly client: Client;
  private readonly runId: string;
  private readonly options: LoggerOptions;

  constructor(client: Client, runId: string, options: LoggerOptions = {}) {
    this.client = client;
    this.runId = runId;
    this.options = options;
  }

  log(key: string, step: number, value: number): void {
    this.buffer.push({ key, step, value });
    if (this.buffer.length >= (this.options.maxBatch ?? 100)) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), this.options.flushMs ?? 1000);
    }
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buffer.length === 0) return this.inFlight;
    const batch = makeBatch(this.buffer);
    this.buffer = [];
    this.inFlight = this.inFlight.then(async () => {
      try {
        const { result, attempts } = await sendBatch(this.client, this.runId, batch, this.options);
        this.options.onResult?.(result, attempts);
      } catch (error) {
        this.options.onError?.(error);
      }
    });
    return this.inFlight;
  }
}
