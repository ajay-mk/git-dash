import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinnedRepo } from '../../config/schema';
import { gitlabGraphql } from '../../lib/transport';
import { setGitLabHost } from '../../lib/url';
import { normalizeGitLabHost } from './host';
import { gitlab } from './index';
import { mapDetails, mapInbox, mapIssue, mapMergeRequest, mapPipelineStatus, mapProject, parseItemUrl, pickBranchPipeline } from './map';
import { buildProjectsQuery, OPEN_MRS_FETCHED, PROJECTS_PER_REQUEST } from './queries';
import { gitlabTokenUrl } from './tokenTemplate';

vi.mock('../../lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/transport')>()),
  gitlabGraphql: vi.fn(),
}));
const graphql = vi.mocked(gitlabGraphql);

const HOST = 'gitlab.example.com';
const web = (path: string) => `https://${HOST}/${path}`;

beforeEach(() => setGitLabHost(HOST));
afterEach(() => {
  setGitLabHost(null);
  vi.resetAllMocks();
});

const project: PinnedRepo = {
  provider: 'gitlab',
  owner: 'acme/platform',
  name: 'api',
  widgets: [
    { type: 'ci' },
    { type: 'pullRequests', limit: 2, hideDrafts: true },
    { type: 'issues', limit: 3, label: 'bug' },
  ],
};

function mr(overrides: Record<string, unknown> = {}) {
  return {
    iid: '7',
    title: 'Add cache',
    webUrl: web('acme/platform/api/-/merge_requests/7'),
    draft: false,
    updatedAt: '2026-10-10T10:00:00Z',
    approved: false,
    detailedMergeStatus: 'MERGEABLE',
    conflicts: false,
    reference: 'acme/platform/api!7',
    author: { username: 'jane.doe' },
    headPipeline: { status: 'SUCCESS' },
    approvedBy: { nodes: [] },
    ...overrides,
  };
}

describe('normalizeGitLabHost', () => {
  it('accepts instance addresses the way the backend stores them', () => {
    expect(normalizeGitLabHost('gitlab.com')).toBe('gitlab.com');
    expect(normalizeGitLabHost(' https://GitLab.Example.com/ ')).toBe('gitlab.example.com');
    expect(normalizeGitLabHost('gitlab.example.com:8443')).toBe('gitlab.example.com:8443');
    expect(normalizeGitLabHost('https://gitlab.example.com:443')).toBe('gitlab.example.com');
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'http://gitlab.example.com',
      'gitlab.example.com/group',
      'user@gitlab.example.com',
      'gitlab.example.com?x',
      '10.0.0.1',
      '[::1]',
      'localhost',
      'gitlab .com',
      'javascript:alert(1)',
    ]) {
      expect(normalizeGitLabHost(bad), bad).toBeNull();
    }
  });
});

describe('gitlabTokenUrl', () => {
  it('prefills the name and the read_api scope on the instance', () => {
    const url = new URL(gitlabTokenUrl('gitlab.example.com:8443'));
    expect(url.host).toBe('gitlab.example.com:8443');
    expect(url.pathname).toBe('/-/user_settings/personal_access_tokens');
    expect(url.searchParams.get('scopes')).toBe('read_api');
    expect(new URL(gitlabTokenUrl()).host).toBe('gitlab.com');
  });
});

describe('buildProjectsQuery', () => {
  it('passes all user input as variables, never in the query text', () => {
    const evil: PinnedRepo = {
      ...project,
      owner: 'x") { id } mutation {',
      widgets: [{ type: 'issues', limit: 1, label: '"}' }],
    };
    const { query, variables } = buildProjectsQuery([evil]);
    expect(query).not.toContain('mutation');
    expect(query).not.toContain('"}');
    expect(variables).toMatchObject({ path0: `${evil.owner}/api`, il0: ['"}'] });
  });

  it('only requests sections for enabled widgets', () => {
    const { query, variables } = buildProjectsQuery([{ ...project, widgets: [{ type: 'ci' }] }]);
    expect(query).toContain('pipelines(first: 10) { nodes { status ref source } }');
    expect(query).not.toContain('mergeRequests(');
    expect(query).not.toContain('issues(');
    expect(Object.keys(variables)).toEqual(['path0']);
    expect(buildProjectsQuery([{ ...project, widgets: [] }]).query).not.toContain('pipelines');
  });

  it('fetches more merge requests than the widget shows', () => {
    expect(buildProjectsQuery([project]).variables.mr0).toBe(OPEN_MRS_FETCHED);
  });
});

