import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  decodeValue,
  type Run,
  type RunData,
  type StreamLogEntry,
  type StreamSnapshot,
} from '@simmer/sdk';
import { Chart } from './Chart.tsx';
import { formatClock, formatCount, formatDuration, formatValue, plural } from './format.ts';
import { useLiveRun, useNow } from './hooks.ts';
import { link } from './router.ts';
import { handleAuthError, type Session } from './session.ts';
import { Button, Notice, StatusMark, Ticking } from './ui.tsx';

type Sync = 'connecting' | 'live' | 'catching_up' | 'offline' | 'not_found';

function syncOf(s: StreamSnapshot): Sync {
  if (s.phase === 'not_found') return 'not_found';
  if (s.phase === 'open' && s.run) return s.cursor >= s.run.head ? 'live' : 'catching_up';
  // Paused in a background tab. Nobody is looking, and it reconnects on return.
  if (s.phase === 'paused') return 'connecting';
  // Before the first connection there is nothing stale on screen yet.
  return s.connects === 0 && s.lostAt === null ? 'connecting' : 'offline';
}

interface MetricSummary {
  key: string;
  count: number;
  lastStep: number;
  lastValue: number;
  min: number;
  max: number;
  nonFinite: number;
}

function summarize(data: RunData): MetricSummary[] {
  // With a thinned history the points on the page cannot give exact figures.
  // They come from the server's overview and are updated by every new point.
  if (data.stats) {
    return [...data.stats.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, s]) => ({
        key,
        count: s.count,
        lastStep: s.lastStep,
        lastValue: s.lastValue,
        min: s.lo,
        max: s.hi,
        nonFinite: s.nonFinite,
      }));
  }
  const out: MetricSummary[] = [];
  for (const key of [...data.series.keys()].sort()) {
    const { steps, values } = data.series.get(key)!;
    let min = Infinity;
    let max = -Infinity;
    let nonFinite = 0;
    for (const v of values) {
      if (!Number.isFinite(v)) nonFinite++;
      else {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    out.push({
      key,
      count: steps.length,
      lastStep: steps[steps.length - 1]!,
      lastValue: values[values.length - 1]!,
      min: min === Infinity ? NaN : min,
      max: max === -Infinity ? NaN : max,
      nonFinite,
    });
  }
  return out;
}

const csvLine = (key: string, step: number, value: number) => `${key},${step},${value}`;

function csvOf(data: RunData): string {
  const lines = ['key,step,value'];
  for (const [key, step, value] of data.points()) lines.push(csvLine(key, step, value));
  return lines.join('\n') + '\n';
}

/** Every stored point, read from the API page by page. Used when the page itself holds a thinned history. */
async function csvFromServer(session: Session, runId: string, onProgress: (points: number) => void): Promise<string> {
  const rows: [string, number, number][] = [];
  for (let after = 0; ; ) {
    const page = await session.client.getMetrics(runId, after, 20_000);
    for (const [key, step, value] of page.points) rows.push([key, step, decodeValue(value)!]);
    onProgress(rows.length);
    after = page.to;
    if (!page.has_more) break;
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return ['key,step,value', ...rows.map((r) => csvLine(...r))].join('\n') + '\n';
}

function describe(entry: StreamLogEntry): string {
  switch (entry.kind) {
    case 'connected':
      return entry.cursor === 0 ? 'Connected and asked for everything' : `Connected and asked for what came after batch ${entry.cursor}`;
    case 'caught_up':
      return entry.from === 0
        ? `Received batches 1 to ${entry.to}`
        : `Received the missed batches ${entry.from + 1} to ${entry.to}`;
    case 'lost':
      return `Connection lost at batch ${entry.cursor} (${entry.reason})`;
    case 'gap':
      return `A message skipped from batch ${entry.expected} to ${entry.got}. It was not applied, and the page reconnected from batch ${entry.expected}`;
    case 'resync':
      return `Discarded the local copy and reloaded: ${entry.reason}`;
    case 'paused':
      return `Disconnected at batch ${entry.cursor} while this tab was in the background`;
    case 'bye':
      return entry.reason === 'key_revoked' ? 'The server closed the stream because the key was revoked' : 'The server closed the stream and asked to reconnect';
  }
}

function SyncChip({ sync, snapshot, now, open, onToggle }: { sync: Sync; snapshot: StreamSnapshot; now: number; open: boolean; onToggle: () => void }) {
  const behind = snapshot.run ? Math.max(snapshot.run.head - snapshot.cursor, 0) : 0;
  const label =
    sync === 'live'
      ? snapshot.run?.status === 'running'
        ? 'Live'
        : 'Up to date'
      : sync === 'catching_up'
        ? `Catching up, ${plural(behind, 'batch', 'batches')} behind`
        : sync === 'connecting'
          ? 'Connecting'
          : snapshot.lostAt && now - snapshot.lostAt >= 1000
            ? `Offline for ${formatDuration(now - snapshot.lostAt)}`
            : 'Offline';
  return (
    <button
      className={`sync sync-${sync}`}
      onClick={onToggle}
      aria-expanded={open}
      data-testid="sync"
      data-state={sync}
      data-cursor={snapshot.cursor}
      data-count={snapshot.count}
      data-thinned={snapshot.thinned ? 'yes' : 'no'}
      data-connects={snapshot.connects}
      data-resyncs={snapshot.resyncs}
      data-gaps={snapshot.gaps}
    >
      <span className="sync-dot" aria-hidden="true" />
      {label}
    </button>
  );
}

function ConnectionPanel({ snapshot }: { snapshot: StreamSnapshot }) {
  const entries = [...snapshot.log].reverse();
  return (
    <section className="connection" data-testid="connection">
      <dl>
        <div>
          <dt>Applied here</dt>
          <dd>
            batch {formatCount(snapshot.cursor)}, {plural(snapshot.count, 'point')}
          </dd>
        </div>
        <div>
          <dt>Stored on the server</dt>
          <dd>{snapshot.run ? `batch ${formatCount(snapshot.run.head)}, ${plural(snapshot.run.points, 'point')}` : 'not known yet'}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{snapshot.connects}</dd>
        </div>
        <div>
          <dt>Full reloads</dt>
          <dd>{snapshot.resyncs}</dd>
        </div>
      </dl>
      <p className="connection-note">
        The page keeps the number of the last batch it applied. After a disconnect it asks the server for everything
        after that number, and whenever both numbers match it compares the point counts.
      </p>
      <ol>
        {entries.map((entry, i) => (
          <li key={`${entry.at}-${i}`} className={`log-${entry.kind}`}>
            <time>{formatClock(entry.at)}</time>
            <span>{describe(entry)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RunPage({ session, runId }: { session: Session; runId: string }) {
  const { data, snapshot, late } = useLiveRun(session, runId);
  const now = useNow();
  const [run, setRun] = useState<Run | null>(null);
  const [missing, setMissing] = useState(false);
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [showConnection, setShowConnection] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    session.client.getRun(runId, controller.signal).then(setRun, (error) => {
      if (controller.signal.aborted || handleAuthError(error)) return;
      if (error instanceof ApiError && error.status === 404) setMissing(true);
    });
    return () => controller.abort();
  }, [session, runId]);

  const sync = syncOf(snapshot);
  // `data` is mutated in place, `version` is what says it changed.
  const summary = useMemo(() => summarize(data), [data, snapshot.version]);
  const onHover = useCallback((step: number | null) => setHoverStep(step), []);

  const [exporting, setExporting] = useState<number | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const download = async () => {
    let csv: string;
    if (data.thinned) {
      setExporting(0);
      setExportFailed(false);
      try {
        csv = await csvFromServer(session, runId, setExporting);
      } catch (error) {
        if (!handleAuthError(error)) setExportFailed(true);
        return;
      } finally {
        setExporting(null);
      }
    } else csv = csvOf(data);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${run?.name ?? 'run'}-${runId.slice(0, 8)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (missing || sync === 'not_found') {
    return (
      <main className="page">
        <section className="empty" data-testid="not-found">
          <h2>This run is not in this project</h2>
          <p>The address may be mistyped, or the run belongs to a project that this key cannot open.</p>
          <a className="button button-quiet" {...link('/')}>
            Back to runs
          </a>
        </section>
      </main>
    );
  }

  const status = snapshot.run?.status ?? run?.status;
  const conflicts = snapshot.run?.conflicts ?? run?.conflicts ?? 0;
  const offline = sync === 'offline';

  return (
    <main className="page" data-testid="run-page" data-run={runId}>
      <a className="back" {...link('/')}>
        All runs
      </a>
      <header className="page-head run-head">
        <div>
          <h1>{run?.name ?? ' '}</h1>
          <div className="run-meta">
            {status && <StatusMark status={status} />}
            <span data-testid="total-points">
              <Ticking value={snapshot.count}>{plural(snapshot.count, 'point')}</Ticking>
            </span>
            <span>{plural(summary.length, 'metric')}</span>
          </div>
        </div>
        <div className="row">
          <SyncChip sync={sync} snapshot={snapshot} now={now} open={showConnection} onToggle={() => setShowConnection((v) => !v)} />
          <Button onClick={download} disabled={snapshot.count === 0} busy={exporting !== null} data-testid="export">
            {exporting !== null ? `Reading ${formatCount(exporting)} points` : 'Export CSV'}
          </Button>
        </div>
      </header>

      {showConnection && <ConnectionPanel snapshot={snapshot} />}

      {offline && (
        <Notice tone="warn">
          The connection to the server is lost
          {snapshot.lostAt ? ` since ${formatClock(snapshot.lostAt)}` : ''}. The charts show what had arrived by then.
          Batches that are stored in the meantime will appear when the connection returns.
        </Notice>
      )}
      {exportFailed && (
        <Notice tone="error">The export could not be read from the server. Nothing was downloaded. Try again.</Notice>
      )}
      {data.thinned && (
        <Notice tone="info">
          <span data-testid="thinned">
            This run is long, so its history is drawn from {formatCount(data.thinned.shown)} of the{' '}
            {formatCount(data.thinned.total)} points stored when the page opened: the lowest and the highest value in
            each slice of every metric, so peaks stay visible. Points that arrived since are all shown. The figures in
            the table are exact, and Export CSV downloads every point.
          </span>
        </Notice>
      )}
      {conflicts > 0 && (
        <Notice tone="warn">
          {plural(conflicts, 'point')} {conflicts === 1 ? 'was' : 'were'} sent again with a different value. The first
          stored value was kept each time, and the sender was told which points were refused.
        </Notice>
      )}

      {summary.length === 0 && sync !== 'connecting' && (
        <section className="empty" data-testid="no-points">
          <h2>Waiting for the first batch</h2>
          <p>Nothing has been stored for this run yet. Charts appear here as soon as a batch arrives, without a reload.</p>
        </section>
      )}

      <section className={`charts ${offline ? 'is-stale' : ''}`}>
        {summary.map((metric) => (
          <article className="metric" key={metric.key} data-testid="metric" data-metric={metric.key}>
            <header>
              <h2>{metric.key}</h2>
              <p className="metric-last">
                <strong>{formatValue(metric.lastValue)}</strong>
                <span>at step {formatCount(metric.lastStep)}</span>
              </p>
            </header>
            <Chart
              metric={metric.key}
              series={data.series.get(metric.key)!}
              version={snapshot.version}
              hoverStep={hoverStep}
              onHover={onHover}
              late={late.get(metric.key)}
            />
          </article>
        ))}
      </section>

      {summary.length > 0 && (
        <section className="summary">
          <h2>All metrics</h2>
          <table data-testid="summary">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">Points</th>
                <th className="num">Last step</th>
                <th className="num">Last value</th>
                <th className="num">Lowest</th>
                <th className="num">Highest</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((m) => (
                <tr key={m.key} data-metric={m.key}>
                  <th scope="row">{m.key}</th>
                  <td className="num" data-col="count">{m.count}</td>
                  <td className="num" data-col="last-step">{m.lastStep}</td>
                  <td className="num" data-col="last-value">{formatValue(m.lastValue)}</td>
                  <td className="num" data-col="min">{formatValue(m.min)}</td>
                  <td className="num" data-col="max">
                    {formatValue(m.max)}
                    {m.nonFinite > 0 && <span className="nonfinite">{m.nonFinite} not finite</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
