import { describe, expect, it, vi } from 'vitest';
import type { PinnedRepo } from '../../config/schema';
import { githubGraphql } from '../../lib/transport';
import { github } from './index';
import { describeRepoError, mapInbox, mapIssue, mapPullRequest, mapRepository } from './map';
import { buildReposQuery, OPEN_PRS_FETCHED } from './queries';

vi.mock('../../lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/transport')>()),
  githubGraphql: vi.fn(),
}));
const graphql = vi.mocked(githubGraphql);

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
    expect(inbox.ssoRestricted).toBe(false);
  });

  it('flags inbox results hidden by SSO', () => {
    const inbox = mapInbox(
      { viewer: { login: 'me' }, reviewRequests: { issueCount: 2, nodes: [null] } },
      [{ ...SAML_ERROR, path: ['reviewRequests', 'nodes', 0] }],
    );
    expect(inbox.ssoRestricted).toBe(true);
    expect(inbox.reviewRequests.items).toEqual([]);
  });
});

// Error entries as returned by api.github.com/graphql next to `"data": { "r0": null }`.
const SAML_ERROR = {
  type: 'FORBIDDEN',
  path: ['r0'],
  extensions: { saml_failure: true },
  locations: [{ line: 1, column: 30 }],
  message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.',
};
const NOT_FOUND_ERROR = {
  type: 'NOT_FOUND',
  path: ['r0'],
  locations: [{ line: 1, column: 30 }],
  message: "Could not resolve to a Repository with the name 'acme/api'.",
};
const CLASSIC_FORBIDDEN_ERROR = {
  type: 'FORBIDDEN',
  path: ['r0'],
  extensions: { saml_failure: false },
  message: '`acme` forbids access via a personal access token (classic). Please use a GitHub App, OAuth App, or a personal access token with fine-grained permissions.',
};
const FINE_GRAINED_FORBIDDEN_ERROR = {
  type: 'FORBIDDEN',
  path: ['r0'],
  extensions: { saml_failure: false },
  message: "`acme` forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days. Please adjust your token's lifetime at the following URL: https://github.com/settings/personal-access-tokens/1",
};
const PLAIN_FORBIDDEN_ERROR = {
  type: 'FORBIDDEN',
  path: ['r0'],
  extensions: { saml_failure: false },
  message: 'Resource not accessible by personal access token',
};
const RATE_LIMIT_ERROR = { type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' };

describe('describeRepoError', () => {
  it('explains SAML SSO and links to the token settings page', () => {
    const err = describeRepoError(SAML_ERROR, 'acme');
    expect(err.kind).toBe('sso_required');
    expect(err.message).toContain('acme');
    expect(err.help?.url).toBe('https://github.com/settings/tokens');
  });

  it('detects SAML failures by message when extensions are missing', () => {
    expect(describeRepoError({ type: 'FORBIDDEN', message: SAML_ERROR.message }, 'acme').kind).toBe('sso_required');
  });

  it('detects organization token policies', () => {
    expect(describeRepoError(CLASSIC_FORBIDDEN_ERROR, 'acme').kind).toBe('token_policy');
    expect(describeRepoError(FINE_GRAINED_FORBIDDEN_ERROR, 'acme').kind).toBe('token_policy');
  });

  it('separates not found, plain forbidden, rate limits and unknown errors', () => {
    expect(describeRepoError(NOT_FOUND_ERROR, 'acme').kind).toBe('not_found');
    expect(describeRepoError(PLAIN_FORBIDDEN_ERROR, 'acme').kind).toBe('forbidden');
    expect(describeRepoError(RATE_LIMIT_ERROR, 'acme').kind).toBe('rate_limited');
    expect(describeRepoError({ type: 'RATE_LIMIT' }, 'acme').kind).toBe('rate_limited');
    expect(describeRepoError({ type: 'SOMETHING_NEW', message: 'x' }, 'acme').kind).toBe('unknown');
    expect(describeRepoError(undefined, 'acme').kind).toBe('unknown');
  });

  it('names the permissions a token needs when access is denied', () => {
    const permissions = 'read-only Metadata, Contents, Pull requests, Issues, Commit statuses and Actions permissions';
    expect(describeRepoError(PLAIN_FORBIDDEN_ERROR, 'acme').message).toContain(permissions);
    expect(describeRepoError(NOT_FOUND_ERROR, 'acme').message).toContain(permissions);
  });

  it('never echoes API error text and only links to GitHub', () => {
    const hostile = { type: 'FORBIDDEN', message: '<img src=x onerror=alert(1)> SAML enforcement' };
    for (const e of [SAML_ERROR, NOT_FOUND_ERROR, CLASSIC_FORBIDDEN_ERROR, PLAIN_FORBIDDEN_ERROR, RATE_LIMIT_ERROR, hostile]) {
      const out = describeRepoError(e, 'acme');
      expect(out.message).not.toContain(e.message);
      if (out.help) expect(out.help.url.startsWith('https://github.com/')).toBe(true);
    }
  });
});

describe('github provider', () => {
  const other: PinnedRepo = { ...repo, owner: 'corp', name: 'secret' };

  it('attaches each error to the repository at its alias', async () => {
    graphql.mockResolvedValueOnce({
      data: { r0: { nameWithOwner: 'acme/api' }, r1: null },
      errors: [{ ...SAML_ERROR, path: ['r1'] }],
    });
    const { repos } = await github.fetchRepos([repo, other], []);
    expect(repos.get('github:acme/api')?.ok).toBe(true);
    const failed = repos.get('github:corp/secret');
    expect(failed?.ok === false && failed.error.kind).toBe('sso_required');
    expect(failed?.ok === false && failed.error.message).toContain('corp');
  });

  it('fails a repository whose nested fields returned errors', async () => {
    graphql.mockResolvedValueOnce({
      data: { r0: { nameWithOwner: 'acme/api', defaultBranchRef: null } },
      errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible', path: ['r0', 'defaultBranchRef'] }],
    });
    const { repos } = await github.fetchRepos([repo], []);
    const result = repos.get('github:acme/api');
    expect(result?.ok === false && result.error.kind).toBe('forbidden');
  });

  it('reports a rate limit when GitHub returns no data', async () => {
    graphql.mockResolvedValueOnce({ data: null, errors: [RATE_LIMIT_ERROR] });
    await expect(github.fetchRepos([repo], [])).rejects.toThrow(/rate limit/);
    graphql.mockResolvedValueOnce({ data: null, errors: [RATE_LIMIT_ERROR] });
    await expect(github.fetchInbox({ enabled: true, limit: 5, reviewRequests: true, myPullRequests: true, assigned: true }, [])).rejects.toThrow(/rate limit/);
  });

  it('passes SSO errors through to the inbox', async () => {
    graphql.mockResolvedValueOnce({
      data: { viewer: { login: 'me' }, assigned: { issueCount: 1, nodes: [null] } },
      errors: [{ ...SAML_ERROR, path: ['assigned', 'nodes', 0] }],
    });
    const inbox = await github.fetchInbox({ enabled: true, limit: 5, reviewRequests: false, myPullRequests: false, assigned: true }, []);
    expect(inbox.ssoRestricted).toBe(true);
  });
});

describe('github.listRepos', () => {
  const nodes = (...names: (string | { nameWithOwner: string; isArchived: boolean })[]) => ({
    nodes: names.map((n) => (typeof n === 'string' ? { nameWithOwner: n, isArchived: false } : n)),
  });

  it('merges the default and per-owner tokens, skipping duplicates, archived and invalid names', async () => {
    graphql.mockImplementation((_query, _variables, owner) =>
      Promise.resolve(
        owner
          ? { data: { repositoryOwner: { repositories: nodes('Acme/API', 'acme/web') } } }
          : {
              data: {
                viewer: {
                  repositories: nodes('octo/one', 'acme/api', { nameWithOwner: 'octo/old', isArchived: true }, 'bad name'),
                },
              },
            },
      ),
    );
    await expect(github.listRepos(['acme'])).resolves.toEqual({ repos: ['octo/one', 'acme/api', 'acme/web'], complete: true });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('repositoryOwner(login: $owner)'), expect.objectContaining({ owner: 'acme' }), 'acme');
  });

  it('orders the merged list by last push across tokens', async () => {
    const at = (name: string, pushedAt: string | null) => ({ nameWithOwner: name, isArchived: false, pushedAt });
    graphql.mockImplementation((_query, _variables, owner) =>
      Promise.resolve(
        owner
          ? { data: { repositoryOwner: { repositories: { nodes: [at('acme/new', '2026-10-12T00:00:00Z')] } } } }
          : {
              data: {
                viewer: {
                  repositories: { nodes: [at('octo/a', '2026-10-10T00:00:00Z'), at('octo/b', '2026-10-01T00:00:00Z'), at('octo/empty', null)] },
                },
              },
            },
      ),
    );
    await expect(github.listRepos(['acme'])).resolves.toEqual({ repos: ['acme/new', 'octo/a', 'octo/b', 'octo/empty'], complete: true });
  });

  it('only fetches active repositories', async () => {
    graphql.mockResolvedValue({ data: {} });
    await github.listRepos(['acme']);
    for (const [query] of graphql.mock.calls) expect(query).toMatch(/repositories\([^)]*isArchived: false/);
  });

  it('rejects when every token fails, so the caller can retry', async () => {
    graphql.mockRejectedValue(new Error('offline'));
    await expect(github.listRepos(['acme'])).rejects.toThrow('offline');
  });

  it('treats GraphQL errors without data as a failure, but keeps partial data', async () => {
    graphql.mockResolvedValue({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] });
    await expect(github.listRepos([])).rejects.toThrow();

    graphql.mockResolvedValue({
      data: { viewer: { repositories: { nodes: [{ nameWithOwner: 'octo/one', isArchived: false }] } } },
      errors: [{ type: 'FORBIDDEN', message: 'SAML' }],
    });
    await expect(github.listRepos([])).resolves.toEqual({ repos: ['octo/one'], complete: true });
  });

  it('ignores tokens that fail', async () => {
    graphql.mockImplementation((_query, _variables, owner) =>
      owner ? Promise.reject(new Error('revoked')) : Promise.resolve({ data: { viewer: { repositories: nodes('octo/one') } } }),
    );
    await expect(github.listRepos(['acme'])).resolves.toEqual({ repos: ['octo/one'], complete: false });
  });
});
