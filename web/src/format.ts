/** A metric value as shown in summaries and tooltips: four significant digits. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) return value.toExponential(3).replace(/\.?0+e/, 'e');
  return String(Number(value.toPrecision(4)));
}

const integer = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return integer.format(value);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

export function formatAgo(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Tick values that land on round numbers. */
export function niceTicks(min: number, max: number, target: number): number[] {
  if (!(max > min)) return [min];
  const rough = (max - min) / Math.max(target, 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 5, 10].find((m) => m * power >= rough)! * power;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / unit) * unit; v <= max + unit * 1e-9; v += unit) {
    ticks.push(Math.abs(v) < unit * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return ticks;
}

export function formatTick(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(0).replace('+', '');
  if (abs >= 10_000) return `${Number((value / 1000).toPrecision(3))}K`;
  return String(Number(value.toPrecision(6)));
}
