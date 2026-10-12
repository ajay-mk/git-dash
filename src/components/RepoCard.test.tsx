import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { WidgetType } from '../config/schema';
import type { RepoResult } from '../providers/types';
import { issue, pinned, pr, SCRIPT_URL, snapshot } from '../test/fixtures';
import { RepoCard } from './RepoCard';

const noLayout = { collapsedWidgets: [], onToggleWidget: () => {} };

const ok = (data = snapshot()): RepoResult => ({ ok: true, data });

function card() {
  return screen.getByRole('article');
}

describe('RepoCard', () => {
  it.each<[string, RepoResult | undefined]>([
    ['loading', undefined],
    ['error', { ok: false, error: { kind: 'not_found', message: 'Repository not found.' } }],
    ['failing', ok(snapshot({ ci: 'failure' }))],
    ['attention', ok(snapshot({ pullRequests: { total: 1, items: [pr({ review: 'changes_requested' })] }, prsNeedingAttention: 1 }))],
    ['pending', ok(snapshot({ ci: 'pending' }))],
    ['ok', ok()],
  ])('uses the %s health stripe', (state, result) => {
    render(<RepoCard {...noLayout} repo={pinned()} result={result} />);
    expect(card().classList.contains(`health-${state}`)).toBe(true);
  });

  it('shows the error message on an error card', () => {
    render(<RepoCard {...noLayout} repo={pinned()} result={{ ok: false, error: { kind: 'not_found', message: 'Repository not found.' } }} />);
    expect(within(card()).getByText('Repository not found.')).toBeTruthy();
    expect(card().getAttribute('aria-label')).toBe('octo/repo: Could not load');
    expect(screen.queryByText('Pull requests')).toBeNull();
  });

  it('renders enabled widgets and hides disabled ones', () => {
    const data = snapshot({
      pullRequests: { total: 3, items: [pr({ title: 'A pull request' })] },
      issues: { total: 1, items: [issue({ title: 'An issue' })] },
    });
    const { rerender } = render(<RepoCard {...noLayout} repo={pinned()} result={ok(data)} />);
    expect(screen.getByText('A pull request')).toBeTruthy();
    expect(screen.getByText('An issue')).toBeTruthy();

    rerender(<RepoCard {...noLayout} repo={pinned('octo', 'repo', { widgets: [{ type: 'ci' }] })} result={ok(data)} />);
    expect(screen.queryByText('A pull request')).toBeNull();
    expect(screen.queryByText('An issue')).toBeNull();

    rerender(<RepoCard {...noLayout} repo={pinned('octo', 'repo', { widgets: [] })} result={ok(data)} />);
    expect(screen.getByText('No widgets enabled')).toBeTruthy();
  });

  it('shows the issue label filter in the widget title', () => {
    const repo = pinned('octo', 'repo', { widgets: [{ type: 'issues', limit: 5, label: 'bug' }] });
    render(<RepoCard {...noLayout} repo={repo} result={ok()} />);
    expect(screen.getByRole('heading', { name: /Issues · bug/ })).toBeTruthy();
  });

  it('renders API text as text, never as markup', () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const data = snapshot({
      fullName: payload,
      defaultBranch: payload,
      pullRequests: { total: 1, items: [pr({ title: payload, author: payload })] },
      issues: { total: 1, items: [issue({ title: payload, labels: [{ name: payload, color: null }] })] },
    });
    const { container } = render(<RepoCard {...noLayout} repo={pinned()} result={ok(data)} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getAllByText(payload, { exact: false }).length).toBeGreaterThanOrEqual(3);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('does not link to URLs that are not GitHub', () => {
    const data = snapshot({
      url: SCRIPT_URL,
      pullRequests: { total: 1, items: [pr({ title: 'Sneaky', url: 'https://evil.example/pull/1' })] },
    });
    render(<RepoCard {...noLayout} repo={pinned()} result={ok(data)} />);
    expect(screen.queryByRole('link', { name: /Sneaky/ })).toBeNull();
    // The title falls back to plain text rather than an unsafe link.
    expect(screen.queryByRole('link', { name: /octo\/repo/ })).toBeNull();
  });

  it('collapses a widget from its header', async () => {
    const data = snapshot({
      pullRequests: { total: 1, items: [pr({ title: 'A pull request' })] },
      issues: { total: 1, items: [issue({ title: 'An issue' })] },
    });
    function Harness() {
      const [collapsed, setCollapsed] = useState<WidgetType[]>([]);
      return (
        <RepoCard
          repo={pinned()}
          result={ok(data)}
          collapsedWidgets={collapsed}
          onToggleWidget={(type) =>
            setCollapsed((c) => (c.includes(type) ? c.filter((t) => t !== type) : [...c, type]))
          }
        />
      );
    }
    render(<Harness />);

    const toggle = screen.getByRole('button', { name: /Pull requests/ });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('A pull request')).toBeNull();
    expect(screen.getByText('An issue')).toBeTruthy();

    await userEvent.click(toggle);
    expect(screen.getByText('A pull request')).toBeTruthy();
  });
});
