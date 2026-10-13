import { useCallback, useEffect, useMemo, useState } from 'react';
import logo from './assets/logo.svg';
import { InboxPanel } from './components/InboxPanel';
import { RepoCard } from './components/RepoCard';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenSetup } from './components/TokenSetup';
import {
  pruneLayout,
  repoId,
  shiftListLimits,
  widgetKey,
  WIDGET_TYPES,
  type DashboardConfig,
  type PinnedRepo,
  type WidgetType,
} from './config/schema';
import { loadConfig, saveConfig } from './config/storage';
import { providers } from './providers';
import { isAuthError, useDashboard, type InboxChangeHandler } from './hooks/useDashboard';
import { useCardResize } from './hooks/useCardResize';
import { useMasonry } from './hooks/useMasonry';
import { useReorder } from './hooks/useReorder';
import { repoHealth } from './lib/health';
import { inboxAlerts, SeenItems, showAlerts } from './lib/notify';
import { shortAgo } from './lib/time';
import { tokens, type TokenSummary } from './lib/transport';

type AuthState = 'checking' | 'missing' | 'ready' | 'replacing';

export default function App() {
  const [config, setConfig] = useState<DashboardConfig>(loadConfig);
  const [auth, setAuth] = useState<AuthState>('checking');
  const [authReason, setAuthReason] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<TokenSummary | null>(null);
  // Re-renders relative times such as "Updated 5m" as they age.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const update = useCallback((fn: (c: DashboardConfig) => DashboardConfig) => {
    setConfig((prev) => {
      // Removing a repo or widget in settings also forgets that it was collapsed.
      const next = pruneLayout(fn(prev));
      saveConfig(next);
      return next;
    });
  }, []);

  const reloadTokens = useCallback(async () => {
    const info = await tokens.list('github');
    setTokenInfo(info);
    return info;
  }, []);

  useEffect(() => {
    tokens.list('github').then(
      (info) => {
        setTokenInfo(info);
        setAuth(info.hasDefault ? 'ready' : 'missing');
      },
      (err: Error) => {
        setAuthReason(err.message);
        setAuth('missing');
      },
    );
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (config.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = config.theme;
  }, [config.theme]);

  const tokenOwners = useMemo(() => tokenInfo?.owners.map((o) => o.owner) ?? [], [tokenInfo]);
  const [seenItems] = useState(() => new SeenItems());
  const onInboxChange = useCallback<InboxChangeHandler>(
    (prev, next, since) => {
      seenItems.remember(prev);
      const alerts = inboxAlerts(prev, next, since, seenItems);
      seenItems.remember(next);
      void showAlerts(alerts).catch(() => undefined);
    },
    [seenItems],
  );
  // Notifications come from the "Needs you" lists, so they need the sidebar on.
  const notify = config.notifications && config.inbox.enabled;
  const dash = useDashboard(config, tokenOwners, auth === 'ready', notify ? onInboxChange : undefined);
  const loadDetails = useCallback((url: string) => providers.github.fetchDetails(url, tokenOwners), [tokenOwners]);

  // A revoked or expired token sends the user back to the setup screen.
  const tokenRejected = isAuthError(dash.error);

  const repoIds = useMemo(() => config.repos.map(repoId), [config.repos]);
  const reposById = useMemo(() => new Map(config.repos.map((r) => [repoId(r), r])), [config.repos]);
  const repoLabel = useCallback(
    (id: string) => {
      const r = reposById.get(id);
      return r ? `${r.owner}/${r.name}` : id;
    },
    [reposById],
  );
  const reorder = useReorder(
    repoIds,
    (ids) =>
      update((c) => {
        const rank = new Map(ids.map((id, i) => [id, i]));
        // Repos missing from `ids` (added mid-drag) keep their place at the end.
        const at = (id: string) => rank.get(id) ?? ids.length;
        return { ...c, repos: [...c.repos].sort((a, b) => at(repoId(a)) - at(repoId(b))) };
      }),
    repoLabel,
  );
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  useMasonry(grid);
  const resize = useCardResize({
    grid,
    onSpan: (id, span) =>
      update((c) => {
        const cardSpans = { ...c.layout.cardSpans };
        if (span > 1) cardSpans[id] = span;
        else delete cardSpans[id];
        return { ...c, layout: { ...c.layout, cardSpans } };
      }),
    onHeight: (id, rows) =>
      update((c) => {
        const cardRows = { ...c.layout.cardRows };
        if (rows === null) delete cardRows[id];
        else cardRows[id] = rows;
        return { ...c, layout: { ...c.layout, cardRows } };
      }),
    onFold: (id, collapsed) =>
      update((c) => {
        const repo = c.repos.find((r) => repoId(r) === id);
        if (!repo) return c;
        const keys = new Set(WIDGET_TYPES.map((t) => widgetKey(repo, t)));
        const others = c.layout.collapsedWidgets.filter((k) => !keys.has(k));
        return { ...c, layout: { ...c.layout, collapsedWidgets: [...others, ...collapsed.map((t) => widgetKey(repo, t))] } };
      }),
    onRows: (id, delta, collapsed) => {
      // Collapsed lists are not part of the card's height, so they keep their limit.
      const repo = reposById.get(id);
      if (!repo) return false;
      const widgets = shiftListLimits(repo.widgets, delta, collapsed);
      if (widgets.every((w, i) => w === repo.widgets[i])) return false;
      update((c) => ({
        ...c,
        repos: c.repos.map((r) => (repoId(r) === id ? { ...r, widgets: shiftListLimits(r.widgets, delta, collapsed) } : r)),
      }));
      return true;
    },
    describe: (id, span, delta, collapsed) => {
      const repo = reposById.get(id);
      return `${repoLabel(id)} is ${span} ${span === 1 ? 'column' : 'columns'} wide${repo ? `, ${entriesText(repo, delta, collapsed)}` : ''}.`;
    },
  });

  const summary = useMemo(() => {
    let failing = 0;
    let attention = 0;
    for (const repo of config.repos) {
      const h = repoHealth(dash.repos.get(repoId(repo)));
      if (h === 'failing' || h === 'error') failing++;
      else if (h === 'attention') attention++;
    }
    return { failing, attention, reviews: dash.inbox?.reviewRequests.total ?? 0 };
  }, [config.repos, dash.repos, dash.inbox]);

  if (auth === 'checking') return <main className="setup"><p className="empty">Loading…</p></main>;
  if (auth === 'missing' || auth === 'replacing' || tokenRejected) {
    const reason = tokenRejected ? 'Your token was rejected or is missing. Please add a new one.' : authReason;
    return (
      <TokenSetup
        reason={auth === 'replacing' ? null : reason}
        onDone={() => {
          setAuthReason(null);
          setAuth('ready');
          void reloadTokens().catch(() => undefined);
          void dash.refresh({ tokensChanged: true });
        }}
        {...(auth === 'replacing' ? { onCancel: () => setAuth('ready') } : {})}
      />
    );
  }

  return (
    <div className={`app${config.inbox.enabled ? ' with-sidebar' : ''}`}>
      <header className="topbar">
        <h1 className="brand">
          <img className="brand-logo" src={logo} alt="" />
          GitDash
        </h1>
        <div className="summary" aria-live="polite">
          {summary.failing > 0 && <span className="pill pill-bad">{summary.failing} failing</span>}
          {summary.attention > 0 && <span className="pill pill-warn">{summary.attention} need attention</span>}
          {config.inbox.enabled && config.inbox.reviewRequests && summary.reviews > 0 && (
            <span className="pill pill-info">{summary.reviews} reviews requested</span>
          )}
          {summary.failing + summary.attention + summary.reviews === 0 && dash.lastUpdated && !dash.error && (
            <span className="pill pill-ok">All clear</span>
          )}
        </div>
        <div className="topbar-actions">
          {dash.rateLimit && dash.rateLimit.remaining < dash.rateLimit.limit * 0.1 && (
            <span className="meta warn" title="GitHub API rate limit">
              API {dash.rateLimit.remaining}/{dash.rateLimit.limit}
            </span>
          )}
          {dash.lastUpdated && (
            <span className="meta" title={dash.lastUpdated.toLocaleString()}>
              Updated {shortAgo(dash.lastUpdated.toISOString(), now)}
            </span>
          )}
          <button type="button" className="btn" onClick={() => void dash.refresh()} disabled={dash.loading}>
            {dash.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {config.inbox.enabled && (
        <InboxPanel
          config={config.inbox}
          layout={config.layout}
          onLayoutChange={(fn) => update((c) => ({ ...c, layout: fn(c.layout) }))}
          inbox={dash.inbox}
          error={dash.inboxError}
          loadDetails={loadDetails}
        />
      )}

      <main className="content">
        {signOutError && <p className="banner error-text">{signOutError}</p>}
        {dash.error && <p className="banner error-text">{dash.error.message}</p>}
        {config.repos.length === 0 ? (
          <div className="empty-state">
            <h2>Pin your first repository</h2>
            <p>Pick the repositories you care about and choose what each card shows.</p>
            <button type="button" className="btn btn-primary" onClick={() => setSettingsOpen(true)}>
              Open settings
            </button>
          </div>
        ) : (
          <>
            <p id="reorder-help" className="sr-only">Drag to reorder, or use the arrow keys.</p>
            <p id="resize-help" className="sr-only">
              Drag to resize. Left and right arrows change the width, up and down change the height and how many entries show. Shrinking past one entry folds the lists, and growing opens them again. Delete lets the card fit its content again.
            </p>
            <p className="sr-only" aria-live="polite">{reorder.announcement}</p>
            <p className="sr-only" aria-live="polite">{resize.announcement}</p>
            <div ref={setGrid} className={`grid${reorder.dragging ? ' reordering' : ''}${resize.resizing ? ' resizing' : ''}`}>
              {reorder.order.map((id) => reposById.get(id)).filter((r) => r !== undefined).map((repo) => {
                const id = repoId(repo);
                const collapsedWidgets = collapsedTypes(config, repo);
                const span = Math.min(config.layout.cardSpans[id] ?? 1, resize.columns);
                const resizing = resize.resizing?.id === id ? resize.resizing : null;
                const result = dash.repos.get(id);
                const data = result?.ok ? result.data : null;
                const sections = repo.widgets.flatMap((w) => {
                  if (w.type === 'ci') return [];
                  // A loaded list may hold fewer entries than its limit; an empty one shows a message.
                  const items = data?.[w.type]?.items.length;
                  const rows = items === undefined ? w.limit : Math.max(1, Math.min(items, w.limit));
                  return [{ type: w.type, limit: w.limit, rows, collapsed: collapsedWidgets.includes(w.type) }];
                });
                return (
                  <RepoCard
                    key={id}
                    repo={repo}
                    dragging={reorder.dragging === id}
                    span={span}
                    rows={config.layout.cardRows[id]}
                    resize={resizing}
                    grip={
                      <>
                        {resizing && (
                          <span className="resize-hint" aria-hidden="true">
                            {resizing.span} {resizing.span === 1 ? 'column' : 'columns'} · {entriesText(repo, resizing.delta, resizing.collapsed)}
                          </span>
                        )}
                        <button type="button" className="resize-grip" title="Drag to resize, double-click to fit the content" {...resize.gripProps(id, repoLabel(id), span, sections)} />
                      </>
                    }
                    handle={
                      config.repos.length > 1 && (
                        <button type="button" className="icon-btn drag-handle" title="Drag to reorder" {...reorder.handleProps(repoId(repo))}>
                          ⠿
                        </button>
                      )
                    }
                    result={result}
                    collapsedWidgets={collapsedWidgets}
                    onToggleWidget={(type) => {
                      const key = widgetKey(repo, type);
                      update((c) => {
                        const collapsed = c.layout.collapsedWidgets;
                        return {
                          ...c,
                          layout: {
                            ...c.layout,
                            collapsedWidgets: collapsed.includes(key)
                              ? collapsed.filter((k) => k !== key)
                              : [...collapsed, key],
                          },
                        };
                      });
                    }}
                  />
                );
              })}
            </div>
          </>
        )}
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        update={update}
        viewer={tokenInfo?.defaultLogin ?? (dash.inbox?.viewer || null)}
        ownerTokens={tokenInfo?.owners ?? []}
        onOwnerTokensChanged={() => {
          const before = tokenOwners.join(',');
          void reloadTokens().then(
            (info) => {
              // A changed owner set refetches on its own; a replaced token does not.
              if (info.owners.map((o) => o.owner).join(',') === before) void dash.refresh({ tokensChanged: true });
            },
            () => undefined,
          );
        }}
        onChangeToken={() => {
          setSettingsOpen(false);
          setAuth('replacing');
        }}
        onSignOut={() => {
          setSettingsOpen(false);
          setSignOutError(null);
          // Only leave the dashboard once the keychain entry is really gone;
          // otherwise the token would quietly come back on the next launch.
          tokens.clear('github').then(
            () => {
              setAuthReason(null);
              setAuth('missing');
              void reloadTokens().catch(() => undefined);
            },
            (err: Error) => setSignOutError(`Could not remove the token: ${err.message}`),
          );
        }}
      />
    </div>
  );
}

/** Widget types collapsed on a repo's card. */
function collapsedTypes(config: DashboardConfig, repo: PinnedRepo): WidgetType[] {
  return WIDGET_TYPES.filter((t) => config.layout.collapsedWidgets.includes(widgetKey(repo, t)));
}

/** "5 entries" or "5 pull requests, 3 issues" for a card's open lists after `delta`. */
function entriesText(repo: PinnedRepo, delta: number, collapsed: readonly WidgetType[]): string {
  const limits = shiftListLimits(repo.widgets, delta).flatMap((w) =>
    w.type === 'ci' || collapsed.includes(w.type) ? [] : [{ type: w.type, limit: w.limit }],
  );
  if (limits.length === 0) return repo.widgets.some((w) => w.type !== 'ci') ? 'lists folded' : 'no lists';
  const first = limits[0]!.limit;
  if (limits.every((l) => l.limit === first)) return `${first} ${first === 1 ? 'entry' : 'entries'}`;
  return limits.map((l) => `${l.limit} ${l.type === 'pullRequests' ? 'pull requests' : 'issues'}`).join(', ');
}
