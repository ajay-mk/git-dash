import { useCallback, useEffect, useMemo, useState } from 'react';
import { InboxPanel } from './components/InboxPanel';
import { RepoCard } from './components/RepoCard';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenSetup } from './components/TokenSetup';
import { repoId, type DashboardConfig } from './config/schema';
import { loadConfig, saveConfig } from './config/storage';
import { isAuthError, useDashboard } from './hooks/useDashboard';
import { repoHealth } from './lib/health';
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
      const next = fn(prev);
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
  const dash = useDashboard(config, tokenOwners, auth === 'ready');

  // A revoked or expired token sends the user back to the setup screen.
  const tokenRejected = isAuthError(dash.error);

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
          void dash.refresh();
        }}
        {...(auth === 'replacing' ? { onCancel: () => setAuth('ready') } : {})}
      />
    );
  }

  return (
    <div className={`app${config.inbox.enabled ? ' with-sidebar' : ''}`}>
      <header className="topbar">
        <h1 className="brand">git-dash</h1>
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
          view={config.inboxView}
          onViewChange={(fn) => update((c) => ({ ...c, inboxView: fn(c.inboxView) }))}
          inbox={dash.inbox}
          error={dash.inboxError}
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
          <div className="grid">
            {config.repos.map((repo) => (
              <RepoCard key={repoId(repo)} repo={repo} result={dash.repos.get(repoId(repo))} />
            ))}
          </div>
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
              if (info.owners.map((o) => o.owner).join(',') === before) void dash.refresh();
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
