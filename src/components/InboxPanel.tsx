import type { InboxConfig } from '../config/schema';
import { myPrAction } from '../lib/health';
import type { Counted, InboxSnapshot, IssueItem, PullRequestItem } from '../providers/types';
import { ExternalLink } from './ExternalLink';
import { IssueRow, PullRequestRow } from './ItemRows';

function Group<T>({ title, data, render, emptyText }: {
  title: string;
  data: Counted<T>;
  render: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  return (
    <section className="inbox-group">
      <h3 className="widget-title">
        {title} <span className="count">{data.total}</span>
      </h3>
      {data.items.length === 0 ? <p className="empty">{emptyText}</p> : <ul className="rows">{data.items.map(render)}</ul>}
    </section>
  );
}

export function InboxPanel({ config, inbox, error }: {
  config: InboxConfig;
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

  return (
    <aside className="sidebar" aria-label="Needs you">
      <h2 className="sidebar-title">Needs you</h2>
      {error && <p className="error-text">{error}</p>}
      {!inbox && !error && <p className="empty">Loading…</p>}
      {inbox && (
        <>
          {inbox.ssoRestricted && (
            <p className="notice">
              Some results are hidden because an organization requires SSO.{' '}
              <ExternalLink href="https://github.com/settings/tokens">Authorize token</ExternalLink>
            </p>
          )}
          {config.reviewRequests && (
            <Group
              title="Review requests"
              data={inbox.reviewRequests}
              emptyText="Nothing to review"
              render={(pr: PullRequestItem) => <PullRequestRow key={pr.url} pr={pr} showRepo />}
            />
          )}
          {config.myPullRequests && sortedMine && (
            <Group
              title="Your pull requests"
              data={sortedMine}
              emptyText="No open pull requests"
              render={(pr: PullRequestItem) => (
                <PullRequestRow key={pr.url} pr={pr} showRepo action={myPrAction(pr)} />
              )}
            />
          )}
          {config.assigned && (
            <Group
              title="Assigned to you"
              data={inbox.assigned}
              emptyText="Nothing assigned"
              render={(issue: IssueItem) => <IssueRow key={issue.url} issue={issue} showRepo />}
            />
          )}
        </>
      )}
    </aside>
  );
}
