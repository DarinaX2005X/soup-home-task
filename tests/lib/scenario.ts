import { makeBatch, uuidv4, type BatchRequest, type Point } from '@simmer/sdk';
import { shuffle } from './helpers.ts';

export interface Delivery {
  batch: BatchRequest;
  kind: 'first' | 'same batch again' | 'overlap under a new id' | 'conflict';
  late: boolean;
}

export interface Scenario {
  /** What must end up stored: every generated point, with its first value. */
  truth: Map<string, number>;
  /** Sent concurrently, in this (shuffled) order. */
  main: Delivery[];
  /** Held back and sent after everything else, while the page is offline. */
  late: Delivery[];
  /** Sent last, one at a time: stored points resent with other values. */
  conflicts: Delivery[];
  counts: { points: number; batches: number; repeats: number; overlaps: number; late: number; conflicts: number; nonFinite: number };
}

const STEPS = 600;

function valuesAt(step: number, random: () => number): Point[] {
  const t = step / STEPS;
  const points: Point[] = [
    { key: 'train/loss', step, value: 2.3 * Math.exp(-4 * t) + 0.2 + (random() - 0.5) * 0.1 },
    { key: 'train/accuracy', step, value: 0.1 + 0.85 * (1 - Math.exp(-5 * t)) + (random() - 0.5) * 0.02 },
    { key: 'lr', step, value: 3e-4 * 0.5 * (1 + Math.cos(Math.PI * t)) },
  ];
  // A gradient norm that blows up now and then, as they do.
  const roll = random();
  const norm = roll < 0.01 ? NaN : roll < 0.02 ? Infinity : roll < 0.025 ? -Infinity : 1 + random() * 4;
  points.push({ key: 'grad/norm', step, value: norm });
  if (step % 5 === 0) points.push({ key: 'val/loss', step, value: 2.2 * Math.exp(-3 * t) + 0.3 + (random() - 0.5) * 0.04 });
  return points;
}

/**
 * Builds the traffic for one consistency run from a seed: every point of five
 * metrics over 600 steps, cut into small batches, then reordered, repeated,
 * overlapped, delayed and contradicted.
 */
export function buildScenario(random: () => number): Scenario {
  const truth = new Map<string, number>();
  const originals: BatchRequest[] = [];
  const originalPoints: Point[][] = [];
  let nonFinite = 0;
  for (let step = 0; step < STEPS; ) {
    const width = 1 + Math.floor(random() * 6);
    const points: Point[] = [];
    for (let s = step; s < Math.min(step + width, STEPS); s++) {
      for (const point of valuesAt(s, random)) {
        points.push(point);
        truth.set(`${point.key} ${point.step}`, point.value);
        if (!Number.isFinite(point.value)) nonFinite++;
      }
    }
    originals.push(makeBatch(shuffle(points, random)));
    originalPoints.push(points);
    step += width;
  }

  const deliveries: { order: number; delivery: Delivery }[] = [];
  let repeats = 0;
  let overlaps = 0;
  originals.forEach((batch, index) => {
    // Out of order: each batch may move up to 20 places either way.
    const late = random() < 0.15;
    deliveries.push({ order: index + (random() - 0.5) * 40, delivery: { batch, kind: 'first', late } });
    if (random() < 0.2) {
      repeats++;
      deliveries.push({
        order: index + random() * 30,
        delivery: { batch, kind: 'same batch again', late: late || random() < 0.3 },
      });
    }
    if (index > 0 && random() < 0.12) {
      // A client that lost track and resends old points under a fresh id.
      overlaps++;
      const mixed = [...originalPoints[index]!, ...originalPoints[index - 1]!.slice(0, 3)];
      deliveries.push({
        order: index + 5 + random() * 30,
        delivery: { batch: makeBatch(mixed, uuidv4()), kind: 'overlap under a new id', late },
      });
    }
  });
  deliveries.sort((a, b) => a.order - b.order);

  const conflicts: Delivery[] = [];
  for (let i = 0; i < 6; i++) {
    const source = originalPoints[Math.floor(random() * originalPoints.length)]!;
    const victim = source.find((p) => Number.isFinite(p.value))!;
    conflicts.push({
      batch: makeBatch([{ ...victim, value: victim.value + 1000 }]),
      kind: 'conflict',
      late: true,
    });
  }

  const main = deliveries.filter((d) => !d.delivery.late).map((d) => d.delivery);
  const late = deliveries.filter((d) => d.delivery.late).map((d) => d.delivery);
  return {
    truth,
    main,
    late,
    conflicts,
    counts: {
      points: truth.size,
      batches: originals.length,
      repeats,
      overlaps,
      late: late.length,
      conflicts: conflicts.length,
      nonFinite,
    },
  };
}
