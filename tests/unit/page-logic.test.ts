// The parts of the page that decide what a person sees, tested without a
// browser: how a series becomes a line, how numbers are written, and how
// stream messages become a run's state.

import { describe, expect, test } from 'vitest';
import { RunData, type PointsMessage, type Series, type WirePoint } from '@simmer/sdk';
import { formatValue } from '../../web/src/format.ts';
import { geometry } from '../../web/src/geometry.ts';
import { rng, shuffle } from '../lib/helpers.ts';

function vertices(path: string): { cmd: string; x: number; y: number }[] {
  return [...path.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)].map(([, cmd, x, y]) => ({ cmd: cmd!, x: Number(x), y: Number(y) }));
}

describe('a series drawn in full', () => {
  test('every finite point is one vertex, and a non-finite value breaks the line', () => {
    const series: Series = { steps: [0, 1, 2, 3, 4, 5], values: [1, 2, NaN, 4, Infinity, 6] };
    const g = geometry(series, 600, 200);
    expect(g.decimated).toBe(false);
    expect(g.finite).toBe(4);
    const drawn = vertices(g.path);
    expect(drawn.map((v) => v.cmd).join('')).toBe('MLMM');
    expect(drawn.map((v) => v.x)).toEqual([0, 1, 3, 5].map((step) => Math.round(g.x(step) * 100) / 100));
  });

  test('one point, equal values and an empty series do not divide by zero', () => {
    for (const series of [{ steps: [7], values: [3] }, { steps: [1, 2, 3], values: [5, 5, 5] }, { steps: [], values: [] }]) {
      const g = geometry(series, 600, 200);
      for (const v of vertices(g.path)) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
        expect(v.y).toBeGreaterThanOrEqual(g.top);
        expect(v.y).toBeLessThanOrEqual(g.bottom);
      }
    }
  });
});

describe('a series too dense to draw point by point', () => {
  const random = rng(42);
  const steps = Array.from({ length: 200_000 }, (_, i) => i * 3);
  const values = steps.map((s) => Math.sin(s / 9000) * 5 + (random() - 0.5) * 2);
  // A spike one sample wide. Thinning must not hide it.
  values[123_456] = 40;
  values[50_000] = NaN;
  const series: Series = { steps, values };
  const g = geometry(series, 700, 200);
  const drawn = vertices(g.path);

  test('is thinned to about two vertices per pixel column', () => {
    expect(g.decimated).toBe(true);
    const columns = Math.ceil(g.right - g.left) + 1;
    // Two per column, plus two more where the line breaks at the NaN.
    expect(drawn.length).toBeLessThanOrEqual(columns * 2 + 2);
    expect(drawn.length).toBeGreaterThan(columns);
  });

  test('keeps the lowest and the highest value of every pixel column, so no peak is lost', () => {
    const truth = new Map<number, { lo: number; hi: number }>();
    for (let i = 0; i < steps.length; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
      const column = Math.floor(g.x(steps[i]!));
      const t = truth.get(column) ?? { lo: Infinity, hi: -Infinity };
      t.lo = Math.min(t.lo, v);
      t.hi = Math.max(t.hi, v);
      truth.set(column, t);
    }
    const valueAt = (y: number) => g.y0 + ((g.bottom - y) / (g.bottom - g.top)) * (g.y1 - g.y0);
    const shown = new Map<number, number[]>();
    for (const v of drawn) {
      const column = Math.floor(v.x);
      shown.set(column, [...(shown.get(column) ?? []), valueAt(v.y)]);
    }
    // Drawn coordinates are rounded to a hundredth of a pixel. That can move a
    // vertex across a column edge, so a column is compared with its neighbours.
    const tolerance = ((g.y1 - g.y0) / (g.bottom - g.top)) * 0.011;
    const near = (column: number) => [column - 1, column, column + 1].flatMap((c) => shown.get(c) ?? []);
    for (const [column, t] of truth) {
      const candidates = near(column);
      expect(candidates.some((v) => Math.abs(v - t.lo) <= tolerance), `column ${column}: its lowest value is drawn`).toBe(true);
      expect(candidates.some((v) => Math.abs(v - t.hi) <= tolerance), `column ${column}: its highest value is drawn`).toBe(true);
    }
    // And nothing is drawn that the data does not contain.
    for (const [column, drawnValues] of shown) {
      const around = [column - 1, column, column + 1].map((c) => truth.get(c)).filter((t) => t !== undefined);
      const lo = Math.min(...around.map((t) => t.lo));
      const hi = Math.max(...around.map((t) => t.hi));
      for (const v of drawnValues) {
        expect(v).toBeGreaterThanOrEqual(lo - tolerance);
        expect(v).toBeLessThanOrEqual(hi + tolerance);
      }
    }
    // The one-sample spike is on the chart.
    expect(Math.max(...[...shown.values()].flat())).toBeGreaterThan(39.9);
  });

  test('goes left to right and breaks at the non-finite value', () => {
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!.x).toBeGreaterThanOrEqual(drawn[i - 1]!.x);
    expect(drawn.filter((v) => v.cmd === 'M')).toHaveLength(2);
  });
});

