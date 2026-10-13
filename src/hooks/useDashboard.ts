import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
import { inboxBaseline } from '../lib/notify';
import { AppError } from '../lib/transport';
import { connectedGitLabHost } from '../lib/url';
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

/**
 * Called after each inbox fetch with the previous one fetched with the same
 * settings and tokens, and when that was (ms since epoch).
 */
export type InboxChangeHandler = (prev: InboxSnapshot, next: InboxSnapshot, since: number) => void;

export interface RefreshOptions {
  /** The service whose token was just saved. */
  tokenChanged?: ProviderId;
  /** Only fetch "Needs you", leaving the cards as they are. */
  inboxOnly?: boolean;
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
 * window is hidden, except for "Needs you" while `onInboxChange` watches it.
 *
 * `tokenOwners` are GitHub's per-owner tokens; `connected` the providers with
 * a default token.
 */
export function useDashboard(
  config: DashboardConfig,
  tokenOwners: readonly string[],
  connected: readonly ProviderId[],
  enabled: boolean,
  onInboxChange?: InboxChangeHandler,
) {
  const [state, setState] = useState<DashboardState>(INITIAL);
  const requestId = useRef(0);
  const lastFetch = useRef(0);
  // Settings that produced the data on screen, so a failed refresh after a
  // settings change does not leave data fetched for the old settings.
  const shownKeys = useRef<{ repos: Partial<Record<ProviderId, string>>; inbox: string }>({ repos: {}, inbox: '' });

  // Only refetch when data-affecting settings change (not theme, card order
  // etc.).
  const fetchKey = useMemo(
    () => JSON.stringify([byId(config.repos), config.inbox, tokenOwners, connected]),
    [config.repos, config.inbox, tokenOwners, connected],
  );
  const configRef = useRef(config);
  const ownersRef = useRef(tokenOwners);
  const connectedRef = useRef(connected);
  const onInboxChangeRef = useRef(onInboxChange);
  const busy = useRef(false);
  // The last inbox fetched, with its settings and time, to compare the next one against.
  const lastInbox = useRef<{ key: string; at: number; snapshot: InboxSnapshot } | null>(null);
  // Declared before the fetch effect so it runs first in the same commit.
  useEffect(() => {
    configRef.current = config;
    ownersRef.current = tokenOwners;
    connectedRef.current = connected;
    onInboxChangeRef.current = onInboxChange;
    // Turning notifications off forgets the baseline, so changes made while
    // they were off are not reported once they are back on.
    if (!onInboxChange) lastInbox.current = null;
  }, [config, tokenOwners, connected, onInboxChange]);

  /**
   * `tokenChanged`: the service whose token was just saved, so earlier
   * rejections no longer apply. Otherwise they stay until the provider answers again: the setup
   * screen they bring up must not flicker away (losing what was typed into
   * it) on every background refresh.
   */
  const refresh = useCallback(async ({ tokenChanged, inboxOnly = false }: RefreshOptions = {}) => {
    const id = ++requestId.current;
    busy.current = true;
    const startedAt = Date.now();
    if (!inboxOnly) lastFetch.current = startedAt;
    // Data read with the previous token (perhaps another account's) must not
    // come back if the new one fails, nor serve as a baseline for
    // notifications. The inbox mixes every service's items.
    if (tokenChanged) {
      delete shownKeys.current.repos[tokenChanged];
      shownKeys.current.inbox = '';
      lastInbox.current = null;
    }
    // Drop auth errors right away after a token change so a freshly saved
    // token leaves the setup screen immediately; other errors stay visible
    // until the reload finishes.
    setState((s) =>
      tokenChanged
        ? { ...s, loading: true, rejected: [], error: s.error && isAuthError(s.error) ? null : s.error }
        : { ...s, loading: true },
    );
    const { repos, inbox } = configRef.current;
    const owners = ownersRef.current;
    const live = PROVIDER_IDS.filter((p) => connectedRef.current.includes(p));
    const several = live.length > 1;
    const ownersOf = (p: ProviderId) => (providers[p].ownerTokens ? owners : []);
    const pinnedTo = (p: ProviderId) => repos.filter((r) => r.provider === p);
    // Data from one GitLab instance must not survive a switch to another.
    const instanceOf = (p: ProviderId) => (p === 'gitlab' ? connectedGitLabHost() : null);
    const keys = {
      // Per provider: one service's settings changing must not let another's
      // failure keep showing data fetched for its old settings.
      repos: (p: ProviderId) => JSON.stringify([byId(pinnedTo(p)), ownersOf(p), instanceOf(p)]),
      inbox: JSON.stringify([inbox, owners, live, live.map(instanceOf)]),
    };

    const [repoRes, inboxRes] = await Promise.all([
      settleEach<RepoBatch>(
        inboxOnly ? [] : live.filter((p) => pinnedTo(p).length > 0),
        (p) => providers[p].fetchRepos(pinnedTo(p), ownersOf(p)),
      ),
      inbox.enabled ? settleEach(live, (p) => providers[p].fetchInbox(inbox, ownersOf(p))) : Promise.resolve(null),
    ]);
    if (id !== requestId.current) return; // a newer refresh superseded this one
    busy.current = false;

    const loadedInbox = inboxRes?.flatMap((r) => (r.result.status === 'fulfilled' ? [r.result.value] : [])) ?? [];
    if (inboxRes && loadedInbox.length > 0) {
      const combined = combineInboxes(loadedInbox, inbox.limit);
      // A service that failed leaves its items out.
      const next = loadedInbox.length < inboxRes.length ? { ...combined, incomplete: true } : combined;
      const prev = lastInbox.current?.key === keys.inbox ? lastInbox.current : null;
      const onChange = onInboxChangeRef.current;
      // With results missing, those items were last seen at the previous
      // comparison time, which therefore carries over. Nothing is kept while
      // nobody watches, so turning notifications back on starts fresh.
      const at = next.incomplete && prev ? prev.at : startedAt;
      lastInbox.current = onChange ? { key: keys.inbox, at, snapshot: inboxBaseline(prev?.snapshot, next) } : null;
      if (onChange && prev) onChange(prev.snapshot, next, prev.at);
    } else if (!inboxRes) {
      lastInbox.current = null;
    }

    setState((s) => {
      // An inbox-only refresh leaves the cards, and any error about them, as they are.
      const next: DashboardState = inboxOnly
        ? { ...s, loading: false, rejected: [...s.rejected] }
        : { ...s, loading: false, error: null, rejected: [] };
      const reject = (p: ProviderId, err: AppError) => {
        if (isAuthError(err) && !next.rejected.includes(p)) next.rejected.push(p);
      };

      if (!inboxOnly) {
        // The rate limit is GitHub's: keep it only while GitHub is still
        // fetched, and replace it with whatever this refresh reported.
        if (!repoRes.some((r) => r.provider === 'github')) next.rateLimit = null;
        const fetched = repoRes.filter((r) => r.result.status === 'fulfilled');
        // Only fresh repository data counts as an update; after a failure the
        // cards still show the previous data and must not look current.
        if (repoRes.length === 0 || fetched.length > 0) next.lastUpdated = new Date();
        next.repos = new Map();
        for (const { provider, result } of repoRes) {
          const key = keys.repos(provider);
          if (result.status === 'fulfilled') {
            for (const [id, repo] of result.value.repos) next.repos.set(id, repo);
            if (result.value.rateLimit) next.rateLimit = result.value.rateLimit;
            shownKeys.current.repos[provider] = key;
          } else {
            const err = labelled(asAppError(result.reason), provider, several);
            next.error ??= err;
            reject(provider, err);
            // Keep showing this provider's previous data, unless it was fetched
            // for other settings. Next to other services' fresh data, a card
            // with nothing to show says why; alone, the error is shown instead.
            const current = shownKeys.current.repos[provider] === key;
            for (const repo of pinnedTo(provider)) {
              const shown = current ? s.repos.get(repoId(repo)) : undefined;
              if (shown) next.repos.set(repoId(repo), shown);
              else if (fetched.length > 0) {
                next.repos.set(repoId(repo), { ok: false, error: { kind: 'unknown', message: err.message } });
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

  const watchInbox = onInboxChange !== undefined;
  // Turning notifications on takes a baseline right away, so what arrives
  // before the next scheduled refresh is noticed.
  const watching = useRef(watchInbox);
  useEffect(() => {
    const was = watching.current;
    watching.current = watchInbox;
    if (enabled && watchInbox && !was && !busy.current) void refresh({ inboxOnly: true });
  }, [enabled, watchInbox, refresh]);

  useEffect(() => {
    if (!enabled || config.refreshMinutes <= 0) return;
    const intervalMs = config.refreshMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
      // While hidden, only "Needs you" keeps updating, and only to notify.
      else if (watchInbox && !busy.current) void refresh({ inboxOnly: true });
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetch.current > intervalMs) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, config.refreshMinutes, refresh, watchInbox]);

  return { ...state, refresh };
}
