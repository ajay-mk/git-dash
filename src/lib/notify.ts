import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { Counted, InboxSnapshot, IssueItem, PullRequestItem } from '../providers/types';
import { myPrAction } from './health';
import { refSigil } from './url';

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
  const ref = `${refSigil(item.url, !('isPullRequest' in item) || item.isPullRequest)}${item.number}`;
  return `${item.repo ?? ''}${ref} ${item.title}`;
}

/**
 * A review request or assignment: the item and when the request was made, so
 * a re-request of the same pull request is a new one.
 */
function requestKey(prefix: string, item: PullRequestItem | IssueItem): string {
  return `${prefix}${item.url} ${requestTime(item) ?? ''}`;
}

function requestTime(item: PullRequestItem | IssueItem): string | undefined {
  return 'isPullRequest' in item ? item.assignedAt : item.requestedAt;
}

/**
 * Review requests and assignments already seen this session. Lists only hold
 * the newest entries, so an item can drop out for a refresh and come back;
 * remembering it keeps that from notifying twice. A request missing from a
 * list that shows everything has really gone (reviewed, unassigned), so it is
 * forgotten. Items with fields lost to an error are left as they were.
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
      const loaded = section.items.filter((item) => !item.partial);
      const present = new Set(loaded.map((item) => requestKey(prefix, item)));
      const unsure = section.items.filter((item) => item.partial).map((item) => `${prefix}${item.url} `);
      // With a token's results missing, absent items may only be hidden.
      if (!snapshot.incomplete && section.items.length >= section.total) {
        for (const key of this.keys) {
          if (key.startsWith(prefix) && !present.has(key) && !unsure.some((u) => key.startsWith(u))) {
            this.keys.delete(key);
          }
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

function sections(snapshot: InboxSnapshot): [string, Counted<PullRequestItem | IssueItem>][] {
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
  // An old request can move into view because of an unrelated update (a
  // comment, a push), so the request's own time counts when it is known.
  const recent = (at: string) => Date.parse(at) >= since - CLOCK_SLACK_MS;
  const alerts: Alert[] = [];

  for (const [prefix, section] of sections(next)) {
    const before = new Set(
      sections(prev)
        .find(([p]) => p === prefix)![1]
        .items.filter((item) => !item.partial)
        .map((item) => requestKey(prefix, item)),
    );
    for (const item of section.items) {
      // Without its request time, an item waits until it loads.
      if (item.partial) continue;
      const key = requestKey(prefix, item);
      const at = requestTime(item) ?? item.updatedAt;
      if (before.has(key) || seen.has(key) || !recent(at)) continue;
      const title =
        prefix === 'review '
          ? 'Review requested'
          : 'isPullRequest' in item && item.isPullRequest
            ? 'Pull request assigned to you'
            : 'Issue assigned to you';
      alerts.push({ title, body: label(item) });
    }
  }

  const before = new Map(prev.myPullRequests.items.map((pr) => [pr.url, pr]));
  for (const pr of next.myPullRequests.items) {
    const old = before.get(pr.url);
    // A pull request with fields lost to an error, on either side, is
    // compared once both have loaded.
    if (!old || pr.isDraft || pr.partial || old.partial) continue;
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
    return [{ title: `${alerts.length} new items need you`, body: 'Open IsItGreen to see them.' }];
  }
  return alerts;
}

/**
 * What the next fetch is compared with. Your pull requests whose fields
 * failed to load keep their previous state, and when a token's results are
 * missing, so do the ones only it found; changes to them are noticed once
 * they load again.
 */
export function inboxBaseline(prev: InboxSnapshot | undefined, next: InboxSnapshot): InboxSnapshot {
  const items = next.myPullRequests.items;
  if (!prev || (!next.incomplete && !items.some((pr) => pr.partial))) return next;
  const before = new Map(prev.myPullRequests.items.map((pr) => [pr.url, pr]));
  const kept = items.map((pr) => (pr.partial ? (before.get(pr.url) ?? pr) : pr));
  const present = new Set(items.map((pr) => pr.url));
  const missing = next.incomplete ? prev.myPullRequests.items.filter((pr) => !present.has(pr.url)) : [];
  return { ...next, myPullRequests: { ...next.myPullRequests, items: [...kept, ...missing] } };
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
