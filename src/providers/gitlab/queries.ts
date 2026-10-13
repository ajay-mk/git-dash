/**
 * GraphQL documents for GitLab.
 *
 * As for GitHub, query text is assembled only from the constant fragments
 * below; project paths, labels and limits are passed as variables. Fields are
 * limited to ones GitLab Free (CE) has, so self-hosted instances work too.
 */

import type { PinnedRepo } from '../../config/schema';

const MR_FIELDS = `
  iid title webUrl draft updatedAt approved detailedMergeStatus conflicts
  reference(full: true)
  author { username }
  headPipeline { status }
  approvedBy(first: 1) { nodes { username } }
`;

const ISSUE_FIELDS = `
  iid title webUrl updatedAt
  reference(full: true)
  author { username }
  labels(first: 4) { nodes { title color } }
`;

/** Open merge requests fetched per project; see `OPEN_PRS_FETCHED` for GitHub. */
export const OPEN_MRS_FETCHED = 50;

/**
 * GitLab caps each request's query complexity at 250. A project with every
 * widget costs about 75, so two per request leaves room to spare.
 */
export const PROJECTS_PER_REQUEST = 2;

export function projectAlias(index: number): string {
  return `p${index}`;
}

export interface BuiltQuery {
  query: string;
  variables: Record<string, unknown>;
}

export function buildProjectsQuery(repos: PinnedRepo[]): BuiltQuery {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, unknown> = {};

  repos.forEach((repo, i) => {
    const path = `path${i}`;
    varDefs.push(`$${path}: ID!`);
    variables[path] = `${repo.owner}/${repo.name}`;

    const parts = ['fullPath webUrl visibility archived'];
    const ci = repo.widgets.some((w) => w.type === 'ci');
    // The tree defaults to the default branch, so its last commit is the
    // branch head; its newest pipeline is the branch's CI state.
    parts.push(
      `repository { rootRef ${ci ? 'tree { lastCommit { pipelines(first: 1) { nodes { status } } } }' : ''} }`,
    );

    for (const widget of repo.widgets) {
      if (widget.type === 'pullRequests') {
        const first = `mr${i}`;
        varDefs.push(`$${first}: Int!`);
        variables[first] = OPEN_MRS_FETCHED;
        parts.push(`mergeRequests(state: opened, first: $${first}, sort: UPDATED_DESC) { count nodes { ${MR_FIELDS} } }`);
      } else if (widget.type === 'issues') {
        const first = `is${i}`;
        varDefs.push(`$${first}: Int!`);
        variables[first] = widget.limit;
        let labelArg = '';
        if (widget.label) {
          const labels = `il${i}`;
          varDefs.push(`$${labels}: [String!]`);
          variables[labels] = [widget.label];
          labelArg = `, labelName: $${labels}`;
        }
        parts.push(
          `issues(state: opened, first: $${first}${labelArg}, sort: UPDATED_DESC) { count nodes { ${ISSUE_FIELDS} } }`,
        );
      }
    }

    selections.push(`${projectAlias(i)}: project(fullPath: $${path}) { ${parts.join(' ')} }`);
  });

  const defs = varDefs.length > 0 ? `(${varDefs.join(', ')})` : '';
  return { query: `query GitDashProjects${defs} { ${selections.join(' ')} }`, variables };
}

/** Merge requests that need the viewer; assigned issues follow in `ASSIGNED_ISSUES_QUERY`. */
export const INBOX_QUERY = `
query GitDashInbox($n: Int!, $withReview: Boolean!, $withMine: Boolean!, $withAssigned: Boolean!) {
  currentUser {
    username
    reviewRequestedMergeRequests(state: opened, first: $n, sort: UPDATED_DESC) @include(if: $withReview) {
      count nodes { ${MR_FIELDS} }
    }
    authoredMergeRequests(state: opened, first: $n, sort: UPDATED_DESC) @include(if: $withMine) {
      count nodes { ${MR_FIELDS} }
    }
    assignedMergeRequests(state: opened, first: $n, sort: UPDATED_DESC) @include(if: $withAssigned) {
      count nodes { ${ISSUE_FIELDS} }
    }
  }
}
`;

export const ASSIGNED_ISSUES_QUERY = `
query GitDashAssignedIssues($me: String!, $n: Int!) {
  issues(assigneeUsernames: [$me], state: opened, first: $n, sort: UPDATED_DESC) {
    count nodes { ${ISSUE_FIELDS} }
  }
}
`;

/** Projects offered as suggestions when pinning. */
export const PROJECT_SUGGESTIONS_FETCHED = 100;

/** Projects the viewer is a member of, most recently active first. */
export const PROJECTS_QUERY = `
query GitDashProjectList($n: Int!) {
  projects(membership: true, archived: EXCLUDE, first: $n, sort: "latest_activity_desc") {
    nodes { fullPath archived lastActivityAt }
  }
}
`;

/** Most jobs and reviewers fetched for the details view. */
export const DETAILS_LIST_FETCHED = 50;

const DETAILS_COMMON = `
  createdAt description userNotesCount
  labels(first: 10) { nodes { title color } }
`;

/** One merge request or issue of a project, for the details view. */
export const DETAILS_QUERY = `
query GitDashDetails($path: ID!, $iid: String!, $n: Int!, $mr: Boolean!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) @include(if: $mr) {
      ${DETAILS_COMMON}
      sourceBranch targetBranch
      diffStatsSummary { additions deletions fileCount }
      headPipeline { jobs(first: $n, retried: false) { count nodes { name status webPath } } }
      reviewers(first: $n) { nodes { username mergeRequestInteraction { reviewState } } }
      approvedBy(first: $n) { nodes { username } }
    }
    issue(iid: $iid) @skip(if: $mr) {
      ${DETAILS_COMMON}
      assignees(first: 10) { nodes { username } }
    }
  }
}
`;
