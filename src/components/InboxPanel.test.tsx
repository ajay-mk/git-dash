import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, type LayoutConfig } from '../config/schema';
import type { InboxSnapshot, ItemDetails } from '../providers/types';
import { issue, pr } from '../test/fixtures';
import { groupPullRequests, InboxPanel } from './InboxPanel';

function snapshotInbox(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    viewer: 'octocat',
    reviewRequests: { total: 0, items: [] },
    myPullRequests: {
      total: 3,
      items: [
        pr({ number: 1, title: 'Zeta ready', url: 'https://github.com/o/zeta/pull/1', repo: 'o/zeta' }),
        pr({ number: 2, title: 'Alpha draft', url: 'https://github.com/o/alpha/pull/2', repo: 'o/alpha', isDraft: true }),
        pr({ number: 3, title: 'Alpha ready', url: 'https://github.com/o/alpha/pull/3', repo: 'o/alpha' }),
      ],
    },
    assigned: { total: 1, items: [issue({ title: 'Assigned issue', repo: 'o/alpha' })] },
    ssoRestricted: false,
    ...overrides,
  };
}

const noDetails = () => new Promise<ItemDetails>(() => undefined);

function Harness({ initial, loadDetails = noDetails }: { initial?: Partial<LayoutConfig>; loadDetails?: (url: string) => Promise<ItemDetails> }) {
  const [layout, setLayout] = useState<LayoutConfig>({ ...defaultConfig().layout, ...initial });
  return (
    <>
      <InboxPanel
        config={defaultConfig().inbox}
        layout={layout}
        onLayoutChange={setLayout}
        inbox={snapshotInbox()}
        error={null}
        loadDetails={loadDetails}
      />
      <output data-testid="view">{JSON.stringify(layout)}</output>
    </>
  );
}

const view = () => JSON.parse(screen.getByTestId('view').textContent ?? '{}') as LayoutConfig;

describe('groupPullRequests', () => {
  const items = snapshotInbox().myPullRequests.items;

  it('returns null without grouping', () => {
    expect(groupPullRequests(items, 'none')).toBeNull();
  });

  it('groups by repository in name order, keeping item order', () => {
    const groups = groupPullRequests(items, 'repo')!;
    expect(groups.map((g) => g.title)).toEqual(['o/alpha', 'o/zeta']);
    expect(groups[0]!.items.map((p) => p.number)).toEqual([2, 3]);
  });

  it('groups by status with ready first and skips empty groups', () => {
    expect(groupPullRequests(items, 'status')!.map((g) => [g.title, g.items.length])).toEqual([
      ['Ready', 2],
      ['Draft', 1],
    ]);
    expect(groupPullRequests(items.filter((p) => !p.isDraft), 'status')!.map((g) => g.title)).toEqual(['Ready']);
  });
});

describe('InboxPanel', () => {
  it('collapses and expands a section', async () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /Assigned to you/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Assigned issue')).toBeTruthy();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Assigned issue')).toBeNull();
    expect(view().collapsedInbox).toEqual(['assigned']);

    await userEvent.click(toggle);
    expect(screen.getByText('Assigned issue')).toBeTruthy();
    expect(view().collapsedInbox).toEqual([]);
  });

  it('keeps the count visible while collapsed', () => {
    render(<Harness initial={{ collapsedInbox: ['myPullRequests'] }} />);
    const toggle = screen.getByRole('button', { name: /Your pull requests/ });
    expect(within(toggle).getByText('3')).toBeTruthy();
    expect(screen.queryByText('Zeta ready')).toBeNull();
  });

  it.each([
    ['repo', ['o/alpha 2', 'o/zeta 1']],
    ['status', ['Ready 2', 'Draft 1']],
    ['none', []],
  ] as const)('groups your pull requests: %s', (groupMyPullRequests, headings) => {
    render(<Harness initial={{ groupMyPullRequests }} />);
    expect(screen.queryAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(headings);
  });
});

