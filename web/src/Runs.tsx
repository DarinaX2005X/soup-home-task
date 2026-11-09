import { useState } from 'react';
import type { Run } from '@simmer/sdk';
import { formatAgo, formatClock, formatCount } from './format.ts';
import { useNow, usePolled } from './hooks.ts';
import { link, navigate } from './router.ts';
import { SAMPLE_STEPS, sampleName, sendSampleRun } from './sample.ts';
import { handleAuthError, type Session } from './session.ts';
import { Button, CopyButton, Notice, StatusMark, Ticking } from './ui.tsx';

const POLL_MS = 2000;
/** A running run with no new data for this long is called out. */
const QUIET_MS = 60_000;

function quickstart(origin: string): string {
  return [
    `export SIMMER=${origin}/api`,
    `export KEY=sk_...   # your API key`,
    ``,
    `# 1. Create a run`,
    `RUN=$(curl -s -X POST $SIMMER/runs -H "authorization: Bearer $KEY" \\`,
    `  -H "content-type: application/json" -d '{"name":"first-run"}' | sed 's/.*"id":"\\([^"]*\\)".*/\\1/')`,
    ``,
    `# 2. Send a batch. Reuse the same batch_id if you have to retry it.`,
    `curl -s -X POST $SIMMER/runs/$RUN/metrics -H "authorization: Bearer $KEY" \\`,
    `  -H "content-type: application/json" -d '{`,
    `    "batch_id": "6f1c2b7e-0d4b-4a59-9c1e-3b1f2a7d9e10",`,
    `    "points": [`,
    `      {"key": "train/loss", "step": 0, "value": 2.31},`,
    `      {"key": "train/loss", "step": 1, "value": 2.08}`,
    `    ]`,
    `  }'`,
  ].join('\n');
}

function RunRow({ run, now }: { run: Run; now: number }) {
  const updated = Date.parse(run.updated_at);
  const quiet = run.status === 'running' && run.points > 0 && now - updated > QUIET_MS;
  return (
    <a className="run-row" data-testid="run-row" data-run={run.id} {...link(`/runs/${run.id}`)}>
      <span className="run-name">{run.name}</span>
      <span className="run-status">
        <StatusMark status={run.status} />
        {quiet && <span className="run-quiet">no data for {formatAgo(updated, now).replace(' ago', '')}</span>}
      </span>
      <span className="run-number">
        <Ticking value={run.points}>{formatCount(run.points)}</Ticking>
      </span>
      <span className="run-time">{run.points > 0 ? formatAgo(updated, now) : 'no data yet'}</span>
      <span className="run-time">{formatAgo(Date.parse(run.created_at), now)}</span>
    </a>
  );
}

export function Runs({ session }: { session: Session }) {
  const now = useNow();
  const { data, error, fetchedAt, refresh } = usePolled((signal) => session.client.listRuns(signal), POLL_MS);
  const [sample, setSample] = useState<'idle' | 'starting' | 'failed'>('idle');

  const startSample = async () => {
    setSample('starting');
    try {
      navigate(`/runs/${await sendSampleRun(session.client, sampleName())}`);
    } catch (e) {
      if (!handleAuthError(e)) setSample('failed');
    }
  };

  const runs = data?.runs;
  const stale = error !== null && fetchedAt !== null;

  return (
    <main className="page">
      <header className="page-head">
        <h1>Runs</h1>
        <div className="row">
          <Button variant="primary" onClick={startSample} busy={sample === 'starting'} data-testid="sample">
            {sample === 'starting' ? 'Starting' : 'Send a sample run'}
          </Button>
        </div>
      </header>

      {sample === 'failed' && (
        <Notice tone="error">The sample run could not be started. Nothing was sent. Try again.</Notice>
      )}
      {stale && (
        <Notice tone="warn">
          The list could not be refreshed. It shows the runs as they were at {formatClock(fetchedAt!)} and retries every
          two seconds. <button className="linklike" onClick={refresh}>Retry now</button>
        </Notice>
      )}
      {error !== null && fetchedAt === null && (
        <Notice tone="error">
          The runs could not be loaded. <button className="linklike" onClick={refresh}>Try again</button>
        </Notice>
      )}

      {runs && runs.length > 0 && (
        <section className="runs" data-testid="runs">
          <div className="runs-head">
            <span>Name</span>
            <span>Status</span>
            <span className="run-number">Points</span>
            <span>Last data</span>
            <span>Created</span>
          </div>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} now={now} />
          ))}
        </section>
      )}

      {runs && runs.length === 0 && (
        <section className="empty" data-testid="empty">
          <h2>No runs yet</h2>
          <p>
            A run appears here as soon as a script creates it. To see a live page right away, send a sample run: this
            browser will post {SAMPLE_STEPS} training steps over 30 seconds through the same API, with some batches
            deliberately delayed, repeated and out of order.
          </p>
        </section>
      )}

      {runs && (
        <section className="quickstart">
          <div className="quickstart-head">
            <h2>Send metrics from your code</h2>
            <CopyButton text={quickstart(location.origin)} label="Copy commands" />
          </div>
          <p>
            A point is a metric name, a step and a value. Send points in batches of up to 1000. Every batch carries an
            id you choose: if the answer gets lost, send the same batch again with the same id and it is stored once.
          </p>
          <pre>
            <code>{quickstart(location.origin)}</code>
          </pre>
        </section>
      )}
    </main>
  );
}
