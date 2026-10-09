import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from './url';

describe('isSafeExternalUrl', () => {
  it('allows GitHub web URLs', () => {
    expect(isSafeExternalUrl('https://github.com/a/b/pull/1')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const url of [
      'http://github.com/a',
      'javascript:alert(1)',
      'https://github.com.evil.com/a',
      'https://evil.com/github.com',
      'https://user:pass@github.com/a',
      'https://github.com:8443/a',
      'https://gist.github.com/a',
      'data:text/html,hi',
      'not a url',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });
});
