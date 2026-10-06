/**
 * Thin wrapper over the Tauri commands implemented in `src-tauri/src/commands.rs`.
 * The access token never crosses this boundary: the frontend can store,
 * check and clear it, but never read it.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ProviderId } from '../providers/types';

export type AppErrorKind =
  | 'no_token'
  | 'unauthorized'
  | 'invalid_token_format'
  | 'forbidden_operation'
  | 'request_too_large'
  | 'unknown_provider'
  | 'rate_limited'
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

export const tokens = {
  status: (provider: ProviderId) => call<boolean>('token_status', { provider }),
  /** Verifies and stores the token; resolves to the account login. */
  set: (provider: ProviderId, token: string) => call<string>('token_set', { provider, token }),
  clear: (provider: ProviderId) => call<void>('token_clear', { provider }),
};

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

export function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
  return call<GraphQLResponse<T>>('github_graphql', { query, variables });
}
