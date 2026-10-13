import { afterEach, describe, expect, it } from 'vitest';
import { isSafeExternalUrl, providerOfUrl, setGitLabHost } from './url';

afterEach(() => setGitLabHost(null));

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
      'http://gitlab.com/a/b',
      'data:text/html,hi',
      'not a url',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('allows gitlab.com, where GitLab tokens are created', () => {
    expect(isSafeExternalUrl('https://gitlab.com/-/user_settings/personal_access_tokens')).toBe(true);
    // Only the connected instance counts as GitLab data.
    expect(providerOfUrl('https://gitlab.com/g/p')).toBeNull();
  });

  it('allows the connected GitLab instance only', () => {
    setGitLabHost('gitlab.example.com:8443');
    expect(providerOfUrl('https://gitlab.example.com:8443/g/p/-/merge_requests/1')).toBe('gitlab');
    expect(providerOfUrl('https://github.com/a/b')).toBe('github');
    expect(providerOfUrl('https://gitlab.com/g/p')).toBeNull();
    for (const url of [
      'https://gitlab.example.com/g/p',
      'http://gitlab.example.com:8443/g/p',
      'https://u@gitlab.example.com:8443/g/p',
      'https://gitlab.example.com.evil.com:8443/g/p',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });
});
