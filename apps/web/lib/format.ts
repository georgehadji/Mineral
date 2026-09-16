/** Presentation only. Nothing here changes a value; it chooses how to show one. */

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});
const PLAIN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

export function money(value: number | null, currency: string | null): string {
  if (value === null) return '--';
  return `${COMPACT.format(value)}${currency ? ` ${currency}` : ''}`;
}

export function exact(value: number | null): string {
  return value === null ? '--' : PLAIN.format(value);
}

/** A ratio as a percentage, for the assumptions that are one. */
export function ratio(value: number | null, unit: string | null): string {
  if (value === null) return '--';
  if (unit === 'ratio') return `${PLAIN.format(value * 100)}%`;
  return `${PLAIN.format(value)}${unit && unit !== 'years' ? ` ${unit}` : unit === 'years' ? ' years' : ''}`;
}

export function pct(value: number | null): string {
  return value === null ? '--' : `${Math.round(value * 100)}%`;
}

export function day(value: string | null): string {
  if (!value) return '--';
  return value.slice(0, 10);
}

export function stamp(value: string | null): string {
  if (!value) return '--';
  return value.slice(0, 16).replace('T', ' ');
}

export function bytes(value: number | null): string {
  if (value === null) return '--';
  return `${COMPACT.format(value)} B`;
}