describe('numbers as the page writes them', () => {
  test.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [0.5, '0.5'],
    [0.123456, '0.1235'],
    [12345.678, '12350'],
    [999999, '1000000'],
    [1234567, '1.235e+6'],
    [0.0001, '0.0001'],
    [0.00001234, '1.234e-5'],
    [2e-9, '2e-9'],
    [-3.14159, '-3.142'],
    [NaN, 'NaN'],
    [Infinity, '+Inf'],
    [-Infinity, '-Inf'],
  ])('%s is written as %s', (value, text) => {
    expect(formatValue(value)).toBe(text);
  });
});

describe('stream messages becoming a run', () => {
  test('any mix of repeats and overlaps ends in the same state, and a gap is never applied', () => {
    const random = rng(7);
    for (let round = 0; round < 200; round++) {
      // The server's log: 40 batches of random points, each point stored once.
      const log: WirePoint[][] = [];
      const used = new Set<string>();
      for (let seq = 1; seq <= 40; seq++) {
        const batch: WirePoint[] = [];
        for (let n = 1 + Math.floor(random() * 6); n > 0; n--) {
          const key = `m${Math.floor(random() * 3)}`;
          const step = Math.floor(random() * 300);
          if (used.has(`${key} ${step}`)) continue;
          used.add(`${key} ${step}`);
          batch.push([key, step, random() < 0.05 ? 'NaN' : random()]);
        }
        log.push(batch);
      }
      const message = (from: number, to: number): PointsMessage => ({ from, to, points: shuffle(log.slice(from, to).flat(), random) });

      // What a flaky connection delivers: ranges that restart behind the
      // cursor, repeat, or jump ahead.
      const data = new RunData();
      let gapsOffered = 0;
      while (data.cursor < 40) {
        const roll = random();
        const from = roll < 0.25 ? Math.floor(random() * (data.cursor + 1)) : roll < 0.4 ? data.cursor + 1 + Math.floor(random() * 3) : data.cursor;
        const to = Math.min(40, from + 1 + Math.floor(random() * 6));
        if (from >= 40) continue;
        const before = { cursor: data.cursor, count: data.count };
        const result = data.apply(message(from, to));
        if (from > before.cursor) {
          gapsOffered++;
          expect(result.kind).toBe('gap');
          expect({ cursor: data.cursor, count: data.count }).toEqual(before);
        } else if (to <= before.cursor) {
          expect(result.kind).toBe('repeat');
          expect(data.count).toBe(before.count);
        } else {
          expect(result.kind).toBe('applied');
          expect(data.cursor).toBe(to);
        }
      }
      const expected = log.flat().map(([key, step, value]) => `${key} ${step} ${value}`).sort();
      const actual = [...data.points()].map(([key, step, value]) => `${key} ${step} ${value}`).sort();
      expect(actual).toEqual(expected);
      expect(data.count).toBe(expected.length);
      expect(gapsOffered).toBeGreaterThanOrEqual(0);
      for (const series of data.series.values()) {
        for (let i = 1; i < series.steps.length; i++) expect(series.steps[i]!).toBeGreaterThan(series.steps[i - 1]!);
      }
    }
  });
});
