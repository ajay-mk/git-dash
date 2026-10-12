import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { defaultConfig, type LayoutConfig } from '../config/schema';
import type { InboxSnapshot } from '../providers/types';
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

function Harness({ initial }: { initial?: Partial<LayoutConfig> }) {
  const [layout, setLayout] = useState<LayoutConfig>({ ...defaultConfig().layout, ...initial });
  return (
    <>
      <InboxPanel config={defaultConfig().inbox} layout={layout} onLayoutChange={setLayout} inbox={snapshotInbox()} error={null} />
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
