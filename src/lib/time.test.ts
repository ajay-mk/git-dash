import { describe, expect, it } from 'vitest';
import { shortAgo } from './time';

describe('shortAgo', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it('formats compact relative times', () => {
    expect(shortAgo('2026-10-06T11:59:30Z', now)).toBe('now');
    expect(shortAgo('2026-10-06T11:55:00Z', now)).toBe('5m');
    expect(shortAgo('2026-10-06T09:00:00Z', now)).toBe('3h');
    expect(shortAgo('2026-10-03T12:00:00Z', now)).toBe('3d');
    expect(shortAgo('garbage', now)).toBe('');
  });
});
