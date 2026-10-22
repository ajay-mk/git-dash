/**
 * Thin wrapper over the Tauri commands implemented in `src-tauri/src/commands.rs`.
 * Access tokens never cross this boundary: the frontend can store, list and
 * clear them, but never read one back.
 */

import { invoke } from '@tauri-apps/api/core';
import type { GitHubOperation } from '../providers/github/queries';
import type { ProviderId } from '../providers/types';

export type AppErrorKind =
  | 'no_token'
  | 'unauthorized'
  | 'invalid_token_format'
  | 'invalid_owner'
  | 'invalid_host'
  | 'owner_tokens_unsupported'
  | 'insufficient_scope'
  | 'forbidden_url'
  | 'too_many_tokens'
  | 'forbidden_operation'
  | 'request_too_large'
  | 'unknown_provider'
  | 'rate_limited'
  | 'http'
  | 'network'
  | 'keyring'
  | 'gh_not_found'
  | 'gh_not_logged_in'
  | 'gh_outdated'
  | 'gh_failed'
  | 'gh_account_mismatch'
  | 'internal';

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (typeof err === 'object' && err !== null && 'kind' in err && 'message' in err) {
    const { kind, message } = err as { kind: unknown; message: unknown };
    if (typeof kind === 'string' && typeof message === 'string') {
      return new AppError(kind as AppErrorKind, message);
    }
  }
  return new AppError('internal', err instanceof Error ? err.message : 'Unexpected error');
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

/**
 * Where a token comes from: one stored in the keychain, or read from the
 * GitHub CLI when needed (GitDash keeps no copy of that one).
 */
export type TokenSource = 'token' | 'gh';

/** A per-owner token, described by the login GitHub reports for it. */
export interface OwnerToken {
  /** Account or organization login (lowercase) the token is used for. */
  owner: string;
  /** Login of the account the token belongs to. */
  login: string;
  /** Missing means a stored token. */
  source?: TokenSource;
}

export interface TokenSummary {
  hasDefault: boolean;
  defaultLogin: string | null;
  /** Where the default token comes from, when there is one. */
  defaultSource?: TokenSource | null;
  owners: OwnerToken[];
  /** GitLab only: the instance the default token is for, as `URL.host`. */
  host?: string | null;
}

export const tokens = {
  list: (provider: ProviderId) => call<TokenSummary>('token_list', { provider }),
  /**
   * Verifies and stores a token; resolves to the login it belongs to. Without
   * `owner` it replaces the default token. For GitLab, `host` is the instance
   * (gitlab.com when left out); the token is only ever sent there.
   */
  set: (provider: ProviderId, token: string, owner: string | null = null, host: string | null = null) =>
    call<string>('token_set', { provider, token, owner, host }),
  clear: (provider: ProviderId, owner: string | null = null) => call<void>('token_clear', { provider, owner }),
  /**
   * Links the default GitHub slot, or with `owner` that owner's slot, to the
   * account the GitHub CLI is signed in to. Resolves to that login. Any token
   * stored for the slot is removed; the backend reads gh's token when needed.
   */
  linkGh: (owner: string | null = null) => call<string>('token_link_gh', { owner }),
};

export interface GhStatus {
  /** Where the GitHub CLI was found, or `null` if it is not installed in a known place. */
  path: string | null;
}

/** Whether the GitHub CLI is installed where GitDash looks for it. */
export function ghStatus(): Promise<GhStatus> {
  return call<GhStatus>('gh_status', {});
}

export interface GraphQLError {
  message?: string;
  path?: (string | number)[];
  type?: string;
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

/**
 * Runs one of GitDash's read-only GitHub queries, by name (the documents live
 * in the backend). The backend uses the token configured for `owner` if
 * there is one, and the default token otherwise.
 */
export function githubGraphql<T>(
  operation: GitHubOperation,
  variables: Record<string, unknown>,
  owner: string | null = null,
): Promise<GraphQLResponse<T>> {
  return call<GraphQLResponse<T>>('github_graphql', { operation, variables, owner });
}

/**
 * Runs a read-only GraphQL query against the connected GitLab instance. The
 * backend picks the host the stored token belongs to.
 */
export function gitlabGraphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
  return call<GraphQLResponse<T>>('gitlab_graphql', { query, variables });
}

/** Saves the window's size and position, which normally happens on exit. */
export function saveWindowState(): Promise<void> {
  return call<void>('save_window_state', {});
}

/** Opens a GitHub or connected-GitLab page in the system browser. */
export function openExternalUrl(url: string): Promise<void> {
  return call<void>('open_external', { url });
}
