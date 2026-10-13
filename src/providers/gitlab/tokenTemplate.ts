import { GITLAB_COM } from './host';

/** The only scope GitDash needs: read-only access to the API. */
export const GITLAB_SCOPES = ['read_api'] as const;

export const SCOPE_LABELS: readonly string[] = GITLAB_SCOPES;

/**
 * Link to the personal access token form on `host` with the name and the
 * `read_api` scope filled in.
 */
export function gitlabTokenUrl(host?: string | null): string {
  const url = new URL(`https://${host || GITLAB_COM}/-/user_settings/personal_access_tokens`);
  url.searchParams.set('name', 'GitDash');
  url.searchParams.set('scopes', GITLAB_SCOPES.join(','));
  return url.toString();
}
