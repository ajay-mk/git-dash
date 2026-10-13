/**
 * Maps raw GitLab GraphQL responses to the provider-agnostic model.
 *
 * API data is untrusted: every field is type-checked, URLs must be pages on
 * the connected GitLab instance, and label colours must be plain hex.
 */

import { parseGitLabPath, type PinnedRepo } from '../../config/schema';
import { prNeedsAttention } from '../../lib/health';
import { connectedGitLabHost, providerOfUrl } from '../../lib/url';
import { arr, num, obj, str, trimBody, type Raw } from '../raw';
import type {
  CheckItem,
  CiState,
  Counted,
  InboxSnapshot,
  IssueItem,
  ItemDetails,
  Label,
  PullRequestItem,
  RepoError,
  RepoSnapshot,
  ReviewerState,
  ReviewState,
} from '../types';
import { SCOPE_LABELS } from './tokenTemplate';

function safeUrl(v: unknown): string {
  const s = str(v);
  return s && providerOfUrl(s) === 'gitlab' ? s : '';
}

/** GitLab numbers issues and merge requests per project as strings. */
function iid(v: unknown): number | null {
  const s = str(v);
  return s && /^\d{1,15}$/.test(s) ? Number(s) : null;
}

/** `group/project` from a full reference such as `group/project!12`. */
function projectOf(reference: unknown): string | null {
  const path = /^(.+)[#!]\d+$/.exec(str(reference) ?? '')?.[1];
  const parsed = path ? parseGitLabPath(path) : null;
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
}

/** Pipeline and job states. Cancelled, skipped and manual count as no result. */
/**
 * Pipeline sources that never set a branch's CI status: GitLab's own
 * "dangling" sources (child pipelines, security scans, Duo workloads, ...).
 */
const DANGLING_SOURCES = new Set([
  'webide',
  'parent_pipeline',
  'ondemand_dast_scan',
  'ondemand_dast_validation',
  'security_orchestration_policy',
  'container_registry_push',
  'duo_workflow',
  'pipeline_execution_policy_schedule',
  'dependency_management_security_update',
]);

function headPipelines(project: unknown): unknown[] {
  const repository = obj(obj(project)?.repository);
  return arr(obj(obj(obj(repository?.tree)?.lastCommit)?.pipelines)?.nodes);
}

/**
 * The default branch to look up separately when every pipeline fetched with
 * the project belonged to something else: a full page of them may have
 * pushed the branch's own pipeline out.
 */
export function branchPipelineToRefetch(project: unknown, fetched: number): string | null {
  const nodes = headPipelines(project);
  const branch = str(obj(obj(project)?.repository)?.rootRef);
  if (!branch || nodes.length < fetched || pickBranchPipeline(nodes, branch)) return null;
  return branch;
}

/** CI state of the default branch from a follow-up `BRANCH_PIPELINE_QUERY`. */
export function mapBranchPipeline(data: unknown, branch: string): CiState {
  return mapPipelineStatus(pickBranchPipeline(headPipelines(obj(data)?.project), branch)?.status);
}

/**
 * The newest pipeline that ran for `branch` itself, out of the pipelines of
 * its head commit (newest first). Others can share the commit: merge request
 * pipelines, other branches at the same commit, and dangling scans.
 */
export function pickBranchPipeline(nodes: unknown[], branch: string | null): Raw | null {
  if (!branch) return null;
  for (const node of nodes) {
    const pipeline = obj(node);
    if (pipeline?.ref !== branch) continue;
    const source = str(pipeline.source)?.toLowerCase();
    if (source && DANGLING_SOURCES.has(source)) continue;
    return pipeline;
  }
  return null;
}

export function mapPipelineStatus(status: unknown): CiState {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'CREATED':
    case 'WAITING_FOR_RESOURCE':
    case 'WAITING_FOR_CALLBACK':
    case 'PREPARING':
    case 'PENDING':
    case 'RUNNING':
    case 'SCHEDULED':
    case 'CANCELING':
      return 'pending';
    default:
      return 'none';
  }
}

