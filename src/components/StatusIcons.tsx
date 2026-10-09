import type { CiState, ReviewState } from '../providers/types';

const CI_META: Record<CiState, { icon: string; label: string }> = {
  success: { icon: '✓', label: 'CI passing' },
  failure: { icon: '✕', label: 'CI failing' },
  pending: { icon: '●', label: 'CI running' },
  none: { icon: '–', label: 'No CI' },
};

export function CiIcon({ state }: { state: CiState }) {
  const meta = CI_META[state];
  return (
    <span className={`ci ci-${state}`} title={meta.label} aria-label={meta.label} role="img">
      {meta.icon}
    </span>
  );
}

const REVIEW_META: Record<ReviewState, { text: string; cls: string } | null> = {
  approved: { text: 'approved', cls: 'ok' },
  changes_requested: { text: 'changes', cls: 'bad' },
  review_required: { text: 'review', cls: 'muted' },
  none: null,
};

export function ReviewBadge({ state }: { state: ReviewState }) {
  const meta = REVIEW_META[state];
  if (!meta) return null;
  return <span className={`badge badge-${meta.cls}`}>{meta.text}</span>;
}
