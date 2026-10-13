/**
 * Helpers for spreading requests over several access tokens: a default token
 * plus optional per-owner tokens (fine-grained GitHub tokens only cover one
 * account or organization).
 */

import type { PinnedRepo } from '../config/schema';
import type { Counted, InboxSnapshot } from './types';

export interface TokenGroup {
  /** Owner whose token serves these repos, or `null` for the default token. */
  owner: string | null;
  repos: PinnedRepo[];
}

/**
 * Groups repos by the token that serves them, keeping each group in pinned
 * order. The default-token group comes first; owner groups follow in the
 * order their first repo is pinned. Owners are matched case-insensitively.
 */
export function groupByToken(repos: readonly PinnedRepo[], tokenOwners: readonly string[]): TokenGroup[] {
  const owners = new Set(tokenOwners.map((o) => o.toLowerCase()));
  const defaults: PinnedRepo[] = [];
  const byOwner = new Map<string, PinnedRepo[]>();
  for (const repo of repos) {
    const owner = repo.owner.toLowerCase();
    if (owners.has(owner)) {
      const group = byOwner.get(owner);
      if (group) group.push(repo);
      else byOwner.set(owner, [repo]);
    } else {
      defaults.push(repo);
    }
  }
  const groups: TokenGroup[] = defaults.length > 0 ? [{ owner: null, repos: defaults }] : [];
  for (const [owner, group] of byOwner) groups.push({ owner, repos: group });
  return groups;
}

function mergeCounted<T extends { url: string; updatedAt: string }>(lists: Counted<T>[], limit: number): Counted<T> {
  const seen = new Map<string, T>();
  let total = 0;
  let duplicates = 0;
  for (const list of lists) {
    total += list.total;
    for (const item of list.items) {
      if (seen.has(item.url)) duplicates++;
      else seen.set(item.url, item);
    }
  }
  const items = [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  // Duplicates beyond the fetched page cannot be seen, so with overlapping
  // tokens the total can overcount; it is exact when the tokens are disjoint.
  return { total: Math.max(total - duplicates, seen.size), items };
}

/**
 * Merges inbox results fetched with several tokens, de-duplicated by URL and
 * newest first. Snapshots for a different viewer than `primary` (a token
 * belonging to another account) are ignored, since "@me" meant someone else.
 */
export function mergeInbox(primary: InboxSnapshot, others: readonly InboxSnapshot[], limit: number): InboxSnapshot {
  const viewer = primary.viewer.toLowerCase();
  const all = [primary, ...others.filter((s) => s.viewer.toLowerCase() === viewer)];
  if (all.length === 1) return primary;
  return {
    viewer: primary.viewer,
    reviewRequests: mergeCounted(all.map((s) => s.reviewRequests), limit),
    myPullRequests: mergeCounted(all.map((s) => s.myPullRequests), limit),
    assigned: mergeCounted(all.map((s) => s.assigned), limit),
    // A SAML error can't be tied to the org it came from, so keep the notice
    // if any token reported one rather than risk hiding missing results.
    ssoRestricted: all.some((s) => s.ssoRestricted),
  };
}

const NO_INBOX: InboxSnapshot = {
  viewer: '',
  reviewRequests: { total: 0, items: [] },
  myPullRequests: { total: 0, items: [] },
  assigned: { total: 0, items: [] },
  ssoRestricted: false,
};

function combineCounted<T extends { updatedAt: string }>(lists: Counted<T>[], limit: number): Counted<T> {
  const items = lists
    .flatMap((l) => l.items)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  return { total: lists.reduce((sum, l) => sum + l.total, 0), items };
}

/**
 * Combines the inboxes of different providers (GitHub and GitLab) into one,
 * newest first. Unlike `mergeInbox`, nothing overlaps, so totals add up. The
 * first snapshot's viewer is kept.
 */
export function combineInboxes(snapshots: readonly InboxSnapshot[], limit: number): InboxSnapshot {
  if (snapshots.length <= 1) return snapshots[0] ?? NO_INBOX;
  return {
    viewer: snapshots[0]!.viewer,
    reviewRequests: combineCounted(snapshots.map((s) => s.reviewRequests), limit),
    myPullRequests: combineCounted(snapshots.map((s) => s.myPullRequests), limit),
    assigned: combineCounted(snapshots.map((s) => s.assigned), limit),
    ssoRestricted: snapshots.some((s) => s.ssoRestricted),
  };
}
