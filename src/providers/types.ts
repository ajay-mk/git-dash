/**
 * Provider-agnostic data model.
 *
 * Every service (GitHub today; GitLab, Gitea, ... later) maps its API responses
 * into these shapes, so widgets never depend on a specific provider's API.
 */

import type { InboxConfig, PinnedRepo } from '../config/schema';

export type ProviderId = 'github';

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
  /** Whether it merges cleanly; `null` while GitHub is still computing it. */
  mergeable: boolean | null;
  /** Repository name; set for cross-repo lists such as the inbox. */
  repo?: string;
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

export interface Provider {
  id: ProviderId;
  label: string;
  /** Where users create an access token for this provider. */
  tokenHelpUrl: string;
  /**
   * `tokenOwners` are the owners (lowercase logins) that have their own
   * access token; everything else is fetched with the default token.
   */
  fetchRepos(repos: PinnedRepo[], tokenOwners: readonly string[]): Promise<RepoBatch>;
  fetchInbox(config: InboxConfig, tokenOwners: readonly string[]): Promise<InboxSnapshot>;
}
