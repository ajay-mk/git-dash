/**
 * Maps raw GitHub GraphQL responses to the provider-agnostic model.
 *
 * API data is treated as untrusted: every field is type-checked, URLs must be
 * GitHub web URLs, and label colours must be plain hex.
 */

import { parseRepoInput, type PinnedRepo } from '../../config/schema';
import { prNeedsAttention } from '../../lib/health';
import type { GraphQLError } from '../../lib/transport';
import { isSafeExternalUrl } from '../../lib/url';
import { EVENTS_FETCHED } from './queries';
import { PERMISSION_LABELS } from './tokenTemplate';
import { arr, num, obj, str, trimBody, type Raw } from '../raw';
import type {
  CheckItem,
  CiState,
  Counted,
  ItemDetails,
  InboxSnapshot,
  IssueItem,
  Label,
  PullRequestItem,
  RateLimit,
  RepoError,
  RepoErrorKind,
  RepoSnapshot,
  ReviewerState,
  ReviewState,
} from '../types';

const LONG_AGO = new Date(0).toISOString();

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

function mapConnection<T>(v: unknown, mapper: (n: unknown, index: number) => T | null, totalKey = 'totalCount'): Counted<T> {
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

/**
 * When the latest of `node`'s timeline events (review requests or
 * assignments) that `matches` happened. `key` names the event's user field.
 * When none matches but older events were cut off, the one sought is older
 * than every event fetched; it is then given as long ago.
 */
function lastEvent(node: unknown, key: string, matches: (who: Raw) => boolean): string | undefined {
  const events = arr(obj(obj(node)?.timelineItems)?.nodes).flatMap((event) => {
    const e = obj(event);
    const who = obj(e?.[key]);
    const at = str(e?.createdAt);
    return at && who ? [{ at, who }] : [];
  });
  let latest: string | undefined;
  for (const { at, who } of events) {
    if (matches(who) && (!latest || at > latest)) latest = at;
  }
  if (latest || events.length < EVENTS_FETCHED) return latest;
  return LONG_AGO;
}

/**
 * Which review-request events are the viewer's: the request to them if it is
 * still pending, otherwise those to a team that is. Team members are not
 * fetched; the search found the pull request through one of those teams.
 */
function reviewRequestMatcher(node: unknown, viewer: string): (who: Raw) => boolean {
  const isViewer = (who: Raw) => who.__typename === 'User' && str(who.login)?.toLowerCase() === viewer;
  const pending = obj(obj(node)?.reviewRequests)?.nodes;
  if (!Array.isArray(pending)) return (who) => isViewer(who) || who.__typename === 'Team';
  const reviewers = pending.flatMap((r) => {
    const who = obj(obj(r)?.requestedReviewer);
    return who ? [who] : [];
  });
  if (reviewers.some(isViewer)) return isViewer;
  const teams = new Set(
    reviewers.flatMap((who) => {
      const id = str(who.id);
      return who.__typename === 'Team' && id ? [id] : [];
    }),
  );
  return (who) => who.__typename === 'Team' && teams.has(str(who.id) ?? '');
}

export function mapInbox(data: unknown, errors: GraphQLError[] = []): InboxSnapshot {
  const d = obj(data) ?? {};
  const viewer = str(obj(d.viewer)?.login) ?? '';
  const me = viewer.toLowerCase();
  // Items whose fields (a check rollup, the timeline) were lost to an error.
  const lost = (section: string) =>
    new Set(
      errors.flatMap((e) =>
        e.path?.[0] === section && e.path[1] === 'nodes' && typeof e.path[2] === 'number' && e.path.length > 3
          ? [e.path[2]]
          : [],
      ),
    );
  const lostReviews = lost('reviewRequests');
  const lostMine = lost('myPullRequests');
  const lostAssigned = lost('assigned');
  const reviewRequest = (n: unknown, index: number): PullRequestItem | null => {
    const pr = mapPullRequest(n);
    if (!pr) return null;
    const at = lastEvent(n, 'requestedReviewer', reviewRequestMatcher(n, me));
    return { ...pr, ...(at ? { requestedAt: at } : {}), ...(lostReviews.has(index) ? { partial: true } : {}) };
  };
  const mine = (n: unknown, index: number): PullRequestItem | null => {
    const pr = mapPullRequest(n);
    return pr && lostMine.has(index) ? { ...pr, partial: true } : pr;
  };
  const assignment = (n: unknown, index: number): IssueItem | null => {
    const item = mapIssue(n);
    if (!item) return null;
    const at = lastEvent(n, 'assignee', (who) => str(who.login)?.toLowerCase() === me);
    return { ...item, ...(at ? { assignedAt: at } : {}), ...(lostAssigned.has(index) ? { partial: true } : {}) };
  };
  return {
    viewer,
    reviewRequests: d.reviewRequests ? mapConnection(d.reviewRequests, reviewRequest, 'issueCount') : EMPTY,
    myPullRequests: d.myPullRequests ? mapConnection(d.myPullRequests, mine, 'issueCount') : EMPTY,
    assigned: d.assigned ? mapConnection(d.assigned, assignment, 'issueCount') : EMPTY,
    // Search results from SSO-protected organizations come back as null
    // nodes, each with a SAML error.
    ssoRestricted: errors.some(isSamlFailure),
    // Other errors null out results that are normally there. SSO ones are
    // left out: they hide the same results every time.
    ...(errors.some((e) => !isSamlFailure(e)) ? { incomplete: true } : {}),
  };
}

const CLASSIC_TOKENS_URL = 'https://github.com/settings/tokens';
const FINE_GRAINED_TOKENS_URL = 'https://github.com/settings/personal-access-tokens';
const REQUIRED_PERMISSIONS = `read-only ${PERMISSION_LABELS.slice(0, -1).join(', ')} and ${PERMISSION_LABELS.at(-1)} permissions`;

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
        message: `${owner} uses SAML single sign-on and your token is not authorized for it. For a personal access token, choose "Configure SSO" next to it on your tokens page and authorize ${owner}; no admin is needed. For an OAuth token, such as one from the GitHub CLI, sign in through ${owner}'s SSO and authorize the app again.`,
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
        message: `Repository not found. Check the name for a typo, rename or deletion. A fine-grained token must include this repository and have ${REQUIRED_PERMISSIONS}, and an owner of ${owner} may need to approve it.`,
        help: { url: FINE_GRAINED_TOKENS_URL, label: 'Check token access' },
      };
    case 'forbidden':
      return {
        kind,
        // Typical for a fine-grained token that covers the repository but is
        // missing one of the permissions (GitHub: "Resource not accessible").
        message: `Your token is not allowed to read all of this repository. A fine-grained token needs ${REQUIRED_PERMISSIONS}; edit the token on GitHub to add any that are missing.`,
        help: { url: FINE_GRAINED_TOKENS_URL, label: 'Edit token permissions' },
      };
    case 'rate_limited':
      return { kind, message: 'GitHub rate limit reached. This will retry on the next refresh.' };
    case 'not_connected':
    case 'unknown':
      return { kind, message: 'Could not load this repository.' };
  }
}

