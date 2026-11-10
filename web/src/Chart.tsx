import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { Series } from '@simmer/sdk';
import { formatTick, formatValue, niceTicks } from './format.ts';
import { geometry } from './geometry.ts';

const HEIGHT = 196;

export interface LateMark {
  step: number;
  at: number;
}

interface Props {
  metric: string;
  series: Series;
  /** Changes whenever the series content changes. The arrays are mutated in place. */
  version: number;
  hoverStep: number | null;
  onHover: (step: number | null) => void;
  late?: LateMark[];
  height?: number;
}

function nearestIndex(steps: number[], step: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]! < step) lo = mid;
    else hi = mid;
  }
  return Math.abs(steps[lo]! - step) <= Math.abs(steps[hi]! - step) ? lo : hi;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export const Chart = memo(function Chart({ metric, series, version, hoverStep, onHover, late, height = HEIGHT }: Props) {
  const [ref, width] = useWidth();
  // `series` is mutated in place, `version` is what says it changed.
  const g = useMemo(() => geometry(series, Math.max(width, 120), height), [series, version, width, height]);
  const { steps, values } = series;

  const yTicks = niceTicks(g.y0, g.y1, 4).filter((t) => t >= g.y0 && t <= g.y1);
  const xTicks = niceTicks(g.x0, g.x1, Math.max(2, Math.floor((g.right - g.left) / 90))).filter(
    (t) => Number.isInteger(t) && t >= g.x0 && t <= g.x1,
  );

  let lastFinite = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i]!)) {
      lastFinite = i;
      break;
    }
  }

  const hoverIndex = hoverStep === null ? -1 : nearestIndex(steps, hoverStep);
  const hoverValue = hoverIndex >= 0 ? values[hoverIndex]! : NaN;
  const hoverX = hoverIndex >= 0 ? g.x(steps[hoverIndex]!) : 0;

  const stepAt = (clientX: number, target: Element): number | null => {
    if (steps.length === 0) return null;
    const box = target.getBoundingClientRect();
    const ratio = (clientX - box.left - g.left) / (g.right - g.left);
    const index = nearestIndex(steps, g.x0 + Math.min(Math.max(ratio, 0), 1) * (g.x1 - g.x0));
    return steps[index] ?? null;
  };
  const onMove = (event: PointerEvent<SVGSVGElement>) => onHover(stepAt(event.clientX, event.currentTarget));
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (steps.length === 0) return;
    if (event.key === 'Escape') return onHover(null);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = hoverIndex >= 0 ? hoverIndex : steps.length - 1;
    const next = Math.min(Math.max(from + (event.key === 'ArrowLeft' ? -1 : 1), 0), steps.length - 1);
    onHover(steps[next]!);
  };

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width || '100%'}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`${metric} by step. Use the arrow keys to read values.`}
        data-testid="chart"
        data-metric={metric}
        data-x0={g.x0}
        data-x1={g.x1}
        data-y0={g.y0}
        data-y1={g.y1}
        data-left={g.left}
        data-right={g.right}
        data-top={g.top}
        data-bottom={g.bottom}
        data-finite={g.finite}
        data-decimated={g.decimated ? 'yes' : 'no'}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(null)}
        onFocus={() => hoverStep === null && steps.length > 0 && onHover(steps[steps.length - 1]!)}
        onBlur={() => onHover(null)}
        onKeyDown={onKey}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={g.left} x2={g.right} y1={g.y(t)} y2={g.y(t)} />
            <text className="chart-tick" x={g.left - 8} y={g.y(t)} dy="0.32em" textAnchor="end">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="chart-tick" x={g.x(t)} y={g.bottom + 16} textAnchor="middle">
            {formatTick(t)}
          </text>
        ))}
        <line className="chart-axis" x1={g.left} x2={g.right} y1={g.bottom} y2={g.bottom} />
        <path className="chart-line" d={g.path} data-testid="chart-line" />
        {late?.map((mark) => {
          const index = nearestIndex(steps, mark.step);
          if (index < 0 || steps[index] !== mark.step || !Number.isFinite(values[index]!)) return null;
          return (
            <circle
              key={`${mark.step}-${mark.at}`}
              className="chart-late"
              cx={g.x(mark.step)}
              cy={g.y(values[index]!)}
              r={4}
            />
          );
        })}
        {lastFinite >= 0 && (
          <circle className="chart-end" cx={g.x(steps[lastFinite]!)} cy={g.y(values[lastFinite]!)} r={4} />
        )}
        {hoverIndex >= 0 && (
          <g>
            <line className="chart-cross" x1={hoverX} x2={hoverX} y1={g.top} y2={g.bottom} />
            {Number.isFinite(hoverValue) && <circle className="chart-dot" cx={hoverX} cy={g.y(hoverValue)} r={4.5} />}
          </g>
        )}
      </svg>
      {hoverIndex >= 0 && (
        <div
          className={`chart-tip ${hoverX > (g.left + g.right) / 2 ? 'is-left' : ''}`}
          style={{ left: hoverX, top: Number.isFinite(hoverValue) ? g.y(hoverValue) : g.top }}
        >
          <strong>{formatValue(hoverValue)}</strong>
          <span>step {steps[hoverIndex]}</span>
        </div>
      )}
    </div>
  );
});
