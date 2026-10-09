/**
 * GraphQL documents for GitHub.
 *
 * Query text is assembled only from the constant fragments below; anything
 * that comes from the user (owner, repo name, label, limits) is passed as a
 * GraphQL variable, never interpolated into the query string.
 */

import type { PinnedRepo } from '../../config/schema';

const CI_ROLLUP = 'statusCheckRollup { state }';

const PR_FIELDS = `
  number title url isDraft updatedAt reviewDecision mergeable
  author { login }
  commits(last: 1) { nodes { commit { ${CI_ROLLUP} } } }
  repository { nameWithOwner }
`;

const ISSUE_FIELDS = `
  number title url updatedAt
  author { login }
  labels(first: 4) { nodes { name color } }
  repository { nameWithOwner }
`;

/**
 * Open PRs fetched per repository. More than the widget shows, so that card
 * health sees PRs beyond the display limit and hiding drafts still leaves
 * enough to show.
 */
export const OPEN_PRS_FETCHED = 50;

export function repoAlias(index: number): string {
  return `r${index}`;
}

export interface BuiltQuery {
  query: string;
  variables: Record<string, unknown>;
}

export function buildReposQuery(repos: PinnedRepo[]): BuiltQuery {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, unknown> = {};

  repos.forEach((repo, i) => {
    const owner = `o${i}`;
    const name = `n${i}`;
    varDefs.push(`$${owner}: String!`, `$${name}: String!`);
    variables[owner] = repo.owner;
    variables[name] = repo.name;

    const parts = ['nameWithOwner url isPrivate isArchived'];
    const ci = repo.widgets.some((w) => w.type === 'ci');
    parts.push(`defaultBranchRef { name ${ci ? `target { ... on Commit { ${CI_ROLLUP} } }` : ''} }`);

    for (const widget of repo.widgets) {
      if (widget.type === 'pullRequests') {
        const first = `pr${i}`;
        varDefs.push(`$${first}: Int!`);
        variables[first] = OPEN_PRS_FETCHED;
        parts.push(
          `pullRequests(states: OPEN, first: $${first}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { ${PR_FIELDS} } }`,
        );
      } else if (widget.type === 'issues') {
        const first = `is${i}`;
        varDefs.push(`$${first}: Int!`);
        variables[first] = widget.limit;
        let labelArg = '';
        if (widget.label) {
          const labels = `il${i}`;
          varDefs.push(`$${labels}: [String!]`);
          variables[labels] = [widget.label];
          labelArg = `, labels: $${labels}`;
        }
        parts.push(
          `issues(states: OPEN, first: $${first}${labelArg}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { ${ISSUE_FIELDS} } }`,
        );
      }
    }

    selections.push(`${repoAlias(i)}: repository(owner: $${owner}, name: $${name}) { ${parts.join(' ')} }`);
  });

  const defs = varDefs.length > 0 ? `(${varDefs.join(', ')})` : '';
  const query = `query GitDashRepos${defs} { ${selections.join(' ')} rateLimit { remaining limit resetAt } }`;
  return { query, variables };
}

export const INBOX_QUERY = `
query GitDashInbox(
  $n: Int!
  $reviewQ: String!, $mineQ: String!, $assignedQ: String!
  $withReview: Boolean!, $withMine: Boolean!, $withAssigned: Boolean!
) {
  viewer { login }
  reviewRequests: search(query: $reviewQ, type: ISSUE, first: $n) @include(if: $withReview) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  myPullRequests: search(query: $mineQ, type: ISSUE, first: $n) @include(if: $withMine) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  assigned: search(query: $assignedQ, type: ISSUE, first: $n) @include(if: $withAssigned) {
    issueCount
    nodes {
      __typename
      ... on Issue { ${ISSUE_FIELDS} }
      ... on PullRequest { ${ISSUE_FIELDS} }
    }
  }
}
`;

export const INBOX_SEARCHES = {
  reviewQ: 'is:open is:pr archived:false review-requested:@me sort:updated-desc',
  mineQ: 'is:open is:pr archived:false author:@me sort:updated-desc',
  assignedQ: 'is:open archived:false assignee:@me sort:updated-desc',
} as const;
