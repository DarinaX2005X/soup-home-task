// Does response time tell project A whether an id exists in project B?
//
// Three kinds of request are interleaved, all made with A's key:
//   foreign  GET /runs/<a real run of project B>
//   missing  GET /runs/<a random id>
//   missing2 GET /runs/<another random id>     (the noise floor)
// If "foreign" differs from "missing" by clearly more than "missing" differs
// from "missing2", time is a side channel.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { uuidv4 } from '@simmer/sdk';
import { API_URL, EVIDENCE_DIR } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, series } from '../lib/helpers.ts';

const N = Number(process.env.N ?? 4000);
const lines: string[] = [];
const say = (line = '') => {
  lines.push(line);
  console.log(line);
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * q)]!;

async function main() {
  const a = await newTenant('timing-a');
  const b = await newTenant('timing-b');
  const runB = await b.client.createRun('timing-target');
  // Make the foreign run heavy, so any accidental work on it would show.
  for (let i = 0; i < 50; i++) await b.client.sendMetrics(runB.id, batchOf(series('m', i * 1000, i * 1000 + 1000)));

  const headers = { authorization: `Bearer ${a.secret}` };
  const time = async (id: string, suffix: string) => {
    const start = performance.now();
    const response = await fetch(`${API_URL}/runs/${id}${suffix}`, { headers });
    await response.arrayBuffer();
    if (response.status !== 404) throw new Error(`expected 404, got ${response.status}`);
    return performance.now() - start;
  };

  say(`# Timing: can project A tell a run of project B from a run that does not exist?`);
  say(`${N} requests of each kind per endpoint, interleaved in random order, one at a time`);
  say(`the foreign run holds 50 000 points`);
  say();
  for (const suffix of ['', '/metrics', '/events']) {
    const samples: Record<'foreign' | 'missing' | 'missing2', number[]> = { foreign: [], missing: [], missing2: [] };
    for (let i = 0; i < 200; i++) await time(uuidv4(), suffix);
    for (let i = 0; i < N * 3; i++) {
      const kinds = ['foreign', 'missing', 'missing2'] as const;
      const kind = kinds[Math.floor(Math.random() * 3)]!;
      samples[kind].push(await time(kind === 'foreign' ? runB.id : uuidv4(), suffix));
    }
    const m = { foreign: median(samples.foreign), missing: median(samples.missing), missing2: median(samples.missing2) };
    const signal = Math.abs(m.foreign - m.missing);
    const noise = Math.abs(m.missing - m.missing2);
    say(`GET /runs/{id}${suffix}`);
    for (const kind of ['foreign', 'missing', 'missing2'] as const) {
      say(
        `  ${kind.padEnd(9)} n=${String(samples[kind].length).padEnd(5)} median ${m[kind].toFixed(3)} ms   p10 ${quantile(samples[kind], 0.1).toFixed(3)}   p90 ${quantile(samples[kind], 0.9).toFixed(3)}`,
      );
    }
    say(`  foreign vs missing: ${(signal * 1000).toFixed(0)} µs apart.  missing vs missing: ${(noise * 1000).toFixed(0)} µs apart (noise floor).`);
    say();
  }
  say('Reading: a difference of the same size as the noise floor is no usable signal at this sample size.');
  say('This was measured over the Docker network on one machine. It cannot rule out a difference smaller than the noise.');

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, 'timing.txt'), lines.join('\n') + '\n');
  }
  await closeOwner();
}

void main();
