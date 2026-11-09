import { useState, type FormEvent } from 'react';
import type { ApiKey, NewApiKey } from '@simmer/sdk';
import { formatAgo } from './format.ts';
import { useNow, usePolled } from './hooks.ts';
import { handleAuthError, signIn, signOut, type Session } from './session.ts';
import { Button, CopyButton, Notice } from './ui.tsx';

type Pending = { id: string; action: 'rotate' | 'revoke' } | null;
type Reveal = { key: NewApiKey; why: string };

// Rotating the key this tab uses signs the tab in again with the new key,
// which rebuilds every screen. The new key has to survive that to be shown.
let carried: Reveal | null = null;

export function Keys({ session }: { session: Session }) {
  const now = useNow(5000);
  const { data, error, refresh } = usePolled((signal) => session.client.listKeys(signal), 10_000);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [revealed, setRevealed] = useState<Reveal | null>(() => {
    const reveal = carried;
    carried = null;
    return reveal;
  });
  const [failure, setFailure] = useState<string | null>(null);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (e) {
      if (!handleAuthError(e)) setFailure((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void guard(async () => {
      const key = await session.client.createKey(label.trim() || 'New key');
      setLabel('');
      setRevealed({ key, why: 'The new key is active.' });
      refresh();
    });
  };

  const rotate = (target: ApiKey) =>
    guard(async () => {
      const key = await session.client.rotateKey(target.id);
      if (target.current) {
        // This tab was signed in with the key that just stopped working.
        carried = { key, why: 'The old key has stopped working. This tab now uses the new one.' };
        signIn(key.secret);
      } else {
        setRevealed({ key, why: 'The old key has stopped working, and live pages opened with it were disconnected.' });
        refresh();
      }
    });

  const revoke = (target: ApiKey) =>
    guard(async () => {
      await session.client.revokeKey(target.id);
      if (target.current) signOut('revoked');
      else refresh();
    });

  const keys = data?.keys;
  const active = keys?.filter((k) => k.revoked_at === null) ?? [];
  const revoked = keys?.filter((k) => k.revoked_at !== null) ?? [];

  return (
    <main className="page page-narrow">
      <header className="page-head">
        <h1>API keys</h1>
      </header>
      <p className="lead">
        A key gives full access to this project and to nothing else. Scripts send it in the
        <code> Authorization</code> header. Only a hash of each key is stored, so a key can be shown once, when it is
        made.
      </p>

      {failure && <Notice tone="error">{failure}</Notice>}
      {error && !keys && <Notice tone="error">The keys could not be loaded. They will be requested again shortly.</Notice>}

      {revealed && (
        <div className="panel reveal" data-testid="revealed">
          <h2>Copy the new key now</h2>
          <p>{revealed.why} It will not be shown again.</p>
          <code className="secret" data-testid="new-secret">
            {revealed.key.secret}
          </code>
          <div className="row">
            <CopyButton text={revealed.key.secret} label="Copy key" variant="primary" />
            <Button onClick={() => setRevealed(null)}>I have saved it</Button>
          </div>
        </div>
      )}

      <section className="keys" data-testid="keys">
        {active.map((key) => (
          <div className="key" key={key.id} data-key={key.id}>
            <div className="key-main">
              <strong>{key.label || 'Unnamed key'}</strong>
              <span className="key-prefix">{key.prefix}…</span>
              {key.current && <span className="key-current">this tab</span>}
              <span className="key-age">made {formatAgo(Date.parse(key.created_at), now)}</span>
            </div>
            {pending?.id === key.id ? (
              <div className="confirm">
                <p>
                  {pending.action === 'rotate'
                    ? 'The current key stops working immediately, and scripts and live pages using it are cut off. You get a replacement to put in its place.'
                    : key.current
                      ? 'This is the key this tab is using. It stops working immediately and you will be signed out.'
                      : 'The key stops working immediately, and scripts and live pages using it are cut off.'}
                </p>
                <div className="row">
                  <Button
                    variant="danger"
                    busy={busy}
                    onClick={() => (pending.action === 'rotate' ? rotate(key) : revoke(key))}
                    data-testid="confirm"
                  >
                    {pending.action === 'rotate' ? 'Rotate key' : 'Revoke key'}
                  </Button>
                  <Button onClick={() => setPending(null)}>Keep it</Button>
                </div>
              </div>
            ) : (
              <div className="row">
                <Button onClick={() => setPending({ id: key.id, action: 'rotate' })} data-testid="rotate">
                  Rotate
                </Button>
                <Button
                  onClick={() => setPending({ id: key.id, action: 'revoke' })}
                  disabled={active.length === 1}
                  title={active.length === 1 ? 'The only active key cannot be revoked. Rotate it instead.' : undefined}
                  data-testid="revoke"
                >
                  Revoke
                </Button>
              </div>
            )}
          </div>
        ))}
      </section>

      <form className="panel panel-flat inline-form" onSubmit={create}>
        <div>
          <label htmlFor="label">Name for another key</label>
          <input
            id="label"
            maxLength={80}
            placeholder="gpu-box-2"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Button type="submit" busy={busy && pending === null}>
          Create key
        </Button>
      </form>

      {revoked.length > 0 && (
        <section className="keys keys-revoked">
          <h2>Revoked</h2>
          {revoked.map((key) => (
            <div className="key" key={key.id}>
              <div className="key-main">
                <strong>{key.label || 'Unnamed key'}</strong>
                <span className="key-prefix">{key.prefix}…</span>
                <span className="key-age">revoked {formatAgo(Date.parse(key.revoked_at!), now)}</span>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
