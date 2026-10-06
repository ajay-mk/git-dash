const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** Compact relative time, e.g. "3h", "2d", "now". */
export function shortAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const short: Record<string, string> = { year: 'y', month: 'mo', week: 'w', day: 'd', hour: 'h', minute: 'm' };
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${short[unit]}`;
  }
  return 'now';
}
