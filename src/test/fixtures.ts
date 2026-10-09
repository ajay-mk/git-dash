import { defaultWidgets, type PinnedRepo } from '../config/schema';
import type { IssueItem, PullRequestItem, RepoSnapshot } from '../providers/types';

export function pinned(owner = 'octo', name = 'repo', overrides: Partial<PinnedRepo> = {}): PinnedRepo {
  return { provider: 'github', owner, name, widgets: defaultWidgets(), ...overrides };
}

export function pr(overrides: Partial<PullRequestItem> = {}): PullRequestItem {
  return {
    number: 1,
    title: 'Add feature',
    url: 'https://github.com/octo/repo/pull/1',
    author: 'octocat',
    updatedAt: new Date().toISOString(),
    isDraft: false,
    review: 'none',
    ci: 'success',
    mergeable: true,
    ...overrides,
  };
}

export function issue(overrides: Partial<IssueItem> = {}): IssueItem {
  return {
    number: 2,
    title: 'Fix bug',
    url: 'https://github.com/octo/repo/issues/2',
    author: 'octocat',
    updatedAt: new Date().toISOString(),
    labels: [],
    isPullRequest: false,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    fullName: 'octo/repo',
    url: 'https://github.com/octo/repo',
    isPrivate: false,
    isArchived: false,
    defaultBranch: 'main',
    ci: 'success',
    pullRequests: { total: 0, items: [] },
    prsNeedingAttention: 0,
    issues: { total: 0, items: [] },
    ...overrides,
  };
}

/** A `javascript:` URL, built at runtime so the no-script-url lint rule stays on. */
export const SCRIPT_URL = ['javascript', 'alert(1)'].join(':');
