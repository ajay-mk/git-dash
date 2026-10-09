import { describe, expect, it } from 'vitest';
import type { PinnedRepo } from '../../config/schema';
import { mapInbox, mapIssue, mapPullRequest, mapRepository } from './map';
import { buildReposQuery, OPEN_PRS_FETCHED } from './queries';

const repo: PinnedRepo = {
  provider: 'github',
  owner: 'acme',
  name: 'api',
  widgets: [
    { type: 'ci' },
    { type: 'pullRequests', limit: 2, hideDrafts: true },
    { type: 'issues', limit: 3, label: 'bug' },
  ],
};

describe('buildReposQuery', () => {
  it('passes all user input as variables, never in the query text', () => {
    const evil: PinnedRepo = { ...repo, owner: 'x") { id } mutation {', name: 'y', widgets: [{ type: 'issues', limit: 1, label: '"}' }] };
    const { query, variables } = buildReposQuery([evil]);
    expect(query).not.toContain('mutation');
    expect(query).not.toContain('"}');
    expect(variables).toMatchObject({ o0: evil.owner, n0: 'y', il0: ['"}'] });
  });

  it('only requests sections for enabled widgets', () => {
    const { query, variables } = buildReposQuery([{ ...repo, widgets: [{ type: 'ci' }] }]);
    expect(query).toContain('statusCheckRollup');
    expect(query).not.toContain('pullRequests(');
    expect(query).not.toContain('issues(');
    expect(Object.keys(variables)).toEqual(['o0', 'n0']);
  });

  it('fetches more PRs than the widget shows', () => {
    expect(buildReposQuery([repo]).variables.pr0).toBe(OPEN_PRS_FETCHED);
  });
});

describe('mappers', () => {
  it('maps a repository and applies widget options', () => {
    const raw = {
      nameWithOwner: 'acme/api',
      url: 'https://github.com/acme/api',
      isPrivate: true,
      isArchived: false,
      defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'FAILURE' } } },
      pullRequests: {
        totalCount: 7,
        nodes: [
          { number: 3, title: 'Draft', url: 'https://github.com/acme/api/pull/3', isDraft: true },
          { number: 2, title: 'Fix', url: 'https://github.com/acme/api/pull/2', reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
          { number: 1, title: 'Old', url: 'https://github.com/acme/api/pull/1' },
          { number: 0, title: 'Extra', url: 'https://github.com/acme/api/pull/0' },
        ],
      },
      issues: { totalCount: 1, nodes: [{ number: 9, title: 'Bug', url: 'https://github.com/acme/api/issues/9' }] },
    };
    const snap = mapRepository(raw, repo);
    expect(snap.ci).toBe('failure');
    expect(snap.isPrivate).toBe(true);
    expect(snap.pullRequests?.total).toBe(7);
    expect(snap.pullRequests?.items.map((p) => p.number)).toEqual([2, 1]);
    expect(snap.pullRequests?.items[0]).toMatchObject({ review: 'approved', ci: 'success' });
    expect(snap.issues?.total).toBe(1);
  });

  it('counts PRs needing attention beyond the display limit, ignoring drafts', () => {
    const failing = { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } };
    const nodes = [
      { number: 5, title: 'a', url: 'https://github.com/acme/api/pull/5' },
      { number: 4, title: 'b', url: 'https://github.com/acme/api/pull/4' },
      { number: 3, title: 'c', url: 'https://github.com/acme/api/pull/3', isDraft: true, ...failing },
      { number: 2, title: 'd', url: 'https://github.com/acme/api/pull/2', ...failing },
    ];
    const snap = mapRepository({ pullRequests: { totalCount: 4, nodes } }, repo);
    expect(snap.pullRequests?.items.map((p) => p.number)).toEqual([5, 4]);
    expect(snap.prsNeedingAttention).toBe(1);
  });

  it('drops unsafe URLs and label colours from API data', () => {
    const pr = mapPullRequest({ number: 1, title: 'x', url: 'javascript:alert(1)' });
    expect(pr?.url).toBe('');
    const issue = mapIssue({
      number: 1,
      url: 'https://evil.com/x',
      labels: { nodes: [{ name: 'a', color: 'red;background:url(x)' }, { name: 'b', color: 'ff00aa' }] },
    });
    expect(issue?.url).toBe('');
    expect(issue?.labels).toEqual([
      { name: 'a', color: null },
      { name: 'b', color: 'ff00aa' },
    ]);
  });

  it('ignores malformed nodes', () => {
    expect(mapPullRequest(null)).toBeNull();
    expect(mapPullRequest({ number: '1' })).toBeNull();
    const snap = mapRepository({ pullRequests: { nodes: [null, 'x', { number: 1 }] } }, repo);
    expect(snap.pullRequests?.items).toHaveLength(1);
    expect(snap.fullName).toBe('acme/api');
  });

  it('maps the inbox, treating skipped sections as empty', () => {
    const inbox = mapInbox({
      viewer: { login: 'me' },
      reviewRequests: { issueCount: 3, nodes: [{ number: 5, url: 'https://github.com/a/b/pull/5', repository: { nameWithOwner: 'a/b' } }] },
      assigned: { issueCount: 1, nodes: [{ __typename: 'PullRequest', number: 6 }] },
    });
    expect(inbox.viewer).toBe('me');
    expect(inbox.reviewRequests.total).toBe(3);
    expect(inbox.reviewRequests.items[0]?.repo).toBe('a/b');
    expect(inbox.myPullRequests).toEqual({ total: 0, items: [] });
    expect(inbox.assigned.items[0]?.isPullRequest).toBe(true);
  });
});
