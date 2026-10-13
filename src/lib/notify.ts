import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { Counted, InboxSnapshot, IssueItem, PullRequestItem } from '../providers/types';
import { myPrAction } from './health';

/** One desktop notification. */
export interface Alert {
  title: string;
  body: string;
}

/** Above this many alerts at once, a single summary is shown instead. */
export const MAX_ALERTS = 3;

/**
 * Lists only show the newest entries, so an older item can move into view
 * when another leaves. Only items changed since the previous fetch (with some
 * slack for clock differences) count as new.
 */
const CLOCK_SLACK_MS = 5 * 60_000;

function label(item: PullRequestItem | IssueItem): string {
  return `${item.repo ? `${item.repo}#${item.number}` : `#${item.number}`} ${item.title}`;
}

/**
 * Review requests and assignments already seen this session. Lists only hold
 * the newest entries, so an item can drop out for a refresh and come back;
 * remembering it keeps that from notifying twice. An item missing from a list
 * that shows everything has really gone (reviewed, unassigned), so it is
 * forgotten and a later re-request notifies again.
 */
export class SeenItems {
  private readonly keys = new Set<string>();

  constructor(private readonly max = 1000) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Remembers the review requests and assignments in `snapshot`. */
  remember(snapshot: InboxSnapshot): void {
    for (const [prefix, section] of sections(snapshot)) {
      const present = new Set(section.items.map((item) => `${prefix}${item.url}`));
      if (section.items.length >= section.total) {
        for (const key of this.keys) {
          if (key.startsWith(prefix) && !present.has(key)) this.keys.delete(key);
        }
      }
      for (const key of present) {
        this.keys.delete(key);
        this.keys.add(key);
      }
    }
    // Sets keep insertion order, so the oldest entries go first.
    for (const key of this.keys) {
      if (this.keys.size <= this.max) break;
      this.keys.delete(key);
    }
  }
}

function sections(snapshot: InboxSnapshot): [string, Counted<{ url: string }>][] {
  return [
    ['review ', snapshot.reviewRequests],
    ['assigned ', snapshot.assigned],
  ];
}

/**
 * What changed in "Needs you" between two snapshots fetched with the same
 * settings: new review requests and assignments, and your own pull requests
 * that started failing, got changes requested or became ready to merge.
 * `since` is when `prev` was fetched; items in `seen` are not new.
 */
export function inboxAlerts(
  prev: InboxSnapshot,
  next: InboxSnapshot,
  since: number,
  seen: Pick<SeenItems, 'has'> = new SeenItems(),
): Alert[] {
  // A different account: everything would look new.
  if (prev.viewer !== next.viewer) return [];
  const recent = (item: { updatedAt: string }) => Date.parse(item.updatedAt) >= since - CLOCK_SLACK_MS;
  const alerts: Alert[] = [];

  const seenReviews = new Set(prev.reviewRequests.items.map((pr) => pr.url));
  for (const pr of next.reviewRequests.items) {
    if (!seenReviews.has(pr.url) && !seen.has(`review ${pr.url}`) && recent(pr)) {
      alerts.push({ title: 'Review requested', body: label(pr) });
    }
  }

  const seenAssigned = new Set(prev.assigned.items.map((item) => item.url));
  for (const item of next.assigned.items) {
    if (!seenAssigned.has(item.url) && !seen.has(`assigned ${item.url}`) && recent(item)) {
      alerts.push({ title: item.isPullRequest ? 'Pull request assigned to you' : 'Issue assigned to you', body: label(item) });
    }
  }

  const before = new Map(prev.myPullRequests.items.map((pr) => [pr.url, pr]));
  for (const pr of next.myPullRequests.items) {
    const old = before.get(pr.url);
    if (!old || pr.isDraft) continue;
    // Each change is reported, since the next fetch compares with this one.
    if (pr.ci === 'failure' && old.ci !== 'failure') {
      alerts.push({ title: 'CI failing', body: label(pr) });
    }
    if (pr.review === 'changes_requested' && old.review !== 'changes_requested') {
      alerts.push({ title: 'Changes requested', body: label(pr) });
    }
    if (myPrAction(pr) === 'merge' && myPrAction(old) !== 'merge') {
      alerts.push({ title: 'Ready to merge', body: label(pr) });
    }
  }

  if (alerts.length > MAX_ALERTS) {
    return [{ title: `${alerts.length} new items need you`, body: 'Open GitDash to see them.' }];
  }
  return alerts;
}

let asked = false;

/**
 * Whether the app may show notifications, asking the OS once per launch if
 * the user has not decided yet.
 */
export async function canNotify(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (asked) return false;
  asked = true;
  return (await requestPermission()) === 'granted';
}

/** Shows `alerts` as desktop notifications if the OS allows it. */
export async function showAlerts(alerts: readonly Alert[]): Promise<void> {
  if (alerts.length === 0 || !(await canNotify())) return;
  for (const alert of alerts) sendNotification(alert);
}
