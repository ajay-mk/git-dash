import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxSnapshot } from '../providers/types';
import { issue, pr } from '../test/fixtures';
import { inboxAlerts, inboxBaseline, MAX_ALERTS, SeenItems } from './notify';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve('denied')),
  sendNotification: vi.fn(),
}));

const NOW = Date.parse('2026-10-13T12:00:00Z');
const FRESH = '2026-10-13T11:59:00Z';
const OLD = '2026-10-01T00:00:00Z';
const SINCE = NOW - 5 * 60_000;

function inbox(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  const empty = { total: 0, items: [] };
  return {
    viewer: 'octocat',
    reviewRequests: empty,
    myPullRequests: empty,
    assigned: empty,
    ssoRestricted: false,
    ...overrides,
  };
}

function counted<T>(...items: T[]) {
  return { total: items.length, items };
}

describe('inboxAlerts', () => {
  it('reports new review requests and assignments', () => {
    const review = pr({ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r', updatedAt: FRESH });
    const assigned = issue({ url: 'https://github.com/o/r/issues/8', number: 8, repo: 'o/r', updatedAt: FRESH });
    const alerts = inboxAlerts(
      inbox(),
      inbox({ reviewRequests: counted(review), assigned: counted(assigned) }),
      SINCE,
    );
    expect(alerts).toEqual([
      { title: 'Review requested', body: 'o/r#7 Add feature' },
      { title: 'Issue assigned to you', body: 'o/r#8 Fix bug' },
    ]);
  });

  it('ignores items already shown and older items moving into view', () => {
    const shown = pr({ url: 'https://github.com/o/r/pull/1', updatedAt: FRESH });
    const older = pr({ url: 'https://github.com/o/r/pull/2', updatedAt: OLD });
    const prev = inbox({ reviewRequests: counted(shown) });
    expect(inboxAlerts(prev, inbox({ reviewRequests: counted(shown, older) }), SINCE)).toEqual([]);
  });

  it('reports your pull requests that start failing, get changes requested or can be merged', () => {
    const url = (n: number) => `https://github.com/o/r/pull/${n}`;
    const prev = inbox({
      myPullRequests: counted(
        pr({ url: url(1), number: 1 }),
        pr({ url: url(2), number: 2 }),
        pr({ url: url(3), number: 3, review: 'review_required' }),
        pr({ url: url(4), number: 4, ci: 'failure' }),
      ),
    });
    const next = inbox({
      myPullRequests: counted(
        pr({ url: url(1), number: 1, ci: 'failure' }),
        pr({ url: url(2), number: 2, review: 'changes_requested' }),
        pr({ url: url(3), number: 3, review: 'approved' }),
        pr({ url: url(4), number: 4, ci: 'failure' }),
        pr({ url: url(5), number: 5, ci: 'failure' }),
      ),
    });
    expect(inboxAlerts(prev, next, SINCE).map((a) => a.title)).toEqual([
      'CI failing',
      'Changes requested',
      'Ready to merge',
    ]);
  });

  it('ignores drafts', () => {
    const draft = pr({ isDraft: true });
    expect(
      inboxAlerts(inbox({ myPullRequests: counted(draft) }), inbox({ myPullRequests: counted({ ...draft, ci: 'failure' }) }), SINCE),
    ).toEqual([]);
  });

  it('does not repeat items that dropped out of the list and came back', () => {
    const a = pr({ url: 'https://github.com/o/r/pull/1', updatedAt: FRESH });
    const b = pr({ url: 'https://github.com/o/r/pull/2', updatedAt: FRESH });
    const seen = new SeenItems();
    const withA = inbox({ reviewRequests: counted(a) });
    // A list of one out of two: A dropped out but did not go away.
    const withB = inbox({ reviewRequests: { total: 2, items: [b] } });
    seen.remember(withA);
    seen.remember(withB);
    expect(inboxAlerts(withB, withA, SINCE, seen)).toEqual([]);
    // Without the history, A would look new again.
    expect(inboxAlerts(withB, withA, SINCE)).toHaveLength(1);
  });

  it('notifies again when a review is re-requested after it was done', () => {
    const a = pr({ url: 'https://github.com/o/r/pull/1', updatedAt: FRESH });
    const seen = new SeenItems();
    const requested = inbox({ reviewRequests: counted(a) });
    const reviewed = inbox();
    seen.remember(requested);
    // The list is complete, so A really left it.
    seen.remember(reviewed);
    expect(inboxAlerts(reviewed, requested, SINCE, seen)).toEqual([
      { title: 'Review requested', body: '#1 Add feature' },
    ]);
  });

  it('keeps items while a token\'s results are missing', () => {
    const a = pr({ url: 'https://github.com/o/r/pull/1', updatedAt: FRESH });
    const seen = new SeenItems();
    const withA = inbox({ reviewRequests: counted(a) });
    // A came from a per-owner token whose request failed this time.
    const partial = inbox({ incomplete: true });
    seen.remember(withA);
    seen.remember(partial);
    expect(inboxAlerts(partial, withA, SINCE, seen)).toEqual([]);
  });

  it('goes by when the request or assignment happened, not the last update', () => {
    // Old requests brought into view by a new comment.
    const review = pr({ url: 'https://github.com/o/r/pull/1', updatedAt: FRESH, requestedAt: OLD });
    const assigned = issue({ url: 'https://github.com/o/r/issues/2', updatedAt: FRESH, assignedAt: OLD });
    const next = inbox({ reviewRequests: { total: 9, items: [review] }, assigned: { total: 9, items: [assigned] } });
    expect(inboxAlerts(inbox(), next, SINCE)).toEqual([]);
    const fresh = inbox({
      reviewRequests: counted({ ...review, requestedAt: FRESH }),
      assigned: counted({ ...assigned, assignedAt: FRESH }),
    });
    expect(inboxAlerts(inbox(), fresh, SINCE).map((a) => a.title)).toEqual(['Review requested', 'Issue assigned to you']);
  });

  it('reports a pull request that fails CI and gets changes requested at once', () => {
    const before = pr();
    const after = pr({ ci: 'failure', review: 'changes_requested' });
    const alerts = inboxAlerts(inbox({ myPullRequests: counted(before) }), inbox({ myPullRequests: counted(after) }), SINCE);
    expect(alerts.map((a) => a.title)).toEqual(['CI failing', 'Changes requested']);
  });

  it('forgets the oldest items past its limit', () => {
    const seen = new SeenItems(2);
    const item = (n: number) => pr({ url: `https://github.com/o/r/pull/${n}` });
    seen.remember(inbox({ reviewRequests: counted(item(1), item(2), item(3)) }));
    expect(seen.has('review https://github.com/o/r/pull/1')).toBe(false);
    expect(seen.has('review https://github.com/o/r/pull/3')).toBe(true);
  });

  it('says nothing when the account changed', () => {
    const next = inbox({ viewer: 'someone-else', reviewRequests: counted(pr({ updatedAt: FRESH })) });
    expect(inboxAlerts(inbox(), next, SINCE)).toEqual([]);
  });

  it('sums up many alerts in one', () => {
    const items = Array.from({ length: MAX_ALERTS + 1 }, (_, i) =>
      pr({ url: `https://github.com/o/r/pull/${i}`, number: i, updatedAt: FRESH }),
    );
    expect(inboxAlerts(inbox(), inbox({ reviewRequests: counted(...items) }), SINCE)).toEqual([
      { title: `${MAX_ALERTS + 1} new items need you`, body: 'Open GitDash to see them.' },
    ]);
  });
});

describe('inboxBaseline', () => {
  const a = pr({ url: 'https://github.com/o/r/pull/1' });
  const b = pr({ url: 'https://github.com/corp/x/pull/2' });

  it('keeps your pull requests a failed token did not return', () => {
    const prev = inbox({ myPullRequests: counted(a, b) });
    const partial = inbox({ myPullRequests: counted(a), incomplete: true });
    expect(inboxBaseline(prev, partial).myPullRequests.items).toEqual([a, b]);
    // Once the token works again, B's change since the last full fetch shows.
    const failing = { ...b, ci: 'failure' as const };
    const recovered = inbox({ myPullRequests: counted(a, failing) });
    expect(inboxAlerts(inboxBaseline(prev, partial), recovered, SINCE).map((x) => x.title)).toEqual(['CI failing']);
  });

  it('takes a complete fetch as it is', () => {
    const next = inbox({ myPullRequests: counted(a) });
    expect(inboxBaseline(inbox({ myPullRequests: counted(a, b) }), next)).toBe(next);
  });
});

describe('showAlerts', () => {
  // The module asks for permission once per launch, so each test loads it
  // fresh, with the plugin mocks back at their defaults.
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });
  const load = async () => ({ ...(await import('./notify')), plugin: await import('@tauri-apps/plugin-notification') });
  const alert = { title: 'Review requested', body: 'o/r#1 Add feature' };

  it('shows alerts when notifications are allowed', async () => {
    const { showAlerts, plugin } = await load();
    vi.mocked(plugin.isPermissionGranted).mockResolvedValue(true);
    await showAlerts([alert]);
    expect(plugin.sendNotification).toHaveBeenCalledWith(alert);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it('asks once, and shows nothing when refused', async () => {
    const { showAlerts, plugin } = await load();
    await showAlerts([alert]);
    await showAlerts([alert]);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it('shows alerts once permission is given', async () => {
    const { showAlerts, plugin } = await load();
    vi.mocked(plugin.requestPermission).mockResolvedValue('granted');
    await showAlerts([alert]);
    expect(plugin.sendNotification).toHaveBeenCalledWith(alert);
  });
});
