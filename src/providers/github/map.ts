/**
 * Maps raw GitHub GraphQL responses to the provider-agnostic model.
 *
 * API data is treated as untrusted: every field is type-checked, URLs must be
 * GitHub web URLs, and label colours must be plain hex.
 */

import type { PinnedRepo } from '../../config/schema';
import { prNeedsAttention } from '../../lib/health';
import { isSafeExternalUrl } from '../../lib/url';
import type {
  CiState,
  Counted,
  InboxSnapshot,
  IssueItem,
  Label,
  PullRequestItem,
  RateLimit,
  RepoSnapshot,
  ReviewState,
} from '../types';

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function safeUrl(v: unknown): string {
  const s = str(v);
  return s && isSafeExternalUrl(s) ? s : '';
}

export function mapCi(rollup: unknown): CiState {
  switch (str(obj(rollup)?.state)) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

export function mapReview(decision: unknown): ReviewState {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return 'none';
  }
}

function mapLabels(v: unknown): Label[] {
  return arr(obj(v)?.nodes).flatMap((node) => {
    const n = obj(node);
    const name = str(n?.name);
    if (!name) return [];
    const color = str(n?.color);
    return [{ name, color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color : null }];
  });
}

export function mapPullRequest(v: unknown): PullRequestItem | null {
  const n = obj(v);
  if (!n || typeof n.number !== 'number') return null;
  const lastCommit = obj(arr(obj(n.commits)?.nodes)[0])?.commit;
  const repo = str(obj(n.repository)?.nameWithOwner);
  return {
    number: n.number,
    title: str(n.title) ?? '',
    url: safeUrl(n.url),
    author: str(obj(n.author)?.login),
    updatedAt: str(n.updatedAt) ?? '',
    isDraft: n.isDraft === true,
    review: mapReview(n.reviewDecision),
    ci: mapCi(obj(lastCommit)?.statusCheckRollup),
    mergeable: n.mergeable === 'MERGEABLE' ? true : n.mergeable === 'CONFLICTING' ? false : null,
    ...(repo ? { repo } : {}),
  };
}

export function mapIssue(v: unknown): IssueItem | null {
  const n = obj(v);
  if (!n || typeof n.number !== 'number') return null;
  const repo = str(obj(n.repository)?.nameWithOwner);
  return {
    number: n.number,
    title: str(n.title) ?? '',
    url: safeUrl(n.url),
    author: str(obj(n.author)?.login),
    updatedAt: str(n.updatedAt) ?? '',
    labels: mapLabels(n.labels),
    isPullRequest: n.__typename === 'PullRequest',
    ...(repo ? { repo } : {}),
  };
}

function mapConnection<T>(v: unknown, mapper: (n: unknown) => T | null, totalKey = 'totalCount'): Counted<T> {
  const c = obj(v);
  const items = arr(c?.nodes)
    .map(mapper)
    .filter((x): x is T => x !== null);
  return { total: num(c?.[totalKey]), items };
}

export function mapRepository(raw: unknown, config: PinnedRepo): RepoSnapshot {
  const r = obj(raw) ?? {};
  const branch = obj(r.defaultBranchRef);
  const widgets = new Map(config.widgets.map((w) => [w.type, w]));

  let pullRequests: Counted<PullRequestItem> | null = null;
  let prsNeedingAttention = 0;
  const prWidget = widgets.get('pullRequests');
  if (prWidget?.type === 'pullRequests') {
    const all = mapConnection(r.pullRequests, mapPullRequest);
    const visible = prWidget.hideDrafts ? all.items.filter((pr) => !pr.isDraft) : all.items;
    pullRequests = { total: all.total, items: visible.slice(0, prWidget.limit) };
    prsNeedingAttention = all.items.filter(prNeedsAttention).length;
  }

  return {
    fullName: str(r.nameWithOwner) ?? `${config.owner}/${config.name}`,
    url: safeUrl(r.url),
    isPrivate: r.isPrivate === true,
    isArchived: r.isArchived === true,
    defaultBranch: str(branch?.name),
    ci: widgets.has('ci') ? mapCi(obj(branch?.target)?.statusCheckRollup) : null,
    pullRequests,
    prsNeedingAttention,
    issues: widgets.has('issues') ? mapConnection(r.issues, mapIssue) : null,
  };
}

export function mapRateLimit(v: unknown): RateLimit | null {
  const r = obj(v);
  if (!r) return null;
  return { remaining: num(r.remaining), limit: num(r.limit), resetAt: str(r.resetAt) ?? '' };
}

const EMPTY: Counted<never> = { total: 0, items: [] };

export function mapInbox(data: unknown): InboxSnapshot {
  const d = obj(data) ?? {};
  return {
    viewer: str(obj(d.viewer)?.login) ?? '',
    reviewRequests: d.reviewRequests ? mapConnection(d.reviewRequests, mapPullRequest, 'issueCount') : EMPTY,
    myPullRequests: d.myPullRequests ? mapConnection(d.myPullRequests, mapPullRequest, 'issueCount') : EMPTY,
    assigned: d.assigned ? mapConnection(d.assigned, mapIssue, 'issueCount') : EMPTY,
  };
}

/** Converts a GraphQL error into a short, user-facing message. */
export function describeRepoError(err: { type?: string; message?: string } | undefined): string {
  if (err?.type === 'NOT_FOUND') return 'Repository not found, or your token cannot access it.';
  if (err?.type === 'FORBIDDEN') return 'Your token is not allowed to read this repository.';
  return 'Could not load this repository.';
}