describe('mappers', () => {
  it('maps pipeline states', () => {
    expect(mapPipelineStatus('SUCCESS')).toBe('success');
    expect(mapPipelineStatus('FAILED')).toBe('failure');
    expect(mapPipelineStatus('RUNNING')).toBe('pending');
    expect(mapPipelineStatus('WAITING_FOR_RESOURCE')).toBe('pending');
    expect(mapPipelineStatus('CANCELED')).toBe('none');
    expect(mapPipelineStatus('MANUAL')).toBe('none');
    expect(mapPipelineStatus(undefined)).toBe('none');
  });

  it("picks the default branch's own pipeline", () => {
    // Newest first, as on gitlab.com: workloads and scans share the head commit.
    const nodes = [
      { status: 'SUCCESS', ref: 'refs/workloads/df5fa8', source: 'duo_workflow' },
      { status: 'SUCCESS', ref: 'refs/merge-requests/4/head', source: 'merge_request_event' },
      { status: 'SUCCESS', ref: 'main', source: 'security_orchestration_policy' },
      { status: 'FAILED', ref: 'main', source: 'push' },
      { status: 'SUCCESS', ref: 'main', source: 'push' },
    ];
    expect(pickBranchPipeline(nodes, 'main')?.status).toBe('FAILED');
    expect(pickBranchPipeline(nodes.slice(0, 3), 'main')).toBeNull();
    expect(pickBranchPipeline(nodes, null)).toBeNull();
  });

  it('maps a merge request', () => {
    expect(mapMergeRequest(mr())).toEqual({
      number: 7,
      title: 'Add cache',
      url: web('acme/platform/api/-/merge_requests/7'),
      author: 'jane.doe',
      updatedAt: '2026-10-10T10:00:00Z',
      isDraft: false,
      review: 'none',
      ci: 'success',
      mergeable: true,
      repo: 'acme/platform/api',
    });
    expect(mapMergeRequest(mr({ conflicts: true, headPipeline: null }))).toMatchObject({ mergeable: false, ci: 'none' });
    expect(mapMergeRequest(mr({ conflicts: null }))?.mergeable).toBeNull();
  });

  it('maps review state from the merge status and real approvals', () => {
    const review = (o: Record<string, unknown>) => mapMergeRequest(mr(o))?.review;
    expect(review({ detailedMergeStatus: 'REQUESTED_CHANGES' })).toBe('changes_requested');
    expect(review({ detailedMergeStatus: 'NOT_APPROVED' })).toBe('review_required');
    expect(review({ approved: true, approvedBy: { nodes: [{ username: 'sam' }] } })).toBe('approved');
    // `approved` is also true when no approval is required at all.
    expect(review({ approved: true })).toBe('none');
  });

  it('treats API data as untrusted', () => {
    expect(mapMergeRequest({ iid: 'x' })).toBeNull();
    expect(mapMergeRequest({ iid: 7 })).toBeNull();
    const other = mapMergeRequest(mr({ webUrl: 'https://evil.example/x', reference: '../../x!1' }));
    expect(other?.url).toBe('');
    expect(other?.repo).toBeUndefined();
    const issue = mapIssue({
      iid: '3',
      webUrl: web('acme/api/-/issues/3'),
      reference: 'acme/api#3',
      labels: { nodes: [{ title: 'bug', color: '#D10069' }, { title: 'x', color: 'red; background:url(x)' }, { title: '' }] },
    });
    expect(issue?.labels).toEqual([
      { name: 'bug', color: 'D10069' },
      { name: 'x', color: null },
    ]);
    expect(issue).toMatchObject({ number: 3, repo: 'acme/api', isPullRequest: false });
  });

  it('only links to the connected instance', () => {
    setGitLabHost('gitlab.com');
    expect(mapMergeRequest(mr())?.url).toBe('');
  });

  it('maps a project and applies widget options', () => {
    const data = mapProject(
      {
        fullPath: 'acme/platform/api',
        webUrl: web('acme/platform/api'),
        visibility: 'private',
        archived: false,
        repository: { rootRef: 'main', tree: { lastCommit: { pipelines: { nodes: [{ status: 'FAILED', ref: 'main', source: 'push' }] } } } },
        mergeRequests: {
          count: 9,
          nodes: [
            mr({ iid: '3', draft: true }),
            mr({ iid: '2', headPipeline: { status: 'FAILED' } }),
            mr({ iid: '1' }),
            mr({ iid: '0' }),
          ],
        },
        issues: { count: 4, nodes: [{ iid: '5', title: 'Bug', webUrl: web('acme/platform/api/-/issues/5') }] },
      },
      project,
    );
    expect(data).toMatchObject({
      fullName: 'acme/platform/api',
      isPrivate: true,
      defaultBranch: 'main',
      ci: 'failure',
      prsNeedingAttention: 1,
    });
    // Drafts hidden, then limited to two.
    expect(data.pullRequests).toMatchObject({ total: 9 });
    expect(data.pullRequests?.items.map((m) => m.number)).toEqual([2, 1]);
    expect(data.issues?.total).toBe(4);
  });

  it('merges assigned merge requests and issues, newest first', () => {
    const inbox = mapInbox(
      {
        username: 'jane.doe',
        reviewRequestedMergeRequests: { count: 1, nodes: [mr()] },
        authoredMergeRequests: { count: 0, nodes: [] },
        assignedMergeRequests: {
          count: 3,
          nodes: [{ iid: '9', title: 'MR', webUrl: web('a/b/-/merge_requests/9'), updatedAt: '2026-10-03T00:00:00Z' }],
        },
      },
      {
        count: 5,
        nodes: [
          { iid: '4', title: 'New', webUrl: web('a/b/-/issues/4'), updatedAt: '2026-10-05T00:00:00Z' },
          { iid: '2', title: 'Old', webUrl: web('a/b/-/issues/2'), updatedAt: '2026-10-01T00:00:00Z' },
        ],
      },
      2,
    );
    expect(inbox.viewer).toBe('jane.doe');
    expect(inbox.reviewRequests.items).toHaveLength(1);
    expect(inbox.assigned.total).toBe(8);
    expect(inbox.assigned.items.map((i) => [i.number, i.isPullRequest])).toEqual([
      [4, false],
      [9, true],
    ]);
  });

  it('maps merge request details', () => {
    const details = mapDetails({
      mergeRequest: {
        createdAt: '2026-10-01T00:00:00Z',
        description: '  Adds   a cache.\n\nMore. ',
        userNotesCount: 3,
        labels: { nodes: [{ title: 'perf', color: '#00ff00' }] },
        sourceBranch: 'feat/cache',
        targetBranch: 'main',
        diffStatsSummary: { additions: 10, deletions: 2, fileCount: 3 },
        headPipeline: {
          jobs: {
            count: 12,
            nodes: [
              { name: 'test', status: 'FAILED', webPath: '/acme/api/-/jobs/1' },
              { name: 'lint', status: 'SKIPPED', webPath: '//evil.example/x' },
            ],
          },
        },
        reviewers: {
          nodes: [
            { username: 'sam', mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } },
            { username: 'kim', mergeRequestInteraction: { reviewState: 'UNREVIEWED' } },
          ],
        },
        approvedBy: { nodes: [{ username: 'lee' }, { username: 'sam' }] },
      },
    });
    expect(details).toMatchObject({
      body: 'Adds a cache. More.',
      comments: 3,
      labels: [{ name: 'perf', color: '00ff00' }],
      pr: {
        baseRef: 'main',
        headRef: 'feat/cache',
        additions: 10,
        changedFiles: 3,
        checksTotal: 12,
        checks: [
          { name: 'test', state: 'failure', url: web('acme/api/-/jobs/1') },
          { name: 'lint', state: 'success', url: null },
        ],
        reviewers: [
          { login: 'sam', state: 'changes_requested' },
          { login: 'kim', state: 'requested' },
          { login: 'lee', state: 'approved' },
        ],
      },
    });
    expect(mapDetails({ issue: { assignees: { nodes: [{ username: 'kim' }] } } })).toMatchObject({ pr: null, assignees: ['kim'] });
    expect(mapDetails({})).toBeNull();
  });

  it('reads merge request and issue links on the connected instance only', () => {
    expect(parseItemUrl(web('acme/platform/api/-/merge_requests/12'))).toEqual({
      path: 'acme/platform/api',
      iid: '12',
      isMergeRequest: true,
    });
    expect(parseItemUrl(web('acme/api/-/work_items/4'))).toMatchObject({ iid: '4', isMergeRequest: false });
    expect(parseItemUrl('https://gitlab.com/acme/api/-/issues/4')).toBeNull();
    expect(parseItemUrl(web('acme/api/-/pipelines/4'))).toBeNull();
    expect(parseItemUrl(web('-x/api/-/issues/4'))).toBeNull();
  });
});

