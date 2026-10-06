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

/** Your own PRs that you should act on: failing, changes requested, or ready to merge. */
export function myPrAction(pr: PullRequestItem): 'fix' | 'merge' | null {
  if (pr.isDraft) return null;
  if (pr.ci === 'failure' || pr.review === 'changes_requested') return 'fix';
  if (pr.review === 'approved' && pr.ci !== 'pending') return 'merge';
  return null;
}
