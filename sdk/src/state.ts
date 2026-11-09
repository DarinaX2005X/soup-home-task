import { decodeValue, type PointsMessage, type WirePoint } from './protocol.ts';

export interface Series {
  /** Ascending, unique. */
  steps: number[];
  values: number[];
}

export type ApplyResult =
  | { kind: 'applied'; added: number; late: LatePoint[] }
  | { kind: 'repeat' }
  | { kind: 'gap'; expected: number; got: number };

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
  count = 0;
  readonly series = new Map<string, Series>();

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
    this.series.clear();
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
      this.count++;
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
    this.count++;
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