/**
 * GitLab Free has no "review required" flag, but its merge status says when
 * approvals are missing or changes were requested. `approved` is also true
 * when no approval is required, so it only counts with an actual approver.
 */
export function mapMergeRequestReview(n: Raw): ReviewState {
  const status = str(n.detailedMergeStatus);
  if (status === 'REQUESTED_CHANGES') return 'changes_requested';
  if (status === 'NOT_APPROVED') return 'review_required';
  if (n.approved === true && arr(obj(n.approvedBy)?.nodes).length > 0) return 'approved';
  return 'none';
}

/** Merge statuses for which GitLab has not finished checking mergeability. */
const MERGE_CHECK_PENDING = new Set(['UNCHECKED', 'CHECKING', 'PREPARING', 'APPROVALS_SYNCING']);

/**
 * GitLab checks for conflicts in the background and reports `conflicts:
 * false` until it has, so the merge status decides when that is final.
 */
function mapMergeable(n: Raw): boolean | null {
  const status = str(n.detailedMergeStatus);
  if (n.conflicts === true || status === 'CONFLICT' || status === 'NEED_REBASE') return false;
  if (status === null || MERGE_CHECK_PENDING.has(status)) return null;
  return n.conflicts === false ? true : null;
}

/**
 * Totals from the per-file stats when GitLab sent them: the summary alone can
 * be stale after a file was added and removed again (gitlab-org/gitlab#607371).
 */
function mapDiffStats(mr: Raw | null): { additions: number; deletions: number; changedFiles: number } {
  const files = mr?.diffStats;
  if (Array.isArray(files)) {
    return files.reduce<{ additions: number; deletions: number; changedFiles: number }>(
      (t, f) => ({
        additions: t.additions + num(obj(f)?.additions),
        deletions: t.deletions + num(obj(f)?.deletions),
        changedFiles: t.changedFiles + 1,
      }),
      { additions: 0, deletions: 0, changedFiles: 0 },
    );
  }
  const summary = obj(mr?.diffStatsSummary);
  return {
    additions: num(summary?.additions),
    deletions: num(summary?.deletions),
    changedFiles: num(summary?.fileCount),
  };
}

function mapLabels(v: unknown): Label[] {
  return arr(obj(v)?.nodes).flatMap((node) => {
    const n = obj(node);
    const name = str(n?.title);
    if (!name) return [];
    const color = /^#?([0-9a-fA-F]{6})$/.exec(str(n?.color) ?? '')?.[1] ?? null;
    return [{ name, color }];
  });
}

export function mapMergeRequest(v: unknown): PullRequestItem | null {
  const n = obj(v);
  const number = iid(n?.iid);
  if (!n || number === null) return null;
  const repo = projectOf(n.reference);
  return {
    number,
    title: str(n.title) ?? '',
    url: safeUrl(n.webUrl),
    author: str(obj(n.author)?.username),
    updatedAt: str(n.updatedAt) ?? '',
    isDraft: n.draft === true,
    review: mapMergeRequestReview(n),
    ci: mapPipelineStatus(obj(n.headPipeline)?.status),
    mergeable: mapMergeable(n),
    ...(repo ? { repo } : {}),
  };
}

/** Maps an issue, or with `isMergeRequest` a merge request shown as an issue row. */
export function mapIssue(v: unknown, isMergeRequest = false): IssueItem | null {
  const n = obj(v);
  const number = iid(n?.iid);
  if (!n || number === null) return null;
  const repo = projectOf(n.reference);
  return {
    number,
    title: str(n.title) ?? '',
    url: safeUrl(n.webUrl),
    author: str(obj(n.author)?.username),
    updatedAt: str(n.updatedAt) ?? '',
    labels: mapLabels(n.labels),
    isPullRequest: isMergeRequest,
    ...(repo ? { repo } : {}),
  };
}

