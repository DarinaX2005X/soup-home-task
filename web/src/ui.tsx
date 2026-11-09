import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { RunStatus } from '@simmer/sdk';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M6 17h20a10 10 0 0 1-20 0z" fill="var(--paper)" />
      <path
        d="M9 12l4-3 4 2 6-6"
        fill="none"
        stroke="var(--line-bright)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'quiet' | 'danger';
  busy?: boolean;
}

export function Button({ variant = 'quiet', busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={`button button-${variant} ${busy ? 'is-busy' : ''} ${className ?? ''}`}
    >
      {children}
    </button>
  );
}

/** Copies text and says so in the same button, where the eye already is. */
export function CopyButton({ text, label = 'Copy', variant }: { text: string; label?: string; variant?: ButtonProps['variant'] }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };
  return (
    <Button variant={variant} onClick={copy} className={state === 'copied' ? 'is-done' : ''}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy by hand' : label}
    </Button>
  );
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
};

export function StatusMark({ status }: { status: RunStatus }) {
  return (
    <span className={`status status-${status}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        {status === 'running' && (
          <>
            <circle className="status-pulse" cx="7" cy="7" r="3" />
            <circle cx="7" cy="7" r="3" />
          </>
        )}
        {status === 'finished' && (
          <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {status === 'failed' && (
          <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** A number that briefly lifts when it changes, so growth is noticed without being read. */
export function Ticking({ value, children }: { value: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    const element = ref.current;
    if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    element.animate(
      [{ transform: 'translateY(-2px)', opacity: 0.55 }, { transform: 'none', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }, [value]);
  return (
    <span ref={ref} className="ticking">
      {children}
    </span>
  );
}
