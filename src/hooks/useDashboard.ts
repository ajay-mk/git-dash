import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
import { AppError } from '../lib/transport';
import { providers } from '../providers';
import { combineInboxes } from '../providers/tokens';
import { PROVIDER_IDS, type InboxSnapshot, type ProviderId, type RateLimit, type RepoBatch, type RepoResult } from '../providers/types';

export interface DashboardState {
  repos: Map<string, RepoResult>;
  inbox: InboxSnapshot | null;
  inboxError: string | null;
  error: AppError | null;
  /** Connected providers whose token was rejected or has gone missing. */
  rejected: ProviderId[];
  loading: boolean;
  lastUpdated: Date | null;
  rateLimit: RateLimit | null;
}

const INITIAL: DashboardState = {
  repos: new Map(),
  inbox: null,
  inboxError: null,
  error: null,
  rejected: [],
  loading: false,
  lastUpdated: null,
  rateLimit: null,
};

const CONFIG_DEBOUNCE_MS = 400;

export function isAuthError(err: AppError | null): boolean {
  return err?.kind === 'unauthorized' || err?.kind === 'no_token';
}

/** The pinned repos in a fixed order, so reordering the cards is not a data change. */
function byId(repos: readonly PinnedRepo[]): PinnedRepo[] {
  return [...repos].sort((a, b) => (repoId(a) < repoId(b) ? -1 : repoId(a) > repoId(b) ? 1 : 0));
}

function asAppError(err: unknown): AppError {
  return err instanceof AppError ? err : new AppError('internal', 'Unexpected error');
}

type Settled<T> = { provider: ProviderId; result: PromiseSettledResult<T> };

async function settleEach<T>(
  ids: readonly ProviderId[],
  run: (provider: ProviderId) => Promise<T>,
): Promise<Settled<T>[]> {
  const results = await Promise.allSettled(ids.map(run));
  return results.map((result, i) => ({ provider: ids[i]!, result }));
}

/** Prefixes an error with the provider it came from when several are connected. */
function labelled(err: AppError, provider: ProviderId, several: boolean): AppError {
  return several ? new AppError(err.kind, `${providers[provider].label}: ${err.message}`) : err;
}

/**
 * Loads dashboard data from every connected provider and keeps it fresh.
 * Refreshes when the config changes, on the configured interval, and when the
 * window regains focus after the data went stale. Polling pauses while the
 * window is hidden.
 *
 * `tokenOwners` are GitHub's per-owner tokens; `connected` the providers with
 * a default token.
 */