describe('item details', () => {
  const details: ItemDetails = {
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    body: 'Adds the zeta feature.',
    comments: 2,
    labels: [{ name: 'feature', color: '00ff00' }],
    assignees: [],
    incomplete: false,
    pr: {
      baseRef: 'main',
      headRef: 'feat/zeta',
      additions: 10,
      deletions: 4,
      changedFiles: 3,
      checks: [
        { name: 'lint', state: 'failure', url: 'https://github.com/o/zeta/actions/runs/1' },
        { name: 'test', state: 'success', url: null },
      ],
      checksTotal: 2,
      reviewers: [{ login: 'alice', state: 'approved' }, { login: 'bob', state: 'requested' }],
    },
  };

  it('opens a card on click instead of the link, then links to GitHub', async () => {
    const load = vi.fn(() => Promise.resolve(details));
    render(<Harness loadDetails={load} />);
    const row = screen.getByRole('button', { name: /Zeta ready/ });
    await userEvent.click(row);
    expect(load).toHaveBeenCalledWith('https://github.com/o/zeta/pull/1');
    expect(row.getAttribute('aria-expanded')).toBe('true');

    const card = await screen.findByRole('dialog', { name: 'Zeta ready' });
    expect(await within(card).findByText('1 failing, 1 passing', { exact: false })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'lint' }).getAttribute('href')).toBe('https://github.com/o/zeta/actions/runs/1');
    expect(within(card).getByText('alice')).toBeTruthy();
    expect(within(card).getByText('feat/zeta')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toBe('https://github.com/o/zeta/pull/1');
    expect(within(card).getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('https://github.com/o/zeta/pull/1/files');
  });

  it('closes on Escape, a click outside, or a second click on the row', async () => {
    render(<Harness loadDetails={() => Promise.resolve(details)} />);
    const row = screen.getByRole('button', { name: /Zeta ready/ });

    await userEvent.click(row);
    const card = await screen.findByRole('dialog');
    // Focus moves into the card so its links are reachable by keyboard.
    expect(card.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(row);

    await userEvent.click(row);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('heading', { name: 'Needs you' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(row);
    await screen.findByRole('dialog');
    await userEvent.click(row);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows issue details and load errors', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ...details, pr: null, assignees: ['octocat'] })
      .mockRejectedValueOnce(new Error('Could not load details from GitHub.'));
    render(<Harness loadDetails={load} />);
    const row = screen.getByRole('button', { name: /Assigned issue/ });

    await userEvent.click(row);
    const card = await screen.findByRole('dialog');
    expect(await within(card).findByText('Assigned to octocat')).toBeTruthy();
    expect(within(card).queryByRole('link', { name: 'Files' })).toBeNull();

    await userEvent.click(row);
    await userEvent.click(row);
    expect(await screen.findByText('Could not load details from GitHub.')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'Open on GitHub' })).toBeTruthy();
  });

  it('counts only successful checks as passing and notes missing details', async () => {
    const stale = { ...details, incomplete: true, pr: { ...details.pr!, checks: [{ name: 'old', state: 'none' as const, url: null }], checksTotal: 1 } };
    render(<Harness loadDetails={() => Promise.resolve(stale)} />);
    await userEvent.click(screen.getByRole('button', { name: /Zeta ready/ }));
    const card = await screen.findByRole('dialog');
    expect(await within(card).findByText('0 of 1 passing', { exact: false })).toBeTruthy();
    expect(within(card).getByText('Some details could not be loaded.')).toBeTruthy();
  });

  it('never calls a partial list of checks all passing', async () => {
    const many = { ...details, pr: { ...details.pr!, checks: [{ name: 'test', state: 'success' as const, url: null }], checksTotal: 60 } };
    render(<Harness loadDetails={() => Promise.resolve(many)} />);
    await userEvent.click(screen.getByRole('button', { name: /Zeta ready/ }));
    const card = await screen.findByRole('dialog');
    expect(await within(card).findByText('1 of 60 passing, 59 more not shown', { exact: false })).toBeTruthy();
  });

  it('closes when keyboard focus moves to another row', async () => {
    render(<Harness loadDetails={() => Promise.resolve(details)} />);
    await userEvent.click(screen.getByRole('button', { name: /Zeta ready/ }));
    await screen.findByRole('dialog');
    screen.getByRole('button', { name: /Alpha ready/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Alpha ready');
  });

  it('treats an assigned pull request as a pull request', async () => {
    const inbox = snapshotInbox({
      assigned: { total: 1, items: [issue({ title: 'Assigned PR', url: 'https://github.com/o/alpha/pull/9', isPullRequest: true })] },
    });
    render(
      <InboxPanel
        config={defaultConfig().inbox}
        layout={defaultConfig().layout}
        onLayoutChange={() => undefined}
        inbox={inbox}
        error={null}
        loadDetails={() => Promise.resolve(details)}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Assigned PR/ }));
    const card = await screen.findByRole('dialog');
    expect(within(card).getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('https://github.com/o/alpha/pull/9/files');
  });
});
