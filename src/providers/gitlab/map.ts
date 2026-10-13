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
    mergeable: n.conflicts === true ? false : n.conflicts === false ? true : null,
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

  const pipeline = obj(arr(obj(obj(obj(repository?.tree)?.lastCommit)?.pipelines)?.nodes)[0]);
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
  const state = n.status === 'SKIPPED' ? 'success' : mapPipelineStatus(n.status);
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
  const stats = obj(mr?.diffStatsSummary);
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
          additions: num(stats?.additions),
          deletions: num(stats?.deletions),
          changedFiles: num(stats?.fileCount),
          checks,
          checksTotal: Math.max(checks.length, num(jobs?.count)),
          reviewers: mapReviewers(mr.reviewers, mr.approvedBy),
        }
      : null,
  };
}