export function useDashboard(
  config: DashboardConfig,
  tokenOwners: readonly string[],
  connected: readonly ProviderId[],
  enabled: boolean,
) {
  const [state, setState] = useState<DashboardState>(INITIAL);
  const requestId = useRef(0);
  const lastFetch = useRef(0);
  // Settings that produced the data on screen, so a failed refresh after a
  // settings change does not leave data fetched for the old settings.
  const shownKeys = useRef({ repos: '', inbox: '' });

  // Only refetch when data-affecting settings change (not theme, card order
  // etc.).
  const fetchKey = useMemo(
    () => JSON.stringify([byId(config.repos), config.inbox, tokenOwners, connected]),
    [config.repos, config.inbox, tokenOwners, connected],
  );
  const configRef = useRef(config);
  const ownersRef = useRef(tokenOwners);
  const connectedRef = useRef(connected);
  // Declared before the fetch effect so it runs first in the same commit.
  useEffect(() => {
    configRef.current = config;
    ownersRef.current = tokenOwners;
    connectedRef.current = connected;
  }, [config, tokenOwners, connected]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    lastFetch.current = Date.now();
    // Drop auth errors right away so a freshly saved token leaves the setup
    // screen immediately; other errors stay visible until the reload finishes.
    setState((s) => ({ ...s, loading: true, rejected: [], error: s.error && isAuthError(s.error) ? null : s.error }));
    const { repos, inbox } = configRef.current;
    const owners = ownersRef.current;
    const live = PROVIDER_IDS.filter((p) => connectedRef.current.includes(p));
    const several = live.length > 1;
    const keys = {
      repos: JSON.stringify([byId(repos), owners, live]),
      inbox: JSON.stringify([inbox, owners, live]),
    };
    const ownersOf = (p: ProviderId) => (providers[p].ownerTokens ? owners : []);
    const pinnedTo = (p: ProviderId) => repos.filter((r) => r.provider === p);

    const [repoRes, inboxRes] = await Promise.all([
      settleEach<RepoBatch>(
        live.filter((p) => pinnedTo(p).length > 0),
        (p) => providers[p].fetchRepos(pinnedTo(p), ownersOf(p)),
      ),
      inbox.enabled ? settleEach(live, (p) => providers[p].fetchInbox(inbox, ownersOf(p))) : Promise.resolve(null),
    ]);
    if (id !== requestId.current) return; // a newer refresh superseded this one

    setState((s) => {
      const next: DashboardState = { ...s, loading: false, error: null, rejected: [] };
      const reject = (p: ProviderId, err: AppError) => {
        if (isAuthError(err) && !next.rejected.includes(p)) next.rejected.push(p);
      };

      const fetched = repoRes.filter((r) => r.result.status === 'fulfilled');
      if (repoRes.length === 0 || fetched.length > 0) {
        // Only fresh repository data counts as an update; after a failure the
        // cards still show the previous data and must not look current.
        next.lastUpdated = new Date();
        next.repos = new Map();
        shownKeys.current.repos = keys.repos;
      } else {
        // Nothing loaded: keep the cards as they were, unless they show other settings.
        next.repos = shownKeys.current.repos === keys.repos ? new Map(s.repos) : new Map();
      }
      for (const { provider, result } of repoRes) {
        if (result.status === 'fulfilled') {
          for (const [id, repo] of result.value.repos) next.repos.set(id, repo);
          if (result.value.rateLimit) next.rateLimit = result.value.rateLimit;
        } else {
          const err = labelled(asAppError(result.reason), provider, several);
          next.error ??= err;
          reject(provider, err);
          // Keep showing this provider's previous data next to the others' fresh data.
          if (fetched.length > 0) {
            for (const repo of pinnedTo(provider)) {
              const shown = s.repos.get(repoId(repo));
              next.repos.set(repoId(repo), shown ?? { ok: false, error: { kind: 'unknown', message: err.message } });
            }
          }
        }
      }
      for (const repo of repos) {
        if (!live.includes(repo.provider) && !next.repos.has(repoId(repo))) {
          const label = providers[repo.provider].label;
          next.repos.set(repoId(repo), {
            ok: false,
            error: { kind: 'not_connected', message: `Connect ${label} in Settings to load this repository.` },
          });
        }
      }

      if (inboxRes) {
        const loaded = inboxRes.flatMap((r) => (r.result.status === 'fulfilled' ? [r.result.value] : []));
        const failed = inboxRes.flatMap(({ provider, result }) =>
          result.status === 'rejected' ? [labelled(asAppError(result.reason), provider, several)] : [],
        );
        inboxRes.forEach(({ provider, result }) => {
          if (result.status === 'rejected') reject(provider, asAppError(result.reason));
        });
        if (loaded.length > 0 || inboxRes.length === 0) {
          next.inbox = combineInboxes(loaded, inbox.limit);
          shownKeys.current.inbox = keys.inbox;
        } else if (shownKeys.current.inbox !== keys.inbox) {
          next.inbox = null;
        }
        next.inboxError = failed.map((e) => e.message).join(' ') || null;
        next.error ??= failed.find(isAuthError) ?? null;
      } else {
        next.inbox = null;
        next.inboxError = null;
        shownKeys.current.inbox = keys.inbox;
      }
      return next;
    });
  }, []);

  // Debounced so that typing in settings (e.g. a label filter) does not
  // fire a request per keystroke.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void refresh(), CONFIG_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchKey, refresh]);

  useEffect(() => {
    if (!enabled || config.refreshMinutes <= 0) return;
    const intervalMs = config.refreshMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetch.current > intervalMs) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, config.refreshMinutes, refresh]);

  return { ...state, refresh };
}
