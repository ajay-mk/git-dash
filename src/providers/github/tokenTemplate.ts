/**
 * Read-only repository permissions GitDash needs from a fine-grained token.
 * `key` is the name GitHub uses for the permission in token template URLs.
 */
export const FINE_GRAINED_PERMISSIONS = [
  { key: 'metadata', label: 'Metadata' },
  { key: 'contents', label: 'Contents' },
  { key: 'pull_requests', label: 'Pull requests' },
  { key: 'issues', label: 'Issues' },
  { key: 'statuses', label: 'Commit statuses' },
  { key: 'actions', label: 'Actions' },
] as const;

export const PERMISSION_LABELS: readonly string[] = FINE_GRAINED_PERMISSIONS.map((p) => p.label);

/** GitHub caps token names at 40 characters. */
const MAX_NAME_LENGTH = 40;

/**
 * Link to GitHub's fine-grained token form with the name, description and
 * read-only permissions filled in. GitHub cannot preselect repository access
 * from a link, so users still choose which repositories the token covers.
 * With `owner`, the token is created for that account or organization.
 */
export function fineGrainedTokenUrl(owner?: string | null): string {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  const name = owner ? `GitDash ${owner}` : 'GitDash';
  url.searchParams.set('name', name.slice(0, MAX_NAME_LENGTH));
  url.searchParams.set('description', 'Read-only access for the GitDash dashboard');
  if (owner) url.searchParams.set('target_name', owner);
  for (const { key } of FINE_GRAINED_PERMISSIONS) url.searchParams.set(key, 'read');
  return url.toString();
}
