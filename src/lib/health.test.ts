import { describe, expect, it } from 'vitest';
import type { PullRequestItem, RepoResult, RepoSnapshot } from '../providers/types';
import { myPrAction, repoHealth } from './health';

const pr = (over: Partial<PullRequestItem> = {}): PullRequestItem => ({
  number: 1,
  title: 't',
  url: 'https://github.com/a/b/pull/1',
  author: 'me',
  updatedAt: '2026-01-01T00:00:00Z',
  isDraft: false,
  review: 'none',
  ci: 'success',
  mergeable: true,
  ...over,
});

const repo = (over: Partial<RepoSnapshot> = {}): RepoResult => ({
  ok: true,
  data: {
    fullName: 'a/b',
    url: 'https://github.com/a/b',
    isPrivate: false,
    isArchived: false,
    defaultBranch: 'main',
    ci: 'success',
    pullRequests: { total: 0, items: [] },
    issues: null,
    ...over,
  },
});

describe('repoHealth', () => {
  it('ranks states by severity', () => {
    expect(repoHealth(undefined)).toBeNull();
    expect(repoHealth({ ok: false, error: 'x' })).toBe('error');
    expect(repoHealth(repo({ ci: 'failure', pullRequests: { total: 1, items: [pr({ ci: 'failure' })] } }))).toBe('failing');
    expect(repoHealth(repo({ pullRequests: { total: 1, items: [pr({ review: 'changes_requested' })] } }))).toBe('attention');
    expect(repoHealth(repo({ ci: 'pending' }))).toBe('pending');
    expect(repoHealth(repo())).toBe('ok');
  });

  it('ignores draft PRs for attention', () => {
    expect(repoHealth(repo({ pullRequests: { total: 1, items: [pr({ isDraft: true, ci: 'failure' })] } }))).toBe('ok');
  });
});

describe('myPrAction', () => {
  it('flags PRs to fix or merge', () => {
    expect(myPrAction(pr({ ci: 'failure' }))).toBe('fix');
    expect(myPrAction(pr({ review: 'changes_requested' }))).toBe('fix');
    expect(myPrAction(pr({ review: 'approved' }))).toBe('merge');
    expect(myPrAction(pr({ review: 'approved', ci: 'pending' }))).toBeNull();
    expect(myPrAction(pr({ review: 'approved', mergeable: null }))).toBeNull();
    expect(myPrAction(pr({ review: 'approved', mergeable: false }))).toBe('fix');
    expect(myPrAction(pr({ isDraft: true, ci: 'failure' }))).toBeNull();
  });
});
