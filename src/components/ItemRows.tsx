import { shortAgo } from '../lib/time';
import type { IssueItem, PullRequestItem } from '../providers/types';
import { ExternalLink } from './ExternalLink';
import { CiIcon, ReviewBadge } from './StatusIcons';

function repoShort(repo: string | undefined): string {
  return repo ? repo.split('/')[1] ?? repo : '';
}

export function PullRequestRow({ pr, showRepo = false, action = null }: {
  pr: PullRequestItem;
  showRepo?: boolean;
  /** Highlights a PR the viewer should act on. */
  action?: 'fix' | 'merge' | null;
}) {
  const cls = ['row', pr.isDraft && 'row-draft', action && `row-action-${action}`].filter(Boolean).join(' ');
  return (
    <li className={cls}>
      <CiIcon state={pr.ci} />
      <ExternalLink href={pr.url} className="row-title" title={pr.title}>
        <span className="row-num">{showRepo ? `${repoShort(pr.repo)}#${pr.number}` : `#${pr.number}`}</span>{' '}
        {pr.title}
      </ExternalLink>
      {pr.isDraft ? <span className="badge badge-muted">draft</span> : <ReviewBadge state={pr.review} />}
      <span className="row-meta" title={pr.author ? `by ${pr.author}` : undefined}>
        {shortAgo(pr.updatedAt)}
      </span>
    </li>
  );
}

export function IssueRow({ issue, showRepo = false }: { issue: IssueItem; showRepo?: boolean }) {
  return (
    <li className="row">
      <span className={`kind ${issue.isPullRequest ? 'kind-pr' : 'kind-issue'}`} aria-hidden="true">
        {issue.isPullRequest ? '⇄' : '○'}
      </span>
      <ExternalLink href={issue.url} className="row-title" title={issue.title}>
        <span className="row-num">{showRepo ? `${repoShort(issue.repo)}#${issue.number}` : `#${issue.number}`}</span>{' '}
        {issue.title}
      </ExternalLink>
      {issue.labels.slice(0, 2).map((label) => (
        <span
          key={label.name}
          className="label"
          // Colour is validated as 6-digit hex in the mapper; set via the
          // CSSOM, which the CSP allows (unlike inline style attributes).
          style={label.color ? { borderColor: `#${label.color}` } : undefined}
        >
          {label.name}
        </span>
      ))}
      <span className="row-meta">{shortAgo(issue.updatedAt)}</span>
    </li>
  );
}
