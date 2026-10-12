import type { InboxConfig, InboxSection, LayoutConfig, PrGrouping } from '../config/schema';
import { myPrAction } from '../lib/health';
import type { Counted, InboxSnapshot, IssueItem, PullRequestItem } from '../providers/types';
import { Collapsible } from './Collapsible';
import { ExternalLink } from './ExternalLink';
import { IssueRow, PullRequestRow } from './ItemRows';

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

function Group<T>({ title, data, render, emptyText, collapsed, onToggle, subgroups }: {
  title: string;
  data: Counted<T>;
  render: (item: T) => React.ReactNode;
  emptyText: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown instead of a flat list when set. */
  subgroups?: Subgroup<T>[] | null;
}) {
  return (
    <Collapsible
      className="inbox-group"
      title={title}
      count={data.total}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {data.items.length === 0 ? (
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
    </Collapsible>
  );
}

export function InboxPanel({ config, layout, onLayoutChange, inbox, error }: {
  config: InboxConfig;
  layout: LayoutConfig;
  onLayoutChange: (fn: (layout: LayoutConfig) => LayoutConfig) => void;
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
  const grouping = layout.groupMyPullRequests;

  const isCollapsed = (section: InboxSection) => layout.collapsedInbox.includes(section);
  const toggle = (section: InboxSection) =>
    onLayoutChange((v) => ({
      ...v,
      collapsedInbox: v.collapsedInbox.includes(section)
        ? v.collapsedInbox.filter((s) => s !== section)
        : [...v.collapsedInbox, section],
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
