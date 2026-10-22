/**
 * The GitHub queries GitDash runs, by name.
 *
 * The query documents themselves live in the backend
 * (`src-tauri/src/github_queries.rs`): the frontend can only name one of them
 * and pass variables, so it can never send a query of its own. Repository
 * cards send a list of repositories instead, and the backend builds the
 * batched query from fixed pieces.
 */

import type { PinnedRepo } from '../../config/schema';

export type GitHubOperation = 'GitDashRepos' | 'GitDashInbox' | 'GitDashViewerRepos' | 'GitDashOwnerRepos' | 'GitDashDetails';

export const INBOX_QUERY: GitHubOperation = 'GitDashInbox';
export const VIEWER_REPOS_QUERY: GitHubOperation = 'GitDashViewerRepos';
export const OWNER_REPOS_QUERY: GitHubOperation = 'GitDashOwnerRepos';
export const DETAILS_QUERY: GitHubOperation = 'GitDashDetails';
export const REPOS_QUERY: GitHubOperation = 'GitDashRepos';

/**
 * Open PRs fetched per repository. More than the widget shows, so that card
 * health sees PRs beyond the display limit and hiding drafts still leaves
 * enough to show.
 */
export const OPEN_PRS_FETCHED = 50;

/** Where the backend puts the result for the `index`th repository. */
export function repoAlias(index: number): string {
  return `r${index}`;
}

/** What one repository card needs, as the backend's `RepoSpec` expects it. */
export interface RepoSpec {
  owner: string;
  name: string;
  ci: boolean;
  pullRequests: number | null;
  issues: { limit: number; label: string | null } | null;
}

/** Variables for `GitDashRepos`: one spec per repository, in order. */
export function buildReposRequest(repos: readonly PinnedRepo[]): { repos: RepoSpec[] } {
  return {
    repos: repos.map((repo) => {
      const issues = repo.widgets.find((w) => w.type === 'issues');
      return {
        owner: repo.owner,
        name: repo.name,
        ci: repo.widgets.some((w) => w.type === 'ci'),
        pullRequests: repo.widgets.some((w) => w.type === 'pullRequests') ? OPEN_PRS_FETCHED : null,
        issues: issues ? { limit: issues.limit, label: issues.label } : null,
      };
    }),
  };
}

/**
 * The latest review requests or assignments, to tell when yours happened.
 * Exported so the mapper knows when older events were cut off.
 */
export const EVENTS_FETCHED = 10;

export const INBOX_SEARCHES = {
  reviewQ: 'is:open is:pr archived:false review-requested:@me sort:updated-desc',
  mineQ: 'is:open is:pr archived:false author:@me sort:updated-desc',
  assignedQ: 'is:open archived:false assignee:@me sort:updated-desc',
} as const;

/** Repositories offered as suggestions per token, most recently pushed first. */
export const REPO_SUGGESTIONS_FETCHED = 100;

/** Most checks and reviewers fetched for the details view. */
export const DETAILS_LIST_FETCHED = 50;
