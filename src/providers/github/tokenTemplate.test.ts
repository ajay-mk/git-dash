import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../../lib/url';
import { fineGrainedTokenUrl, FINE_GRAINED_PERMISSIONS } from './tokenTemplate';

describe('fineGrainedTokenUrl', () => {
  it('prefills a read-only token for the current user', () => {
    const url = new URL(fineGrainedTokenUrl());
    expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(url.searchParams.get('name')).toBe('GitDash');
    expect(url.searchParams.has('target_name')).toBe(false);
    for (const { key } of FINE_GRAINED_PERMISSIONS) expect(url.searchParams.get(key)).toBe('read');
    expect([...url.searchParams.values()]).not.toContain('write');
    expect(isSafeExternalUrl(url.toString())).toBe(true);
  });

  it('targets an owner and keeps the name within GitHub limits', () => {
    const owner = 'a'.repeat(39);
    const url = new URL(fineGrainedTokenUrl(owner));
    expect(url.searchParams.get('target_name')).toBe(owner);
    expect(url.searchParams.get('name')!.length).toBeLessThanOrEqual(40);
    expect(fineGrainedTokenUrl('acme')).toContain('name=GitDash+acme');
  });
});
