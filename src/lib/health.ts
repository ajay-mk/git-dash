import type { PullRequestItem, RepoResult } from '../providers/types';

/**
 * One-word summary of a repository, used for the coloured status stripe.
 * Ordered from most to least severe.
 */
export type Health = 'error' | 'failing' | 'attention' | 'pending' | 'ok';

export const HEALTH_LABELS: Record<Health, string> = {
  error: 'Could not load',
  failing: 'CI failing on default branch',
  attention: 'Pull requests need attention',
  pending: 'CI running',
  ok: 'All good',
};

export function prNeedsAttention(pr: PullRequestItem): boolean {
  return !pr.isDraft && (pr.ci === 'failure' || pr.review === 'changes_requested');
}

export function repoHealth(result: RepoResult | undefined): Health | null {
  if (!result) return null;
  if (!result.ok) return 'error';
  const { ci, pullRequests } = result.data;
  if (ci === 'failure') return 'failing';
  if (pullRequests?.items.some(prNeedsAttention)) return 'attention';
  if (ci === 'pending') return 'pending';
  return 'ok';
}

/**
 * Your own PRs that you should act on: failing, conflicting, changes
 * requested, or ready to merge. Branch protection rules beyond reviews and CI
 * are not visible here, so "merge" can still be blocked by them.
 */
export function myPrAction(pr: PullRequestItem): 'fix' | 'merge' | null {
  if (pr.isDraft) return null;
  if (pr.ci === 'failure' || pr.review === 'changes_requested' || pr.mergeable === false) return 'fix';
  if (pr.review === 'approved' && pr.ci !== 'pending' && pr.mergeable === true) return 'merge';
  return null;
}
