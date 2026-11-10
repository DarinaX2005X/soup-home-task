// The mapping from a series to chart coordinates. Kept free of React so it
// can be tested on its own.

import type { Series } from '@simmer/sdk';

const MARGIN = { top: 12, right: 14, bottom: 24, left: 48 };

export interface Geometry {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  path: string;
  finite: number;
  decimated: boolean;
  x: (step: number) => number;
  y: (value: number) => number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Maps a series to SVG coordinates. While there are at most four points per
 * horizontal pixel, every finite point becomes one vertex of the path, in step
 * order. Beyond that, each pixel column keeps its lowest and highest value.
 */
export function geometry(series: Series, width: number, height: number): Geometry {
  const { steps, values } = series;
  const left = MARGIN.left;
  const right = Math.max(width - MARGIN.right, left + 10);
  const top = MARGIN.top;
  const bottom = height - MARGIN.bottom;

  let x0 = steps[0] ?? 0;
  let x1 = steps[steps.length - 1] ?? 1;
  if (x1 === x0) {
    x0 -= 0.5;
    x1 += 0.5;
  }
  let lo = Infinity;
  let hi = -Infinity;
  let finite = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    finite++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (finite === 0) {
    lo = 0;
    hi = 1;
  }
  const pad = hi === lo ? Math.max(Math.abs(hi) * 0.1, 0.5) : (hi - lo) * 0.08;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const x = (step: number) => left + ((step - x0) / (x1 - x0)) * (right - left);
  const y = (value: number) => bottom - ((value - y0) / (y1 - y0)) * (bottom - top);

  const parts: string[] = [];
  const decimated = steps.length > (right - left) * 4;
  let pen = false;
  const vertex = (step: number, value: number) => {
    parts.push(`${pen ? 'L' : 'M'}${round(x(step))},${round(y(value))}`);
    pen = true;
  };
  if (!decimated) {
    for (let i = 0; i < steps.length; i++) {
      const v = values[i]!;
      // A non-finite value breaks the line instead of being drawn somewhere.
      if (Number.isFinite(v)) vertex(steps[i]!, v);
      else pen = false;
    }
  } else {
    let column = -1;
    let minI = -1;
    let maxI = -1;
    const flush = () => {
      if (minI < 0) return;
      const [a, b] = minI <= maxI ? [minI, maxI] : [maxI, minI];
      vertex(steps[a]!, values[a]!);
      if (b !== a) vertex(steps[b]!, values[b]!);
      minI = maxI = -1;
    };
    for (let i = 0; i < steps.length; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v)) {
        flush();
        pen = false;
        continue;
      }
      const c = Math.floor(x(steps[i]!));
      if (c !== column) {
        flush();
        column = c;
      }
      if (minI < 0 || v < values[minI]!) minI = i;
      if (maxI < 0 || v > values[maxI]!) maxI = i;
    }
    flush();
  }
  return { x0, x1, y0, y1, left, right, top, bottom, path: parts.join(''), finite, decimated, x, y };
}
