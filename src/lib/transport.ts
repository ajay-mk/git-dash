/**
 * Thin wrapper over the Tauri commands implemented in `src-tauri/src/commands.rs`.
 * Access tokens never cross this boundary: the frontend can store, list and
 * clear them, but never read one back.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ProviderId } from '../providers/types';

export type AppErrorKind =
  | 'no_token'
  | 'unauthorized'
  | 'invalid_token_format'
  | 'invalid_owner'
  | 'too_many_tokens'
  | 'forbidden_operation'
  | 'request_too_large'
  | 'unknown_provider'
  | 'http'
  | 'network'
  | 'keyring'
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

/** A per-owner token, described by the login GitHub reports for it. */
export interface OwnerToken {
  /** Account or organization login (lowercase) the token is used for. */
  owner: string;
  /** Login of the account the token belongs to. */
  login: string;
}

export interface TokenSummary {
  hasDefault: boolean;
  defaultLogin: string | null;
  owners: OwnerToken[];
}

export const tokens = {
  list: (provider: ProviderId) => call<TokenSummary>('token_list', { provider }),
  /**
   * Verifies and stores a token; resolves to the login it belongs to. Without
   * `owner` it replaces the default token.
   */
  set: (provider: ProviderId, token: string, owner: string | null = null) =>
    call<string>('token_set', { provider, token, owner }),
  clear: (provider: ProviderId, owner: string | null = null) => call<void>('token_clear', { provider, owner }),
};

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string; path?: (string | number)[]; type?: string }[];
}

/**
 * Runs a read-only GraphQL query. The backend uses the token configured for
 * `owner` if there is one, and the default token otherwise.
 */
export function githubGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  owner: string | null = null,
): Promise<GraphQLResponse<T>> {
  return call<GraphQLResponse<T>>('github_graphql', { query, variables, owner });
}
