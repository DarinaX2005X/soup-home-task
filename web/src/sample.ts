import { makeBatch, sendBatch, type Client, type Point } from '@simmer/sdk';

export const SAMPLE_STEPS = 300;
const STEPS_PER_SECOND = 10;
const STEPS_PER_BATCH = 5;

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

/** One step of a plausible training run. */
export function sampleStep(step: number): Point[] {
  const t = step / SAMPLE_STEPS;
  const points: Point[] = [
    { key: 'train/loss', step, value: 2.2 * Math.exp(-4 * t) + 0.18 + noise(step) * 0.12 * (1 - t * 0.6) },
    { key: 'train/accuracy', step, value: Math.min(0.97, 0.12 + 0.85 * (1 - Math.exp(-5 * t)) + noise(step + 900) * 0.03) },
    { key: 'lr', step, value: step < 30 ? (step / 30) * 3e-4 : 3e-4 * 0.5 * (1 + Math.cos(Math.PI * ((step - 30) / (SAMPLE_STEPS - 30)))) },
  ];
  if (step % 10 === 0) {
    points.push({ key: 'val/loss', step, value: 2.1 * Math.exp(-3.2 * t) + 0.31 + noise(step + 300) * 0.05 });
  }
  return points;
}

/**
 * Sends a sample run from this browser through the public API, over a
 * deliberately bad network of our own making: one batch in five is held back
 * for a few seconds, one in seven is sent twice, and batches overtake each
 * other. The page that shows the run only ever sees what the server stored.
 */
export async function sendSampleRun(client: Client, name: string): Promise<string> {
  const run = await client.createRun(name);
  void (async () => {
    const sends: Promise<unknown>[] = [];
    const ship = (points: Point[], delayMs: number, twice: boolean) => {
      const batch = makeBatch(points);
      const go = () => sendBatch(client, run.id, batch).catch(() => {});
      sends.push(new Promise((resolve) => setTimeout(() => resolve(go()), delayMs)));
      if (twice) sends.push(new Promise((resolve) => setTimeout(() => resolve(go()), delayMs + 400)));
    };
    for (let start = 0; start < SAMPLE_STEPS; start += STEPS_PER_BATCH) {
      const points: Point[] = [];
      for (let step = start; step < start + STEPS_PER_BATCH; step++) points.push(...sampleStep(step));
      const index = start / STEPS_PER_BATCH;
      const held = index % 5 === 3 ? 1500 + ((index * 37) % 5) * 500 : 0;
      ship(points, held, index % 7 === 2);
      await new Promise((resolve) => setTimeout(resolve, (STEPS_PER_BATCH / STEPS_PER_SECOND) * 1000));
    }
    await Promise.all(sends);
    await client.finishRun(run.id).catch(() => {});
  })();
  return run.id;
}

const ADJECTIVES = ['amber', 'brisk', 'calm', 'dusty', 'eager', 'faint', 'gentle', 'hazy', 'ivory', 'keen'];
const NOUNS = ['harbor', 'meadow', 'lantern', 'orchard', 'ridge', 'thicket', 'tide', 'valley', 'willow', 'ember'];

export function sampleName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;
  return `sample-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
