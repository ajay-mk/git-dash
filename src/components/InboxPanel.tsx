import { useId } from 'react';
import type { InboxConfig, InboxSection, InboxView, PrGrouping } from '../config/schema';
import { myPrAction } from '../lib/health';
import type { Counted, InboxSnapshot, IssueItem, PullRequestItem } from '../providers/types';
import { ExternalLink } from './ExternalLink';
import { IssueRow, PullRequestRow } from './ItemRows';

const GROUPING_LABELS: Record<PrGrouping, string> = {
  none: 'No grouping',
  repo: 'By repository',
  status: 'By status',
};

interface Subgroup<T> {
  key: string;
  title: string;
  items: T[];
}

/** Splits PRs into labelled groups, keeping their order within each group. */
export function groupPullRequests(items: PullRequestItem[], by: PrGrouping): Subgroup<PullRequestItem>[] | null {
  if (by === 'status') {
    const ready = items.filter((pr) => !pr.isDraft);
    const drafts = items.filter((pr) => pr.isDraft);
    return [
      { key: 'ready', title: 'Ready', items: ready },
      { key: 'draft', title: 'Draft', items: drafts },
    ].filter((g) => g.items.length > 0);
  }
  if (by === 'repo') {
    const byRepo = new Map<string, PullRequestItem[]>();
    for (const pr of items) {
      const repo = pr.repo ?? '';
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), pr]);
    }
    return [...byRepo.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(([repo, prs]) => ({ key: repo, title: repo || 'Unknown repository', items: prs }));
  }
  return null;
}

function Group<T>({ title, data, render, emptyText, collapsed, onToggle, subgroups, controls }: {
  title: string;
  data: Counted<T>;
  render: (item: T) => React.ReactNode;
  emptyText: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown instead of a flat list when set. */
  subgroups?: Subgroup<T>[] | null;
  /** Extra controls in the header, shown while expanded. */
  controls?: React.ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className="inbox-group">
      <div className="inbox-group-header">
        <h3 className="widget-title">
          <button
            type="button"
            className="group-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <span className="chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            {title} <span className="count">{data.total}</span>
          </button>
        </h3>
        {!collapsed && controls}
      </div>
      <div id={bodyId} hidden={collapsed}>
        {collapsed ? null : data.items.length === 0 ? (
          <p className="empty">{emptyText}</p>
        ) : subgroups ? (
          subgroups.map((group) => (
            <div key={group.key} className="subgroup">
              <h4 className="subgroup-title" title={group.title}>
                {group.title} <span className="count">{group.items.length}</span>
              </h4>
              <ul className="rows">{group.items.map(render)}</ul>
            </div>
          ))
        ) : (
          <ul className="rows">{data.items.map(render)}</ul>
        )}
      </div>
    </section>
  );
}

export function InboxPanel({ config, view, onViewChange, inbox, error }: {
  config: InboxConfig;
  view: InboxView;
  onViewChange: (fn: (view: InboxView) => InboxView) => void;
  inbox: InboxSnapshot | null;
  error: string | null;
}) {
  // Surface your own PRs that need an action first.
  const sortedMine: Counted<PullRequestItem> | null = inbox
    ? {
        total: inbox.myPullRequests.total,
        items: [...inbox.myPullRequests.items].sort(
          (a, b) => Number(myPrAction(b) !== null) - Number(myPrAction(a) !== null),
        ),
      }
    : null;
  const grouping = view.groupMyPullRequests;

  const isCollapsed = (section: InboxSection) => view.collapsed.includes(section);
  const toggle = (section: InboxSection) =>
    onViewChange((v) => ({
      ...v,
      collapsed: v.collapsed.includes(section)
        ? v.collapsed.filter((s) => s !== section)
        : [...v.collapsed, section],
    }));

  return (
    <aside className="sidebar" aria-label="Needs you">
      <h2 className="sidebar-title">Needs you</h2>
      {error && <p className="error-text">{error}</p>}
      {!inbox && !error && <p className="empty">Loading…</p>}
      {inbox && (
        <>
          {inbox.ssoRestricted && (
            <p className="notice">
              Some results are hidden because an organization requires SSO. Authorize a personal access
              token under <ExternalLink href="https://github.com/settings/tokens">Configure SSO</ExternalLink>, or
              sign in through the organization&apos;s SSO for an OAuth token.
            </p>
          )}
          {config.reviewRequests && (
            <Group
              title="Review requests"
              data={inbox.reviewRequests}
              emptyText="Nothing to review"
              collapsed={isCollapsed('reviewRequests')}
              onToggle={() => toggle('reviewRequests')}
              render={(pr: PullRequestItem) => <PullRequestRow key={pr.url} pr={pr} showRepo />}
            />
          )}
          {config.myPullRequests && sortedMine && (
            <Group
              title="Your pull requests"
              data={sortedMine}
              emptyText="No open pull requests"
              collapsed={isCollapsed('myPullRequests')}
              onToggle={() => toggle('myPullRequests')}
              subgroups={groupPullRequests(sortedMine.items, grouping)}
              controls={
                <select
                  className="group-select"
                  aria-label="Group your pull requests"
                  value={grouping}
                  onChange={(e) => {
                    const groupMyPullRequests = e.target.value as PrGrouping;
                    onViewChange((v) => ({ ...v, groupMyPullRequests }));
                  }}
                >
                  {(Object.keys(GROUPING_LABELS) as PrGrouping[]).map((g) => (
                    <option key={g} value={g}>
                      {GROUPING_LABELS[g]}
                    </option>
                  ))}
                </select>
              }
              render={(pr: PullRequestItem) => (
                // The repository is already the heading when grouped by it.
                <PullRequestRow key={pr.url} pr={pr} showRepo={grouping !== 'repo'} action={myPrAction(pr)} />
              )}
            />
          )}
          {config.assigned && (
            <Group
              title="Assigned to you"
              data={inbox.assigned}
              emptyText="Nothing assigned"
              collapsed={isCollapsed('assigned')}
              onToggle={() => toggle('assigned')}
              render={(issue: IssueItem) => <IssueRow key={issue.url} issue={issue} showRepo />}
            />
          )}
        </>
      )}
    </aside>
  );
}
