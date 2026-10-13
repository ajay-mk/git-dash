import { repoId, type PinnedRepo } from '../../config/schema';
import { AppError, gitlabGraphql, type GraphQLError, type GraphQLResponse } from '../../lib/transport';
import type { InboxSnapshot, Provider, RepoResult } from '../types';
import {
  mapDetails,
  mapInbox,
  mapProject,
  mapProjectSuggestions,
  parseItemUrl,
  projectError,
  projectNotFound,
} from './map';
import {
  ASSIGNED_ISSUES_QUERY,
  buildProjectsQuery,
  DETAILS_LIST_FETCHED,
  DETAILS_QUERY,
  INBOX_QUERY,
  PROJECT_SUGGESTIONS_FETCHED,
  projectAlias,
  PROJECTS_PER_REQUEST,
  PROJECTS_QUERY,
  VIEWER_ALIAS,
} from './queries';
import { gitlabTokenUrl, SCOPE_LABELS } from './tokenTemplate';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Fails when GitLab answered with errors and no data at all. */
function dataOrThrow<T>(res: GraphQLResponse<T>, what: string): T {
  if (!res.data) {
    if (res.errors?.length) throw new AppError('http', `GitLab could not load ${what}.`);
    throw new AppError('http', `GitLab returned no ${what}.`);
  }
  return res.data;
}

function signedIn(viewer: unknown): boolean {
  return typeof viewer === 'object' && viewer !== null && typeof (viewer as { username?: unknown }).username === 'string';
}

function rejected(): AppError {
  return new AppError('unauthorized', 'GitLab did not accept the token.');
}

function errorUnder(errors: GraphQLError[] | undefined, alias: string): GraphQLError | undefined {
  return errors?.find((e) => e.path?.[0] === alias);
}

/**
 * GitLab, on gitlab.com or a self-hosted instance. One personal access token
 * with the `read_api` scope covers every group the account can see, so
 * there are no per-owner tokens.
 */
export const gitlab: Provider = {
  id: 'gitlab',
  label: 'GitLab',
  ownerTokens: false,
  newTokenUrl: gitlabTokenUrl,
  tokenPermissions: SCOPE_LABELS,

  async fetchRepos(repos: PinnedRepo[]) {
    const results = new Map<string, RepoResult>();
    // Small batches keep each request under GitLab's complexity limit, so
    // they run side by side.
    await Promise.all(
      chunk(repos, PROJECTS_PER_REQUEST).map(async (batch) => {
        const { query, variables } = buildProjectsQuery(batch);
        const res = await gitlabGraphql<Record<string, unknown>>(query, variables);
        const data = dataOrThrow(res, 'your projects');
        if (!signedIn(data[VIEWER_ALIAS])) throw rejected();
        batch.forEach((repo, i) => {
          const alias = projectAlias(i);
          const raw = data[alias];
          if (errorUnder(res.errors, alias)) {
            results.set(repoId(repo), { ok: false, error: projectError() });
          } else if (raw) {
            results.set(repoId(repo), { ok: true, data: mapProject(raw, repo) });
          } else {
            results.set(repoId(repo), { ok: false, error: projectNotFound() });
          }
        });
      }),
    );
    // GitLab reports its rate limit in HTTP headers, which the bridge does not pass on.
    return { repos: results, rateLimit: null };
  },

  async fetchInbox(config): Promise<InboxSnapshot> {
    const res = await gitlabGraphql<{ currentUser?: { username?: unknown } | null }>(INBOX_QUERY, {
      n: config.limit,
      withReview: config.reviewRequests,
      withMine: config.myPullRequests,
      withAssigned: config.assigned,
    });
    const user = dataOrThrow(res, 'your inbox').currentUser;
    const me = typeof user?.username === 'string' ? user.username : null;
    if (!me) throw rejected();
    // A list that failed comes back empty next to the others; showing it as
    // "nothing needs you" would be wrong.
    if (res.errors?.length) throw new AppError('http', 'GitLab could not load all of your inbox.');
    let issues: unknown = null;
    if (config.assigned) {
      const assigned = await gitlabGraphql<{ issues?: unknown }>(ASSIGNED_ISSUES_QUERY, { me, n: config.limit });
      issues = dataOrThrow(assigned, 'your assigned issues').issues;
      if (assigned.errors?.length) throw new AppError('http', 'GitLab could not load your assigned issues.');
    }
    return mapInbox(user, issues, config.limit);
  },

  async listRepos() {
    const res = await gitlabGraphql<{ projects?: unknown }>(PROJECTS_QUERY, { n: PROJECT_SUGGESTIONS_FETCHED });
    const projects = dataOrThrow(res, 'your projects').projects;
    if (projects == null) throw new AppError('http', 'Could not list projects.');
    return { repos: mapProjectSuggestions(projects).map((p) => p.name), complete: true };
  },

  async fetchDetails(url) {
    const ref = parseItemUrl(url);
    if (!ref) throw new AppError('http', 'Not a GitLab merge request or issue link.');
    const res = await gitlabGraphql<{ project?: unknown }>(DETAILS_QUERY, {
      path: ref.path,
      iid: ref.iid,
      n: DETAILS_LIST_FETCHED,
      mr: ref.isMergeRequest,
    });
    const details = mapDetails(res.data?.project);
    if (!details) throw new AppError('http', 'Could not load details from GitLab.');
    return { ...details, incomplete: res.errors?.some((e) => e.path?.[0] === 'project') ?? false };
  },
};
