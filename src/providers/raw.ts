/**
 * Helpers for reading untrusted API responses: each one returns a safe
 * default instead of trusting the shape of the data.
 */

export type Raw = Record<string, unknown>;

export function obj(v: unknown): Raw | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
}
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Longest description kept for the details view. */
export const DETAILS_BODY_CHARS = 400;

/** Collapses whitespace and cuts a description to `DETAILS_BODY_CHARS`. */
export function trimBody(v: unknown): string {
  const text = (str(v) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > DETAILS_BODY_CHARS ? `${text.slice(0, DETAILS_BODY_CHARS - 1).trimEnd()}…` : text;
}