/** A repository offered as a suggestion when pinning. */
export interface RepoSuggestion {
  /** `owner/name`. */
  name: string;
  /** ISO timestamp of the last push, or `null` if never pushed. */
  pushedAt: string | null;
}

/**
 * Maps a `repositories` connection to suggestions, skipping archived
 * repositories and anything that would not pass as a pinned repository.
 */
export function mapRepoSuggestions(connection: unknown): RepoSuggestion[] {
  return arr(obj(connection)?.nodes).flatMap((n) => {
    const node = obj(n);
    const name = str(node?.nameWithOwner);
    if (!node || !name || node.isArchived === true) return [];
    const parsed = parseRepoInput(name);
    return parsed ? [{ name: `${parsed.owner}/${parsed.name}`, pushedAt: str(node.pushedAt) }] : [];
  });
}

function mapCheckRun(n: Raw): CheckItem | null {
  const name = str(n.name);
  if (!name) return null;
  let state: CiState;
  if (n.status !== 'COMPLETED') state = 'pending';
  else {
    switch (n.conclusion) {
      case 'SUCCESS':
      case 'NEUTRAL':
      case 'SKIPPED':
        state = 'success';
        break;
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'CANCELLED':
      case 'STARTUP_FAILURE':
      case 'ACTION_REQUIRED':
        state = 'failure';
        break;
      default:
        state = 'none';
    }
  }
  return { name, state, url: safeUrl(n.detailsUrl) || null };
}

function mapCheck(v: unknown): CheckItem | null {
  const n = obj(v);
  if (!n) return null;
  if (n.__typename === 'CheckRun') return mapCheckRun(n);
  const name = str(n.context);
  if (!name) return null;
  return { name, state: mapCi({ state: n.state }), url: safeUrl(n.targetUrl) || null };
}

const REVIEWER_STATES: Record<string, ReviewerState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
};

function mapReviewers(reviews: unknown, requests: unknown): { login: string; state: ReviewerState }[] {
  const out = new Map<string, ReviewerState>();
  // A pending request is newer than that person's earlier review.
  for (const node of arr(obj(requests)?.nodes)) {
    const r = obj(obj(node)?.requestedReviewer);
    const login = str(r?.login) ?? str(r?.slug);
    if (login && !out.has(login)) out.set(login, 'requested');
  }
  for (const node of arr(obj(reviews)?.nodes)) {
    const n = obj(node);
    const login = str(obj(n?.author)?.login);
    const state = REVIEWER_STATES[str(n?.state) ?? ''];
    if (login && state && !out.has(login)) out.set(login, state);
  }
  return [...out].map(([login, state]) => ({ login, state }));
}

/** Maps `resource(url:)`; `null` when it is not a pull request or issue. */
export function mapDetails(v: unknown): ItemDetails | null {
  const n = obj(v);
  if (!n || (n.__typename !== 'PullRequest' && n.__typename !== 'Issue')) return null;
  const isPr = n.__typename === 'PullRequest';
  const rollup = obj(obj(obj(arr(obj(n.commits)?.nodes)[0])?.commit)?.statusCheckRollup);
  const checks = arr(obj(rollup?.contexts)?.nodes).flatMap((c) => mapCheck(c) ?? []);
  return {
    createdAt: str(n.createdAt) ?? '',
    incomplete: false,
    body: trimBody(n.bodyText),
    comments: num(obj(n.comments)?.totalCount),
    labels: mapLabels(n.labels),
    assignees: arr(obj(n.assignees)?.nodes).flatMap((a) => {
      const login = str(obj(a)?.login);
      return login ? [login] : [];
    }),
    pr: isPr
      ? {
          baseRef: str(n.baseRefName) ?? '',
          headRef: str(n.headRefName) ?? '',
          additions: num(n.additions),
          deletions: num(n.deletions),
          changedFiles: num(n.changedFiles),
          checks,
          checksTotal: Math.max(checks.length, num(obj(rollup?.contexts)?.totalCount)),
          reviewers: mapReviewers(n.latestReviews, n.reviewRequests),
        }
      : null,
  };
}
