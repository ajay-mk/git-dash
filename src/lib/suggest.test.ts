import { describe, expect, it } from 'vitest';
import { matchRepos } from './suggest';

const all = ['acme/web', 'octo/api', 'acme/api-docs', 'zed/acme-tools', 'Octo/Hello'];

describe('matchRepos', () => {
  it('returns everything for an empty query, in order and up to the limit', () => {
    expect(matchRepos(all, '  ', new Set(), 3)).toEqual(['acme/web', 'octo/api', 'acme/api-docs']);
  });

  it('ranks owner prefixes, then name prefixes, then substrings', () => {
    expect(matchRepos(all, 'acme', new Set(), 10)).toEqual(['acme/web', 'acme/api-docs', 'zed/acme-tools']);
    expect(matchRepos(all, 'api', new Set(), 10)).toEqual(['octo/api', 'acme/api-docs']);
    expect(matchRepos(all, 'docs', new Set(), 10)).toEqual(['acme/api-docs']);
  });

  it('matches case-insensitively and keeps the original casing', () => {
    expect(matchRepos(all, 'octo/h', new Set(), 10)).toEqual(['Octo/Hello']);
  });

  it('skips excluded repositories', () => {
    expect(matchRepos(all, 'octo', new Set(['octo/api', 'octo/hello']), 10)).toEqual([]);
  });
});
