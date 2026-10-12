import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { shortAgo } from '../lib/time';
import type { CheckItem, IssueItem, ItemDetails, PullRequestItem, ReviewerState } from '../providers/types';
import { ExternalLink } from './ExternalLink';
import { CiIcon } from './StatusIcons';

export type Item = { kind: 'pr'; pr: PullRequestItem } | { kind: 'issue'; issue: IssueItem };

function itemOf(item: Item) {
  return item.kind === 'pr' ? item.pr : item.issue;
}

const REVIEWER_TEXT: Record<ReviewerState, { icon: string; text: string; cls: string }> = {
  approved: { icon: '✓', text: 'approved', cls: 'ci-success' },
  changes_requested: { icon: '✕', text: 'requested changes', cls: 'ci-failure' },
  commented: { icon: '●', text: 'commented', cls: 'ci-none' },
  requested: { icon: '○', text: 'review requested', cls: 'ci-pending' },
};

function ChecksSummary({ checks }: { checks: CheckItem[] }) {
  const failing = checks.filter((c) => c.state === 'failure');
  const pending = checks.filter((c) => c.state === 'pending');
  const passing = checks.length - failing.length - pending.length;
  return (
    <div className="details-section">
      <div className="details-label">Checks</div>
      <div className="details-line">
        {failing.length > 0 ? (
          <><CiIcon state="failure" /> {failing.length} failing, {passing} passing</>
        ) : pending.length > 0 ? (
          <><CiIcon state="pending" /> {pending.length} running, {passing} passing</>
        ) : (
          <><CiIcon state="success" /> All {checks.length} passing</>
        )}
      </div>
      {failing.length > 0 && (
        <ul className="details-list">
          {failing.slice(0, 4).map((c) => (
            <li key={c.name}>
              {c.url ? <ExternalLink href={c.url}>{c.name}</ExternalLink> : c.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailsContent({ item, details, error }: {
  item: Item;
  details: ItemDetails | null;
  error: string | null;
}) {
  const base = itemOf(item);
  const pr = details?.pr ?? null;
  return (
    <>
      <div className="details-head">
        <span className="row-num">{base.repo ?? ''}#{base.number}</span>
        {item.kind === 'pr' && item.pr.isDraft && <span className="badge badge-muted">draft</span>}
      </div>
      <div className="details-title">{base.title}</div>
      <div className="details-meta">
        {base.author ?? 'Unknown'} opened {details ? `${shortAgo(details.createdAt)} ago` : '…'}
        {details && details.comments > 0 && <> · {details.comments} {details.comments === 1 ? 'comment' : 'comments'}</>}
      </div>
      {error && <p className="error-text">{error}</p>}
      {!details && !error && <p className="empty">Loading details…</p>}
      {details && (
        <>
          {pr && (
            <div className="details-branch">
              <code>{pr.headRef}</code> → <code>{pr.baseRef}</code>
              <span className="details-diff">
                <span className="ci-success">+{pr.additions}</span> <span className="ci-failure">−{pr.deletions}</span>{' '}
                · {pr.changedFiles} files
              </span>
            </div>
          )}
          {pr && pr.checks.length > 0 && <ChecksSummary checks={pr.checks} />}
          {pr && pr.reviewers.length > 0 && (
            <div className="details-section">
              <div className="details-label">Reviews</div>
              <ul className="details-list details-reviewers">
                {pr.reviewers.map((r) => {
                  const meta = REVIEWER_TEXT[r.state];
                  return (
                    <li key={r.login}>
                      <span className={`ci ${meta.cls}`} aria-hidden="true">{meta.icon}</span> {r.login}{' '}
                      <span className="muted">{meta.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {item.kind === 'pr' && item.pr.mergeable === false && (
            <div className="details-line ci-failure">Has merge conflicts</div>
          )}
          {details.assignees.length > 0 && (
            <div className="details-line muted">Assigned to {details.assignees.join(', ')}</div>
          )}
          {details.body && <p className="details-body">{details.body}</p>}
          {details.labels.length > 0 && (
            <div className="details-labels">
              {details.labels.map((l) => (
                <span key={l.name} className="label" style={l.color ? { borderColor: `#${l.color}` } : undefined}>
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <div className="details-actions">
        <ExternalLink href={base.url} className="btn btn-primary">Open on GitHub</ExternalLink>
        {item.kind === 'pr' && (
          <>
            <ExternalLink href={`${base.url}/files`} className="btn">Files</ExternalLink>
            <ExternalLink href={`${base.url}/checks`} className="btn">Checks</ExternalLink>
          </>
        )}
      </div>
    </>
  );
}

export type LoadDetails = (url: string) => Promise<ItemDetails>;

function useDetails(url: string, load: LoadDetails) {
  const [state, setState] = useState<{ details: ItemDetails | null; error: string | null }>({ details: null, error: null });
  useEffect(() => {
    let live = true;
    load(url).then(
      (details) => live && setState({ details, error: null }),
      (err: unknown) =>
        live && setState({ details: null, error: err instanceof Error ? err.message : 'Could not load details.' }),
    );
    return () => {
      live = false;
    };
  }, [url, load]);
  return state;
}

const GAP = 8;

/** Beside the row when there is room, otherwise below it; always inside the window. */
export function placeCard(anchor: DOMRect, card: { width: number; height: number }): { left: number; top: number } {
  const maxLeft = window.innerWidth - card.width - GAP;
  const maxTop = window.innerHeight - card.height - GAP;
  if (anchor.right + GAP + card.width + GAP <= window.innerWidth) {
    return { left: anchor.right + GAP, top: Math.max(GAP, Math.min(anchor.top - 10, maxTop)) };
  }
  return { left: Math.max(GAP, Math.min(anchor.left, maxLeft)), top: Math.max(GAP, Math.min(anchor.bottom + 4, maxTop)) };
}

/**
 * Details of a pull request or issue in a card floating next to its row, with
 * the link one click away. Closes on Escape or a click elsewhere.
 */
export function DetailsCard({ item, anchor, load, onClose }: {
  item: Item;
  /** The row the card belongs to; clicks on it are left to its own toggle. */
  anchor: RefObject<HTMLElement | null>;
  load: LoadDetails;
  onClose: () => void;
}) {
  const { details, error } = useDetails(itemOf(item).url, load);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const card = ref.current;
      const row = anchor.current;
      if (card && row) setPos(placeCard(row.getBoundingClientRect(), { width: card.offsetWidth, height: card.offsetHeight }));
    };
    update();
    // Follow the row when the sidebar scrolls or the window resizes.
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, details, error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      anchor.current?.querySelector<HTMLElement>('.row-button')?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [anchor, onClose]);

  // Portalled so the sidebar's scroll area cannot clip it and the list stays valid HTML.
  return createPortal(
    <div
      ref={ref}
      className="details-card"
      role="dialog"
      aria-label={itemOf(item).title}
      style={pos ?? { visibility: 'hidden' }}
    >
      <DetailsContent item={item} details={details} error={error} />
    </div>,
    document.body,
  );
}
