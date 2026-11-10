import { decodeValue, type Overview, type PointsMessage, type WirePoint } from './protocol.ts';

export interface Series {
  /** Ascending, unique. */
  steps: number[];
  values: number[];
}

export type ApplyResult =
  | { kind: 'applied'; added: number; late: LatePoint[] }
  | { kind: 'repeat' }
  | { kind: 'gap'; expected: number; got: number };

/** Exact figures for one metric, kept up to date as points arrive. */
export interface MetricStats {
  count: number;
  lo: number;
  hi: number;
  nonFinite: number;
  lastStep: number;
  lastValue: number;
}

export interface LatePoint {
  key: string;
  step: number;
}

/**
 * Everything a reader knows about one run: the points it has applied and the
 * cursor up to which it has applied them. The web page, the sample client and
 * the tests all build their view of a run through this one class.
 */
export class RunData {
  cursor = 0;
  /** Stored points this view accounts for. Compared with the server's count. */
  count = 0;
  /** Points actually held here. Less than `count` when the history is thinned. */
  held = 0;
  readonly series = new Map<string, Series>();
  /**
   * Set when the view started from an overview instead of the full log: the
   * history before `head` is a thinned line, and `stats` carries the exact
   * figures the thinned points can no longer give.
   */
  thinned: { head: number; total: number; shown: number } | null = null;
  stats: Map<string, MetricStats> | null = null;

  /** Starts from an overview. The stream then continues from its head. */
  seed(overview: Overview): void {
    this.reset();
    this.cursor = overview.head;
    this.count = overview.points;
    this.stats = new Map();
    for (const metric of overview.metrics) {
      this.series.set(metric.key, {
        steps: metric.points.map((p) => p[0]),
        values: metric.points.map((p) => p[1]),
      });
      this.held += metric.points.length;
      this.stats.set(metric.key, {
        count: metric.count,
        lo: metric.lo ?? NaN,
        hi: metric.hi ?? NaN,
        nonFinite: metric.non_finite,
        lastStep: metric.last_step,
        lastValue: decodeValue(metric.last_value) ?? NaN,
      });
    }
    this.thinned = { head: overview.head, total: overview.points, shown: this.held };
  }

  /**
   * Applies a stream message. A message that does not continue from the
   * current cursor is never applied: a repeat is ignored and a gap is reported
   * so the caller can reconnect from `cursor`.
   */
  apply(message: PointsMessage): ApplyResult {
    if (message.to <= this.cursor) return { kind: 'repeat' };
    if (message.from > this.cursor) {
      return { kind: 'gap', expected: this.cursor, got: message.from };
    }
    // from <= cursor < to. An overlap is safe because insert() is idempotent.
    let added = 0;
    const late: LatePoint[] = [];
    for (const point of message.points) {
      const result = this.insert(point);
      if (result === 'new') added++;
      if (result === 'late') {
        added++;
        late.push({ key: point[0], step: point[1] });
      }
    }
    this.cursor = message.to;
    return { kind: 'applied', added, late };
  }

  reset(): void {
    this.cursor = 0;
    this.count = 0;
    this.held = 0;
    this.series.clear();
    this.thinned = null;
    this.stats = null;
  }

  private account(key: string, step: number, value: number): void {
    this.count++;
    this.held++;
    if (!this.stats) return;
    let s = this.stats.get(key);
    if (!s) this.stats.set(key, (s = { count: 0, lo: NaN, hi: NaN, nonFinite: 0, lastStep: -1, lastValue: NaN }));
    s.count++;
    if (!Number.isFinite(value)) s.nonFinite++;
    else {
      if (!(s.lo <= value)) s.lo = value;
      if (!(s.hi >= value)) s.hi = value;
    }
    if (step > s.lastStep) {
      s.lastStep = step;
      s.lastValue = value;
    }
  }

  private insert([key, step, wire]: WirePoint): 'new' | 'late' | 'known' {
    const value = decodeValue(wire);
    if (value === undefined) throw new Error(`Unreadable value for ${key}@${step}`);
    let series = this.series.get(key);
    if (!series) {
      series = { steps: [], values: [] };
      this.series.set(key, series);
    }
    const { steps, values } = series;
    const last = steps.length - 1;
    if (last < 0 || step > steps[last]!) {
      steps.push(step);
      values.push(value);
      this.account(key, step, value);
      return 'new';
    }
    let lo = 0;
    let hi = last;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = steps[mid]!;
      if (at === step) return 'known';
      if (at < step) lo = mid + 1;
      else hi = mid - 1;
    }
    steps.splice(lo, 0, step);
    values.splice(lo, 0, value);
    this.account(key, step, value);
    return 'late';
  }

  /** All points ordered by key, then step. */
  *points(): Generator<[key: string, step: number, value: number]> {
    const keys = [...this.series.keys()].sort();
    for (const key of keys) {
      const series = this.series.get(key)!;
      for (let i = 0; i < series.steps.length; i++) {
        yield [key, series.steps[i]!, series.values[i]!];
      }
    }
  }
}
