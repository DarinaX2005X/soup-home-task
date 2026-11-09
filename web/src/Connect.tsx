import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, Client, RunData } from '@simmer/sdk';
import { Chart, type LateMark } from './Chart.tsx';
import { API_BASE, signIn, type SignedOutReason } from './session.ts';
import { Button, CopyButton, Logo, Notice } from './ui.tsx';

const KEY_SHAPE = /^sk_[A-Za-z0-9_-]{43}$/;

/**
 * A loss curve assembled from batches that arrive in the wrong order, drawn by
 * the same chart and the same reducer the run page uses. Nothing here touches
 * the server: it only shows why arrival order does not change the picture.
 */
function ArrivalIllustration() {
  const [, setFrame] = useState(0);
  const state = useRef({ data: new RunData(), late: [] as LateMark[], seq: 0 });

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const points: [string, number, number][] = [];
      for (let step = 0; step < 120; step++) points.push(['loss', step, lossAt(step)]);
      state.current.data.apply({ from: 0, to: 1, points });
      setFrame((n) => n + 1);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let batches: number[] = [];
    const refill = () => {
      state.current = { data: new RunData(), late: [], seq: 0 };
      // Batches of four steps. Every fourth batch is held back and lands later.
      const order = Array.from({ length: 30 }, (_, i) => i);
      const held = order.filter((i) => i % 4 === 2);
      batches = order.filter((i) => i % 4 !== 2);
      held.forEach((batch, n) => batches.splice(Math.min(batches.length, 6 + n * 4), 0, batch));
    };
    refill();
    const tick = () => {
      const s = state.current;
      const batch = batches.shift();
      if (batch === undefined) {
        timer = setTimeout(() => {
          refill();
          tick();
        }, 2600);
        return;
      }
      const points: [string, number, number][] = [];
      for (let step = batch * 4; step < batch * 4 + 4; step++) points.push(['loss', step, lossAt(step)]);
      const result = s.data.apply({ from: s.seq, to: s.seq + 1, points });
      s.seq++;
      const now = Date.now();
      s.late = s.late.filter((m) => now - m.at < 2200);
      if (result.kind === 'applied') for (const p of result.late) s.late.push({ step: p.step, at: now });
      setFrame((n) => n + 1);
      timer = setTimeout(tick, 260);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  const { data, late } = state.current;
  const series = data.series.get('loss');
  return (
    <figure className="illustration">
      <div className="illustration-plot">
        {series && (
          <Chart metric="loss" series={series} version={data.count} hoverStep={null} onHover={() => {}} late={late} height={260} />
        )}
      </div>
      <figcaption>
        An illustration drawn in this page: batches of a loss curve arriving late and out of order. A ring marks each
        point that lands behind newer ones. The chart is drawn by step, so the order of arrival never changes it.
      </figcaption>
    </figure>
  );
}

function lossAt(step: number): number {
  const wobble = Math.sin(step * 12.9898) * 43758.5453;
  return 2.1 * Math.exp(-step / 32) + 0.22 + (wobble - Math.floor(wobble) - 0.5) * 0.14;
}

interface Created {
  name: string;
  secret: string;
}

export function Connect({ reason }: { reason: SignedOutReason }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'open' | 'create' | null>(null);
  const [error, setError] = useState<{ form: 'open' | 'create'; text: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = key.trim();
    if (!KEY_SHAPE.test(candidate)) {
      setError({ form: 'open', text: 'A key starts with sk_ and is 46 characters long. Check that all of it was pasted.' });
      return;
    }
    setBusy('open');
    setError(null);
    try {
      await new Client({ baseUrl: API_BASE, apiKey: candidate }).getProject();
      signIn(candidate);
    } catch (e) {
      const text =
        e instanceof ApiError && e.status === 401
          ? 'This key is not accepted. It may have been revoked or rotated.'
          : 'The server could not be reached. Check that it is running and try again.';
      setError({ form: 'open', text });
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError({ form: 'create', text: 'Give the project a name, for example the model you are training.' });
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const made = await new Client({ baseUrl: API_BASE }).createProject(name.trim());
      setCreated({ name: made.project.name, secret: made.api_key.secret });
    } catch (e) {
      const text = e instanceof ApiError && e.status === 422 ? e.message : 'The project could not be created. Try again.';
      setError({ form: 'create', text });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="connect">
      <section className="connect-forms">
        <div className="wordmark">
          <Logo size={34} />
          <span>Simmer</span>
        </div>
        <h1>
          Watch training runs <mark>while they run</mark>
        </h1>
        <p className="lead">
          Simmer stores the metrics your training scripts send and draws them live. If the page falls behind or loses
          its connection, it says so and catches up from where it stopped.
        </p>

        {reason === 'revoked' && (
          <Notice tone="warn">
            The key this tab was using no longer works. It was revoked or rotated, so everything it could see has been
            cleared from this page. Open the project with a current key.
          </Notice>
        )}

        {created ? (
          <div className="panel reveal" data-testid="created">
            <h2>Project {created.name} is ready</h2>
            <p>
              This is its first API key. It is shown only now, and only its hash is stored, so copy it somewhere safe
              before you continue.
            </p>
            <code className="secret" data-testid="new-secret">
              {created.secret}
            </code>
            <div className="row">
              <CopyButton text={created.secret} label="Copy key" />
              <Button variant="primary" onClick={() => signIn(created.secret)}>
                Open the project
              </Button>
            </div>
          </div>
        ) : (
          <>
            <form className="panel" onSubmit={open} noValidate>
              <h2>Open a project</h2>
              <label htmlFor="key">API key</label>
              <input
                id="key"
                name="key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk_…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-invalid={error?.form === 'open'}
              />
              {error?.form === 'open' && <p className="field-error">{error.text}</p>}
              <Button variant="primary" type="submit" busy={busy === 'open'}>
                {busy === 'open' ? 'Checking the key' : 'Open project'}
              </Button>
            </form>

            <form className="panel panel-flat" onSubmit={create} noValidate>
              <h2>Start a new project</h2>
              <label htmlFor="name">Project name</label>
              <input
                id="name"
                name="name"
                maxLength={80}
                placeholder="resnet-ablations"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={error?.form === 'create'}
              />
              {error?.form === 'create' && <p className="field-error">{error.text}</p>}
              <Button type="submit" busy={busy === 'create'}>
                {busy === 'create' ? 'Creating' : 'Create project and key'}
              </Button>
            </form>
          </>
        )}
      </section>
      <section className="connect-scene" aria-label="How metrics arrive">
        <ArrivalIllustration />
      </section>
    </main>
  );
}