describe('gitlab provider', () => {
  const pins = (n: number) =>
    Array.from({ length: n }, (_, i): PinnedRepo => ({ ...project, name: `p${i}`, widgets: [{ type: 'ci' }] }));

  it('fetches projects in small batches and reports missing ones', async () => {
    graphql.mockImplementation((_query, variables) => {
      const data: Record<string, unknown> = { viewer: { username: 'jane.doe' } };
      for (const [key, path] of Object.entries(variables)) {
        const alias = key.replace('path', 'p');
        data[alias] = path === 'acme/platform/p1' ? null : { fullPath: path, repository: { rootRef: 'main' } };
      }
      return Promise.resolve({ data });
    });
    const { repos, rateLimit } = await gitlab.fetchRepos(pins(3), []);
    expect(graphql).toHaveBeenCalledTimes(Math.ceil(3 / PROJECTS_PER_REQUEST));
    expect(rateLimit).toBeNull();
    expect(repos.get('gitlab:acme/platform/p0')).toMatchObject({ ok: true, data: { fullName: 'acme/platform/p0' } });
    expect(repos.get('gitlab:acme/platform/p1')).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(repos.get('gitlab:acme/platform/p2')?.ok).toBe(true);
  });

  it('reports a project with errors instead of a partly empty card', async () => {
    graphql.mockResolvedValue({
      data: { viewer: { username: 'jane.doe' }, p0: { fullPath: 'acme/platform/p0' } },
      errors: [{ message: 'boom', path: ['p0', 'mergeRequests'] }],
    });
    const { repos } = await gitlab.fetchRepos(pins(1), []);
    expect(repos.get('gitlab:acme/platform/p0')).toMatchObject({ ok: false, error: { kind: 'unknown' } });
  });

  it('treats projects loaded without a signed-in user as a rejected token', async () => {
    // A revoked token is answered as anonymous: private projects come back null.
    graphql.mockResolvedValue({ data: { viewer: null, p0: null } });
    await expect(gitlab.fetchRepos(pins(1), [])).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('fails the inbox instead of showing a list that did not load as empty', async () => {
    const inbox = { enabled: true, reviewRequests: true, myPullRequests: true, assigned: true, limit: 5 };
    graphql.mockResolvedValueOnce({
      data: { currentUser: { username: 'jane.doe', reviewRequestedMergeRequests: null } },
      errors: [{ message: 'boom', path: ['currentUser', 'reviewRequestedMergeRequests'] }],
    });
    await expect(gitlab.fetchInbox(inbox, [])).rejects.toMatchObject({ kind: 'http' });
    graphql
      .mockResolvedValueOnce({ data: { currentUser: { username: 'jane.doe' } } })
      .mockResolvedValueOnce({ data: { issues: null }, errors: [{ message: 'boom', path: ['issues'] }] });
    await expect(gitlab.fetchInbox(inbox, [])).rejects.toMatchObject({ kind: 'http' });
  });

  it('loads assigned issues for the current user', async () => {
    graphql
      .mockResolvedValueOnce({ data: { currentUser: { username: 'jane.doe' } } })
      .mockResolvedValueOnce({ data: { issues: { count: 0, nodes: [] } } });
    const inbox = await gitlab.fetchInbox(
      { enabled: true, reviewRequests: true, myPullRequests: true, assigned: true, limit: 5 },
      [],
    );
    expect(inbox.viewer).toBe('jane.doe');
    // Reviews the viewer already gave are not asked of them again.
    expect(graphql.mock.calls[0]![0]).toContain('reviewStates: [UNREVIEWED, REVIEW_STARTED, UNAPPROVED]');
    expect(graphql.mock.calls[1]![1]).toEqual({ me: 'jane.doe', n: 5 });
    // Reviews the viewer already gave are not asked of them again.
    expect(graphql.mock.calls[0]![0]).toContain('reviewStates: [UNREVIEWED, REVIEW_STARTED, UNAPPROVED]');
  });

  it('treats an anonymous answer as a rejected token', async () => {
    graphql.mockResolvedValue({ data: { currentUser: null } });
    await expect(
      gitlab.fetchInbox({ enabled: true, reviewRequests: true, myPullRequests: true, assigned: false, limit: 5 }, []),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('suggests member projects, skipping archived and malformed ones', async () => {
    graphql.mockResolvedValue({
      data: {
        projects: {
          nodes: [
            { fullPath: 'acme/platform/api' },
            { fullPath: 'acme/old', archived: true },
            { fullPath: 'nope' },
          ],
        },
      },
    });
    expect(await gitlab.listRepos([])).toEqual({ repos: ['acme/platform/api'], complete: true });
  });

  it('loads details by project path and number', async () => {
    graphql.mockResolvedValue({ data: { project: { issue: { createdAt: 'x' } } } });
    await gitlab.fetchDetails(web('acme/platform/api/-/issues/4'), []);
    expect(graphql.mock.calls[0]![1]).toMatchObject({ path: 'acme/platform/api', iid: '4', mr: false });
    await expect(gitlab.fetchDetails('https://evil.example/a/b/-/issues/1', [])).rejects.toThrow();
  });
});