function mapConnection<T>(v: unknown, mapper: (n: unknown) => T | null): Counted<T> {
  const c = obj(v);
  const items = arr(c?.nodes)
    .map(mapper)
    .filter((x): x is T => x !== null);
  return { total: num(c?.count), items };
}

export function mapProject(raw: unknown, config: PinnedRepo): RepoSnapshot {
  const p = obj(raw) ?? {};
  const repository = obj(p.repository);
  const widgets = new Map(config.widgets.map((w) => [w.type, w]));

  let pullRequests: Counted<PullRequestItem> | null = null;
  let prsNeedingAttention = 0;
  const prWidget = widgets.get('pullRequests');
  if (prWidget?.type === 'pullRequests') {
    const all = mapConnection(p.mergeRequests, mapMergeRequest);
    const visible = prWidget.hideDrafts ? all.items.filter((mr) => !mr.isDraft) : all.items;
    pullRequests = { total: all.total, items: visible.slice(0, prWidget.limit) };
    prsNeedingAttention = all.items.filter(prNeedsAttention).length;
  }

  const pipeline = pickBranchPipeline(headPipelines(p), str(repository?.rootRef));
  return {
    fullName: str(p.fullPath) ?? `${config.owner}/${config.name}`,
    url: safeUrl(p.webUrl),
    isPrivate: p.visibility === 'private',
    isArchived: p.archived === true,
    defaultBranch: str(repository?.rootRef),
    ci: widgets.has('ci') ? mapPipelineStatus(pipeline?.status) : null,
    pullRequests,
    prsNeedingAttention,
    issues: widgets.has('issues') ? mapConnection(p.issues, (n) => mapIssue(n)) : null,
  };
}

/** A project that came back empty: GitLab answers `null` for both missing and hidden projects. */
export function projectNotFound(): RepoError {
  return {
    kind: 'not_found',
    message: `Project not found. Check the path for a typo, rename or deletion, and that your account can see it. The token needs the ${SCOPE_LABELS.join(', ')} scope.`,
  };
}

export function projectError(): RepoError {
  return { kind: 'unknown', message: 'Could not load this project.' };
}

const EMPTY: Counted<never> = { total: 0, items: [] };

/** Merges two lists that are each newest first, keeping `limit` items. */
function mergeNewest<T extends { updatedAt: string }>(a: Counted<T>, b: Counted<T>, limit: number): Counted<T> {
  const items = [...a.items, ...b.items].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, limit);
  return { total: a.total + b.total, items };
}

/**
 * Maps the inbox: `user` is `currentUser` from `INBOX_QUERY`, `issues` the
 * assigned-issues connection (null when that section is off).
 */
export function mapInbox(user: unknown, issues: unknown, limit: number): InboxSnapshot {
  const u = obj(user) ?? {};
  const assignedMrs = u.assignedMergeRequests ? mapConnection(u.assignedMergeRequests, (n) => mapIssue(n, true)) : EMPTY;
  const assignedIssues = issues ? mapConnection(issues, (n) => mapIssue(n)) : EMPTY;
  return {
    viewer: str(u.username) ?? '',
    reviewRequests: u.reviewRequestedMergeRequests ? mapConnection(u.reviewRequestedMergeRequests, mapMergeRequest) : EMPTY,
    myPullRequests: u.authoredMergeRequests ? mapConnection(u.authoredMergeRequests, mapMergeRequest) : EMPTY,
    assigned: mergeNewest<IssueItem>(assignedMrs, assignedIssues, limit),
    ssoRestricted: false,
  };
}

/** A project offered as a suggestion when pinning. */
export interface ProjectSuggestion {
  name: string;
  activeAt: string | null;
}

