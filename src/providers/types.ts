/**
 * Provider-agnostic data model.
 *
 * Every service (GitHub and GitLab today; Gitea, ... later) maps its API responses
 * into these shapes, so widgets never depend on a specific provider's API.
 */

import type { InboxConfig, PinnedRepo } from '../config/schema';

export const PROVIDER_IDS = ['github', 'gitlab'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Aggregated CI state for a commit. */
export type CiState = 'success' | 'failure' | 'pending' | 'none';

export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'none';

export interface Label {
  name: string;
  /** 6-digit hex without '#', validated by the provider mapper. */
  color: string | null;
}

export interface PullRequestItem {
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  isDraft: boolean;
  review: ReviewState;
  ci: CiState;
  /** Whether it merges cleanly; `null` while the provider is still computing it. */
  mergeable: boolean | null;
  /** Repository name; set for cross-repo lists such as the inbox. */
  repo?: string;
  /** When your review was last requested; set for the inbox's review requests. */
  requestedAt?: string;
  /** Some of its fields failed to load, so they may read as empty. */
  partial?: boolean;
}

export interface IssueItem {
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  labels: Label[];
  isPullRequest: boolean;
  repo?: string;
  /** When it was last assigned to you; set for the inbox's assigned items. */
  assignedAt?: string;
  /** Some of its fields failed to load, so they may read as empty. */
  partial?: boolean;
}

/** One CI check on a pull request's head commit. */
export interface CheckItem {
  name: string;
  state: CiState;
  url: string | null;
}

export type ReviewerState = 'approved' | 'changes_requested' | 'commented' | 'requested';

/** Extra facts about a pull request or issue, loaded when its details open. */
export interface ItemDetails {
  createdAt: string;
  /** Plain-text description, trimmed by the provider. */
  body: string;
  comments: number;
  labels: Label[];
  /** Pull requests only. */
  pr: {
    baseRef: string;
    headRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    /** The first checks only; `checksTotal` counts them all. */
    checks: CheckItem[];
    checksTotal: number;
    reviewers: { login: string; state: ReviewerState }[];
  } | null;
  /** Issues only. */
  assignees: string[];
  /** The provider left out some fields (e.g. checks the token cannot read). */
  incomplete: boolean;
}

export interface Counted<T> {
  total: number;
  items: T[];
}

export interface RepoSnapshot {
  fullName: string;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  /** CI on the head of the default branch; `null` when the widget is off. */
  ci: CiState | null;
  pullRequests: Counted<PullRequestItem> | null;
  /** Open PRs needing attention among all fetched, not just those displayed. */
  prsNeedingAttention: number;
  issues: Counted<IssueItem> | null;
}

export type RepoErrorKind =
  | 'not_found'
  | 'sso_required'
  | 'token_policy'
  | 'forbidden'
  | 'rate_limited'
  | 'not_connected'
  | 'unknown';

/** Why a repository could not be loaded. */
export interface RepoError {
  kind: RepoErrorKind;
  /** Short explanation written by us; never raw API text. */
  message: string;
  /** Provider page where the user can fix the problem. */
  help?: { url: string; label: string };
}

export type RepoResult = { ok: true; data: RepoSnapshot } | { ok: false; error: RepoError };

/** Things across all repositories that need the viewer's attention. */
export interface InboxSnapshot {
  viewer: string;
  reviewRequests: Counted<PullRequestItem>;
  myPullRequests: Counted<PullRequestItem>;
  assigned: Counted<IssueItem>;
  /** Some results were withheld because an organization requires SSO the token is not authorized for. */
  ssoRestricted: boolean;
  /** A token's results are missing (its request failed), so lists may lack items. */
  incomplete?: boolean;
}

export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface RepoBatch {
  repos: Map<string, RepoResult>;
  rateLimit: RateLimit | null;
}

export interface RepoSuggestions {
  /** `owner/name`, most recently pushed first. */
  repos: string[];
  /** False when some token's request failed, so a retry may find more. */
  complete: boolean;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /**
   * Whether this provider uses per-owner tokens next to the default one
   * (fine-grained GitHub tokens cover a single account or organization).
   */
  ownerTokens: boolean;
  /**
   * Where users create an access token for this provider, prefilled where the
   * provider allows it. With `target`, the token is for that account or
   * organization (GitHub) or on that instance (GitLab).
   */
  newTokenUrl(target?: string | null): string;
  /** Permissions a token needs, as the provider labels them. */
  tokenPermissions: readonly string[];
  /**
   * `tokenOwners` are the owners (lowercase logins) that have their own
   * access token; everything else is fetched with the default token.
   */
  fetchRepos(repos: PinnedRepo[], tokenOwners: readonly string[]): Promise<RepoBatch>;
  fetchInbox(config: InboxConfig, tokenOwners: readonly string[]): Promise<InboxSnapshot>;
  /**
   * Repositories (`owner/name`) the stored tokens can see, offered as
   * suggestions when pinning. Best-effort: tokens that fail are skipped and
   * `complete` is false; it rejects only when every token fails.
   */
  listRepos(tokenOwners: readonly string[]): Promise<RepoSuggestions>;
  /** Details of one pull request or issue, by its web URL. */
  fetchDetails(url: string, tokenOwners: readonly string[]): Promise<ItemDetails>;
}
