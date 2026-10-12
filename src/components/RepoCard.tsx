import type { PinnedRepo, WidgetConfig, WidgetType } from '../config/schema';
import { HEALTH_LABELS, repoHealth } from '../lib/health';
import type { RepoError, RepoResult, RepoSnapshot } from '../providers/types';
import { Collapsible } from './Collapsible';
import { ExternalLink } from './ExternalLink';
import { IssueRow, PullRequestRow } from './ItemRows';
import { CiIcon } from './StatusIcons';

function Widget({ widget, data, collapsed, onToggle }: {
  widget: WidgetConfig;
  data: RepoSnapshot;
  collapsed: boolean;
  onToggle: () => void;
}) {
  switch (widget.type) {
    case 'ci':
      // Shown in the card header; nothing to render in the body.
      return null;
    case 'pullRequests': {
      const prs = data.pullRequests;
      if (!prs) return null;
      // Counted across all fetched PRs, so it matches the card's health.
      const attention = data.prsNeedingAttention;
      return (
        <Collapsible
          className="widget"
          title="Pull requests"
          count={prs.total}
          collapsed={collapsed}
          onToggle={onToggle}
          badge={attention > 0 ? <span className="badge badge-bad">{attention} need attention</span> : null}
        >
          {prs.items.length === 0 ? (
            <p className="empty">No open pull requests</p>
          ) : (
            <ul className="rows">
              {prs.items.map((pr) => (
                <PullRequestRow key={pr.number} pr={pr} />
              ))}
            </ul>
          )}
        </Collapsible>
      );
    }
    case 'issues': {
      const issues = data.issues;
      if (!issues) return null;
      return (
        <Collapsible
          className="widget"
          title={widget.label ? `Issues · ${widget.label}` : 'Issues'}
          count={issues.total}
          collapsed={collapsed}
          onToggle={onToggle}
        >
          {issues.items.length === 0 ? (
            <p className="empty">No open issues</p>
          ) : (
            <ul className="rows">
              {issues.items.map((issue) => (
                <IssueRow key={issue.number} issue={issue} />
              ))}
            </ul>
          )}
        </Collapsible>
      );
    }
  }
}

function RepoErrorText({ error }: { error: RepoError }) {
  return (
    <p className="error-text">
      {error.message}
      {error.help && (
        <>
          {' '}
          <ExternalLink href={error.help.url}>{error.help.label}</ExternalLink>
        </>
      )}
    </p>
  );
}

export function RepoCard({ repo, result, collapsedWidgets, onToggleWidget }: {
  repo: PinnedRepo;
  result: RepoResult | undefined;
  /** Widget types collapsed on this card. */
  collapsedWidgets: readonly WidgetType[];
  onToggleWidget: (type: WidgetType) => void;
}) {
  const health = repoHealth(result);
  const data = result?.ok ? result.data : null;
  const fullName = data?.fullName ?? `${repo.owner}/${repo.name}`;

  return (
    <article
      className={`card health-${health ?? 'loading'}`}
      aria-label={`${fullName}: ${health ? HEALTH_LABELS[health] : 'Loading'}`}
    >
      <header className="card-header">
        <ExternalLink href={data?.url ?? `https://github.com/${repo.owner}/${repo.name}`} className="card-title">
          <span className="owner">{repo.owner}/</span>
          {repo.name}
        </ExternalLink>
        {data?.isPrivate && <span className="badge badge-muted">private</span>}
        {data?.isArchived && <span className="badge badge-muted">archived</span>}
        {data?.ci && (
          <span className="card-ci" title={`CI on ${data.defaultBranch ?? 'default branch'}`}>
            <CiIcon state={data.ci} />
            <span className="branch">{data.defaultBranch}</span>
          </span>
        )}
      </header>

      {!result && <p className="empty">Loading…</p>}
      {result && !result.ok && <RepoErrorText error={result.error} />}
      {data &&
        repo.widgets.map((w) => (
          <Widget
            key={w.type}
            widget={w}
            data={data}
            collapsed={collapsedWidgets.includes(w.type)}
            onToggle={() => onToggleWidget(w.type)}
          />
        ))}
      {data && repo.widgets.length === 0 && <p className="empty">No widgets enabled</p>}
    </article>
  );
}
