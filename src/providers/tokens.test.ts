import { describe, expect, it } from 'vitest';
import type { PinnedRepo } from '../config/schema';
import { groupByToken, mergeInbox } from './tokens';
import type { Counted, InboxSnapshot, PullRequestItem } from './types';

const pin = (owner: string, name: string): PinnedRepo => ({ provider: 'github', owner, name, widgets: [] });
const names = (repos: PinnedRepo[]) => repos.map((r) => `${r.owner}/${r.name}`);

describe('groupByToken', () => {
  it('puts everything in the default group when no owner has a token', () => {
    const repos = [pin('me', 'a'), pin('acme', 'b')];
    expect(groupByToken(repos, [])).toEqual([{ owner: null, repos }]);
  });

  it('groups repos by owner token, keeping pinned order within each group', () => {
    const repos = [pin('acme', 'api'), pin('me', 'dots'), pin('globex', 'web'), pin('acme', 'ui'), pin('me', 'blog')];
    const groups = groupByToken(repos, ['acme', 'globex']);
    expect(groups.map((g) => g.owner)).toEqual([null, 'acme', 'globex']);
    expect(groups.map((g) => names(g.repos))).toEqual([
      ['me/dots', 'me/blog'],
      ['acme/api', 'acme/ui'],
      ['globex/web'],
    ]);
  });

  it('matches owners case-insensitively and uses the lowercase owner', () => {
    const groups = groupByToken([pin('Acme', 'api'), pin('ACME', 'ui')], ['acme']);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.owner).toBe('acme');
    expect(names(groups[0]!.repos)).toEqual(['Acme/api', 'ACME/ui']);
  });

  it('omits the default group when every repo has an owner token', () => {
    const groups = groupByToken([pin('acme', 'api')], ['acme', 'unused']);
    expect(groups).toEqual([{ owner: 'acme', repos: [pin('acme', 'api')] }]);
  });

  it('returns no groups for no repos', () => {
    expect(groupByToken([], ['acme'])).toEqual([]);
  });
});

function pr(url: string, updatedAt: string): PullRequestItem {
  return { number: 1, title: url, url, author: null, updatedAt, isDraft: false, review: 'none', ci: 'none', mergeable: null };
}

function snapshot(viewer: string, reviews: Counted<PullRequestItem>, ssoRestricted = false): InboxSnapshot {
  const empty = { total: 0, items: [] };
  return { viewer, reviewRequests: reviews, myPullRequests: empty, assigned: empty, ssoRestricted };
}

describe('mergeInbox', () => {
  const a = pr('https://github.com/me/x/pull/1', '2026-01-03T00:00:00Z');
  const b = pr('https://github.com/acme/y/pull/2', '2026-01-04T00:00:00Z');
  const c = pr('https://github.com/acme/y/pull/3', '2026-01-01T00:00:00Z');

  it('returns the primary snapshot unchanged when there is nothing to merge', () => {
    const primary = snapshot('me', { total: 1, items: [a] });
    expect(mergeInbox(primary, [], 10)).toBe(primary);
  });

  it('merges, de-duplicates by URL and sorts newest first', () => {
    const primary = snapshot('me', { total: 2, items: [a, c] });
    const org = snapshot('me', { total: 2, items: [b, c] });
    const merged = mergeInbox(primary, [org], 10);
    expect(merged.reviewRequests.items.map((i) => i.url)).toEqual([b.url, a.url, c.url]);
    expect(merged.reviewRequests.total).toBe(3);
  });

  it('respects the item limit but keeps the combined total', () => {
    const merged = mergeInbox(snapshot('me', { total: 5, items: [a] }), [snapshot('me', { total: 4, items: [b] })], 1);
    expect(merged.reviewRequests.items).toEqual([b]);
    expect(merged.reviewRequests.total).toBe(9);
  });

  it('ignores snapshots for a different account', () => {
    const primary = snapshot('me', { total: 1, items: [a] });
    const other = snapshot('someone-else', { total: 1, items: [b] });
    expect(mergeInbox(primary, [other], 10)).toBe(primary);
    expect(mergeInbox(primary, [snapshot('ME', { total: 1, items: [b] })], 10).reviewRequests.total).toBe(2);
  });

  it('keeps the SSO notice when any token was refused by SAML', () => {
    const primary = snapshot('me', { total: 1, items: [a] }, true);
    const merged = mergeInbox(primary, [snapshot('me', { total: 1, items: [b] })], 10);
    expect(merged.ssoRestricted).toBe(true);
  });
});
