/**
 * Maps raw GitHub GraphQL responses to the provider-agnostic model.
 *
 * API data is treated as untrusted: every field is type-checked, URLs must be
 * GitHub web URLs, and label colours must be plain hex.
 */

import type { PinnedRepo } from '../../config/schema';
import { prNeedsAttention } from '../../lib/health';
import type { GraphQLError } from '../../lib/transport';
import { isSafeExternalUrl } from '../../lib/url';
import type {
  CiState,
  Counted,
  InboxSnapshot,
  IssueItem,
  Label,
  PullRequestItem,
  RateLimit,
  RepoError,
  RepoErrorKind,
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

export function mapInbox(data: unknown, errors: GraphQLError[] = []): InboxSnapshot {
  const d = obj(data) ?? {};
  return {
    viewer: str(obj(d.viewer)?.login) ?? '',
    reviewRequests: d.reviewRequests ? mapConnection(d.reviewRequests, mapPullRequest, 'issueCount') : EMPTY,
    myPullRequests: d.myPullRequests ? mapConnection(d.myPullRequests, mapPullRequest, 'issueCount') : EMPTY,
    assigned: d.assigned ? mapConnection(d.assigned, mapIssue, 'issueCount') : EMPTY,
    // Search results from SSO-protected organizations come back as null
    // nodes, each with a SAML error.
    ssoRestricted: errors.some(isSamlFailure),
  };
}

const CLASSIC_TOKENS_URL = 'https://github.com/settings/tokens';
const FINE_GRAINED_TOKENS_URL = 'https://github.com/settings/personal-access-tokens';

/**
 * True when GitHub withheld a resource because its organization enforces SAML
 * SSO and the token is not authorized for it. GitHub types these errors
 * FORBIDDEN and sets `extensions.saml_failure`.
 */
export function isSamlFailure(err: GraphQLError | undefined): boolean {
  return obj(err?.extensions)?.saml_failure === true || /SAML enforcement/i.test(err?.message ?? '');
}

export function isRateLimited(err: GraphQLError | undefined): boolean {
  // GitHub has used both spellings for the GraphQL primary rate limit.
  return err?.type === 'RATE_LIMITED' || err?.type === 'RATE_LIMIT';
}

/**
 * Organizations can forbid classic tokens, or fine-grained tokens with a long
 * lifetime. GitHub's message then says the organization "forbids access via"
 * that kind of token.
 */
function isTokenPolicyFailure(err: GraphQLError | undefined): boolean {
  const message = err?.message ?? '';
  return /forbids access via/i.test(message) && /token/i.test(message);
}

export function classifyRepoError(err: GraphQLError | undefined): RepoErrorKind {
  // Order matters: SAML and token policy failures are also typed FORBIDDEN.
  if (isSamlFailure(err)) return 'sso_required';
  if (isRateLimited(err)) return 'rate_limited';
  if (isTokenPolicyFailure(err)) return 'token_policy';
  if (err?.type === 'NOT_FOUND') return 'not_found';
  if (err?.type === 'FORBIDDEN') return 'forbidden';
  return 'unknown';
}

/**
 * Converts a GraphQL error into a short, user-facing explanation. The wording
 * is ours; GitHub's message is only used to classify the error.
 */
export function describeRepoError(err: GraphQLError | undefined, owner: string): RepoError {
  const kind = classifyRepoError(err);
  switch (kind) {
    case 'sso_required':
      return {
        kind,
        message: `${owner} uses SAML single sign-on and your token is not authorized for it. On your tokens page, choose "Configure SSO" next to the token and authorize ${owner}; no admin is needed.`,
        help: { url: CLASSIC_TOKENS_URL, label: 'Authorize token' },
      };
    case 'token_policy':
      return {
        kind,
        message: `${owner} does not accept this kind of token. Create a token type it allows, or ask an owner of ${owner} to change the policy.`,
        help: { url: FINE_GRAINED_TOKENS_URL, label: 'Manage tokens' },
      };
    case 'not_found':
      // GitHub also answers NOT_FOUND when a fine-grained token cannot see a
      // private repository, so the cause cannot be told apart here.
      return {
        kind,
        message: `Repository not found. Check the name for a typo, rename or deletion. A fine-grained token must include this repository, and an owner of ${owner} may need to approve it.`,
        help: { url: FINE_GRAINED_TOKENS_URL, label: 'Check token access' },
      };
    case 'forbidden':
      return {
        kind,
        message: 'Your token is not allowed to read this repository. Check its permissions.',
        help: { url: FINE_GRAINED_TOKENS_URL, label: 'Check token access' },
      };
    case 'rate_limited':
      return { kind, message: 'GitHub rate limit reached. This will retry on the next refresh.' };
    case 'unknown':
      return { kind, message: 'Could not load this repository.' };
  }
}
