import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import './styles.css';
import type { Project } from '@simmer/sdk';
import { Connect } from './Connect.tsx';
import { Keys } from './Keys.tsx';
import { link, useRoute } from './router.ts';
import { RunPage } from './RunPage.tsx';
import { Runs } from './Runs.tsx';
import { handleAuthError, signOut, useSessionState, type Session } from './session.ts';
import { Logo } from './ui.tsx';

function Shell({ session }: { session: Session }) {
  const route = useRoute();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    session.client.getProject(controller.signal).then(setProject, (error) => {
      if (!controller.signal.aborted) handleAuthError(error);
    });
    return () => controller.abort();
  }, [session]);

  return (
    <>
      <header className="top">
        <a className="wordmark" {...link('/')}>
          <Logo />
          <span>Simmer</span>
        </a>
        <span className="project" data-testid="project-name">
          {project?.name}
        </span>
        <nav>
          <a {...link('/')} aria-current={route.page === 'runs' || route.page === 'run' ? 'page' : undefined}>
            Runs
          </a>
          <a {...link('/keys')} aria-current={route.page === 'keys' ? 'page' : undefined}>
            API keys
          </a>
          <button className="linklike" onClick={() => signOut()} data-testid="sign-out">
            Sign out
          </button>
        </nav>
      </header>
      {route.page === 'runs' && <Runs session={session} />}
      {route.page === 'run' && <RunPage key={route.id} session={session} runId={route.id} />}
      {route.page === 'keys' && <Keys session={session} />}
      {route.page === 'unknown' && (
        <main className="page">
          <section className="empty">
            <h2>There is no page at this address</h2>
            <a className="button button-quiet" {...link('/')}>
              Back to runs
            </a>
          </section>
        </main>
      )}
    </>
  );
}

function App() {
  const { session, reason } = useSessionState();
  if (!session) return <Connect reason={reason} />;
  // Keyed by the API key: switching keys unmounts everything, so no run, list
  // or chart loaded with one key can still be on screen under another.
  return <Shell key={session.apiKey} session={session} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