export function mapProjectSuggestions(connection: unknown): ProjectSuggestion[] {
  return arr(obj(connection)?.nodes).flatMap((n) => {
    const node = obj(n);
    const parsed = parseGitLabPath(str(node?.fullPath) ?? '');
    if (!node || !parsed || node.archived === true) return [];
    return [{ name: `${parsed.owner}/${parsed.name}`, activeAt: str(node.lastActivityAt) }];
  });
}

/** Where a merge request or issue lives, from its web URL on the connected instance. */
export interface ItemRef {
  path: string;
  iid: string;
  isMergeRequest: boolean;
}

export function parseItemUrl(url: string): ItemRef | null {
  if (providerOfUrl(url) !== 'gitlab') return null;
  const match = /^\/(.+?)\/-\/(merge_requests|issues|work_items)\/(\d{1,15})\/?$/.exec(new URL(url).pathname);
  if (!match || !parseGitLabPath(match[1]!)) return null;
  return { path: match[1]!, iid: match[3]!, isMergeRequest: match[2] === 'merge_requests' };
}

function mapJob(v: unknown): CheckItem | null {
  const n = obj(v);
  const name = str(n?.name);
  if (!n || !name) return null;
  const path = str(n.webPath);
  const host = connectedGitLabHost();
  const url = path && host && path.startsWith('/') && !path.startsWith('//') ? safeUrl(`https://${host}${path}`) : '';
  let state = n.status === 'SKIPPED' ? 'success' : mapPipelineStatus(n.status);
  // A job allowed to fail does not fail its pipeline, so it is not shown as failing.
  if (state === 'failure' && n.allowFailure === true) state = 'none';
  return { name, state, url: url || null };
}

const REVIEW_STATES: Record<string, ReviewerState> = {
  APPROVED: 'approved',
  REQUESTED_CHANGES: 'changes_requested',
  REVIEWED: 'commented',
  UNREVIEWED: 'requested',
  REVIEW_STARTED: 'requested',
  UNAPPROVED: 'requested',
};

function mapReviewers(reviewers: unknown, approvedBy: unknown): { login: string; state: ReviewerState }[] {
  const out = new Map<string, ReviewerState>();
  for (const node of arr(obj(reviewers)?.nodes)) {
    const n = obj(node);
    const login = str(n?.username);
    const state = REVIEW_STATES[str(obj(n?.mergeRequestInteraction)?.reviewState) ?? ''] ?? 'requested';
    if (login) out.set(login, state);
  }
  // Anyone can approve without being asked to review.
  for (const node of arr(obj(approvedBy)?.nodes)) {
    const login = str(obj(node)?.username);
    if (login && !out.has(login)) out.set(login, 'approved');
  }
  return [...out].map(([login, state]) => ({ login, state }));
}

/** Maps a `project { mergeRequest | issue }` response; `null` when neither came back. */
export function mapDetails(project: unknown): ItemDetails | null {
  const p = obj(project);
  const mr = obj(p?.mergeRequest);
  const n = mr ?? obj(p?.issue);
  if (!n) return null;
  const jobs = obj(obj(mr?.headPipeline)?.jobs);
  const checks = arr(jobs?.nodes).flatMap((j) => mapJob(j) ?? []);
  const stats = mapDiffStats(mr);
  return {
    createdAt: str(n.createdAt) ?? '',
    incomplete: false,
    body: trimBody(n.description),
    comments: num(n.userNotesCount),
    labels: mapLabels(n.labels),
    assignees: arr(obj(n.assignees)?.nodes).flatMap((a) => {
      const login = str(obj(a)?.username);
      return login ? [login] : [];
    }),
    pr: mr
      ? {
          baseRef: str(mr.targetBranch) ?? '',
          headRef: str(mr.sourceBranch) ?? '',
          ...stats,
          checks,
          checksTotal: Math.max(checks.length, num(jobs?.count)),
          reviewers: mapReviewers(mr.reviewers, mr.approvedBy),
        }
      : null,
  };
}
