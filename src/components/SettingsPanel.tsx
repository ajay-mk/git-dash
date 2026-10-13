import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ConfigError,
  defaultWidget,
  defaultWidgets,
  isValidOwner,
  MAX_ITEMS,
  MAX_REPOS,
  MIN_ITEMS,
  parseConfig,
  parseGitLabInput,
  parseRepoInput,
  providerOfInput,
  PR_GROUPING_LABELS,
  PR_GROUPINGS,
  REFRESH_CHOICES,
  repoId,
  THEMES,
  WIDGET_LABELS,
  WIDGET_TYPES,
  type DashboardConfig,
  type PinnedRepo,
  type PrGrouping,
  type WidgetConfig,
  type WidgetType,
} from '../config/schema';
import { canNotify } from '../lib/notify';
import { matchRepos } from '../lib/suggest';
import { tokens, type OwnerToken, type TokenSummary } from '../lib/transport';
import { connectedGitLabHost } from '../lib/url';
import { providers } from '../providers';
import { PROVIDER_IDS, type ProviderId } from '../providers/types';
import { ExternalLink } from './ExternalLink';
import { PermissionList } from './PermissionList';

type Update = (fn: (c: DashboardConfig) => DashboardConfig) => void;

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  // Keeps what is typed until blur, so the field can be cleared before typing
  // a new number instead of snapping back to the minimum.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="inline-field">
      {label}
      <input
        type="number"
        min={MIN_ITEMS}
        max={MAX_ITEMS}
        value={draft ?? value}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) {
            onChange(Math.min(MAX_ITEMS, Math.max(MIN_ITEMS, Math.round(n))));
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

function LabelField({ value, onChange }: { value: string | null; onChange: (label: string | null) => void }) {
  // The saved label is trimmed, so the field keeps what is typed until blur;
  // otherwise trimming on each keystroke would swallow the spaces in a
  // multi-word label.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="inline-field">
      Label
      <input
        type="text"
        maxLength={50}
        placeholder="any"
        value={draft ?? value ?? ''}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value.trim() || null);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

function WidgetEditor({ repo, onChange }: { repo: PinnedRepo; onChange: (widgets: WidgetConfig[]) => void }) {
  const byType = new Map(repo.widgets.map((w) => [w.type, w]));

  const toggle = (type: WidgetType, on: boolean) => {
    if (on) {
      // Keep the canonical order so cards look consistent.
      const next = WIDGET_TYPES.map((t) => (t === type ? defaultWidget(t) : byType.get(t))).filter(
        (w): w is WidgetConfig => w !== undefined,
      );
      onChange(next);
    } else {
      onChange(repo.widgets.filter((w) => w.type !== type));
    }
  };
  const patch = (next: WidgetConfig) => onChange(repo.widgets.map((w) => (w.type === next.type ? next : w)));

  return (
    <div className="widget-editor">
      {WIDGET_TYPES.map((type) => {
        const widget = byType.get(type);
        return (
          <div key={type} className="widget-option">
            <label className="check">
              <input type="checkbox" checked={!!widget} onChange={(e) => toggle(type, e.target.checked)} />
              {WIDGET_LABELS[type]}
            </label>
            {widget?.type === 'pullRequests' && (
              <div className="widget-settings">
                <NumberField label="Show" value={widget.limit} onChange={(limit) => patch({ ...widget, limit })} />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={widget.hideDrafts}
                    onChange={(e) => patch({ ...widget, hideDrafts: e.target.checked })}
                  />
                  Hide drafts
                </label>
              </div>
            )}
            {widget?.type === 'issues' && (
              <div className="widget-settings">
                <NumberField label="Show" value={widget.limit} onChange={(limit) => patch({ ...widget, limit })} />
                <LabelField value={widget.label} onChange={(label) => patch({ ...widget, label })} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const MAX_SUGGESTIONS = 8;
const NO_OWNERS: readonly string[] = [];

/**
 * Text field for the repository to pin, suggesting repositories the stored
 * tokens can see. Suggestions load when the field is first focused, and again
 * after the stored tokens change.
 */
function RepoInput({
  provider,
  value,
  onChange,
  onPick,
  pinned,
  tokenOwners,
}: {
  provider: ProviderId;
  value: string;
  onChange: (value: string) => void;
  onPick: (name: string) => void;
  pinned: ReadonlySet<string>;
  tokenOwners: readonly string[];
}) {
  const listId = useId();
  const [repos, setRepos] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const loadedFor = useRef<{ provider: ProviderId; owners: readonly string[] } | null>(null);

  function load() {
    // The token list is reloaded whenever a token is added, replaced or
    // removed, so a new array means the suggestions may be stale.
    const key = { provider, owners: tokenOwners };
    const last = loadedFor.current;
    if (last?.provider === provider && last.owners === tokenOwners) return;
    loadedFor.current = key;
    setRepos([]);
    providers[provider].listRepos(tokenOwners).then(
      ({ repos: names, complete }) => {
        if (loadedFor.current !== key) return;
        setRepos(names);
        // Keep what loaded, but let the next focus retry the failed tokens.
        if (!complete) loadedFor.current = null;
      },
      () => {
        // Let the next focus try again.
        if (loadedFor.current === key) loadedFor.current = null;
      },
    );
  }

  const matches = useMemo(() => matchRepos(repos, value, pinned, MAX_SUGGESTIONS), [repos, value, pinned]);
  const expanded = open && matches.length > 0;
  const current = expanded && active >= 0 && active < matches.length ? active : -1;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(e.key === 'ArrowDown' ? 0 : -1);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.min(matches.length - 1, Math.max(-1, current + step)));
    } else if (e.key === 'Enter' && current >= 0) {
      e.preventDefault();
      onPick(matches[current]!);
      setActive(-1);
    } else if (e.key === 'Escape' && expanded) {
      // Close the list, not the settings dialog.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="combobox">
      <input
        type="text"
        role="combobox"
        aria-label="Repository to pin"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        placeholder={provider === 'gitlab' ? 'group/project or GitLab URL' : 'owner/name or GitHub URL'}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <ul id={listId} role="listbox" aria-label="Suggested repositories" className="combobox-list">
          {matches.map((name, i) => (
            <li
              key={name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className="combobox-option"
              // Keep focus in the field so the list does not close before the click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                onPick(name);
                setActive(-1);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepoList({
  config,
  update,
  tokenOwners,
  connected,
}: {
  config: DashboardConfig;
  update: Update;
  tokenOwners: readonly string[];
  connected: readonly ProviderId[];
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ProviderId | null>(null);
  const gitlabHost = connectedGitLabHost();
  // A pasted URL picks its own service; otherwise the chosen one is used.
  const fallback = chosen && connected.includes(chosen) ? chosen : (connected[0] ?? 'github');
  const provider = providerOfInput(input, gitlabHost) ?? fallback;
  const pinned = useMemo(
    () => new Set(config.repos.filter((r) => r.provider === provider).map((r) => `${r.owner}/${r.name}`.toLowerCase())),
    [config.repos, provider],
  );

  function pin(text: string) {
    const target = providerOfInput(text, gitlabHost) ?? fallback;
    const parsed = target === 'gitlab' ? parseGitLabInput(text, gitlabHost ?? '') : parseRepoInput(text);
    if (!parsed) {
      return setError(
        target === 'gitlab'
          ? 'Enter a project as group/project or a link to it.'
          : 'Enter a repository as owner/name or a github.com URL.',
      );
    }
    if (!connected.includes(target)) return setError(`Connect ${providers[target].label} first, under Access tokens.`);
    const repo: PinnedRepo = { provider: target, ...parsed, widgets: defaultWidgets() };
    if (config.repos.some((r) => repoId(r) === repoId(repo))) return setError('Already pinned.');
    if (config.repos.length >= MAX_REPOS) return setError(`You can pin up to ${MAX_REPOS} repositories.`);
    update((c) => ({ ...c, repos: [...c.repos, repo] }));
    setInput('');
    setError(null);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    pin(input);
  }

  const move = (index: number, delta: number) =>
    update((c) => {
      const repos = [...c.repos];
      const target = index + delta;
      if (target < 0 || target >= repos.length) return c;
      [repos[index], repos[target]] = [repos[target]!, repos[index]!];
      return { ...c, repos };
    });

  const remove = (id: string) => update((c) => ({ ...c, repos: c.repos.filter((r) => repoId(r) !== id) }));

  const setWidgets = (id: string, widgets: WidgetConfig[]) =>
    update((c) => ({ ...c, repos: c.repos.map((r) => (repoId(r) === id ? { ...r, widgets } : r)) }));

  return (
    <>
      <form className="add-repo" onSubmit={add}>
        {connected.length > 1 && (
          <select
            aria-label="Service"
            value={provider}
            onChange={(e) => setChosen(PROVIDER_IDS.find((p) => p === e.target.value) ?? null)}
          >
            {connected.map((p) => (
              <option key={p} value={p}>
                {providers[p].label}
              </option>
            ))}
          </select>
        )}
        <RepoInput
          provider={provider}
          value={input}
          onChange={setInput}
          onPick={pin}
          pinned={pinned}
          tokenOwners={provider === 'github' ? tokenOwners : NO_OWNERS}
        />
        <button type="submit" className="btn btn-primary">
          Pin
        </button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
      {config.repos.length === 0 && <p className="empty">No repositories pinned yet.</p>}
      <ol className="repo-list">
        {config.repos.map((repo, i) => {
          const id = repoId(repo);
          const open = expanded === id;
          return (
            <li key={id} className="repo-item">
              <div className="repo-item-row">
                <button
                  type="button"
                  className="link-btn repo-item-name"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : id)}
                >
                  {open ? '▾' : '▸'} {repo.owner}/{repo.name}
                  {repo.provider !== 'github' && <span className="badge badge-muted">{providers[repo.provider].label}</span>}
                </button>
                <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Move down"
                  disabled={i === config.repos.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button type="button" className="icon-btn danger" aria-label={`Unpin ${repo.owner}/${repo.name}`} onClick={() => remove(id)}>
                  ✕
                </button>
              </div>
              {open && <WidgetEditor repo={repo} onChange={(w) => setWidgets(id, w)} />}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Backup({ config, update }: { config: DashboardConfig; update: Update }) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function doImport() {
    try {
      const next = parseConfig(JSON.parse(text));
      update(() => next);
      setMessage({ ok: true, text: `Imported ${next.repos.length} repositories.` });
      setText('');
    } catch (err) {
      const msg = err instanceof ConfigError || err instanceof SyntaxError ? err.message : 'Invalid config';
      setMessage({ ok: false, text: msg });
    }
  }

  return (
    <>
      <p className="hint">The configuration contains no secrets; your token is never included.</p>
      <textarea
        aria-label="Configuration JSON"
        rows={6}
        spellCheck={false}
        value={text}
        placeholder="Paste a configuration to import, or click Export."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        <button type="button" className="btn" onClick={() => setText(JSON.stringify(config, null, 2))}>
          Export
        </button>
        <button
          type="button"
          className="btn"
          disabled={!text}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(
              () => setMessage({ ok: true, text: 'Copied to clipboard.' }),
              () => setMessage({ ok: false, text: 'Could not access the clipboard.' }),
            );
          }}
        >
          Copy
        </button>
        <button type="button" className="btn btn-primary" disabled={!text} onClick={doImport}>
          Import
        </button>
      </div>
      {message && <p className={message.ok ? 'ok-text' : 'error-text'}>{message.text}</p>}
    </>
  );
}

function TokenActions({ provider, onChangeToken, onSignOut }: {
  provider: ProviderId;
  onChangeToken: (provider: ProviderId) => void;
  onSignOut: (provider: ProviderId) => void;
}) {
  const label = providers[provider].label;
  return (
    <div className="actions">
      <button type="button" className="btn" onClick={() => onChangeToken(provider)}>
        Replace {label} token
      </button>
      <button type="button" className="btn btn-danger" onClick={() => onSignOut(provider)}>
        Remove {label} token
      </button>
    </div>
  );
}

function NotConnected({
  provider,
  error,
  onConnect,
}: {
  provider: ProviderId;
  /** Why the stored token could not be read, if that is what happened. */
  error?: string | undefined;
  onConnect: (provider: ProviderId) => void;
}) {
  const label = providers[provider].label;
  return (
    <div className="token-item">
      {error ? (
        <span className="token-item-name error-text">Could not read the token: {error}</span>
      ) : (
        <span className="token-item-name muted">Not connected</span>
      )}
      <button type="button" className="btn" onClick={() => onConnect(provider)}>
        Connect {label}
      </button>
    </div>
  );
}

const MAX_OWNER_TOKENS = 20;

/**
 * Per-owner tokens: fine-grained GitHub tokens only cover one account or
 * organization, so each owner can get its own. Only the owner and the login
 * GitHub reports for the token are ever shown; tokens cannot be read back.
 */
function OwnerTokens({ owners, onChanged }: { owners: OwnerToken[]; onChanged: () => void }) {
  const [owner, setOwner] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);

  const replacing = owners.some((o) => o.owner === owner.trim().toLowerCase());
  const target = isValidOwner(owner.trim()) ? owner.trim() : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const name = owner.trim();
    if (!isValidOwner(name)) return setError('Enter a GitHub account or organization name, e.g. acme.');
    if (!replacing && owners.length >= MAX_OWNER_TOKENS) {
      return setError(`You can add up to ${MAX_OWNER_TOKENS} tokens.`);
    }
    setBusy(true);
    setError(null);
    try {
      await tokens.set('github', token, name);
      setOwner('');
      setToken('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save token');
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setError(null);
    try {
      await tokens.clear('github', name);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove token');
    }
  }

  return (
    <>
      <p className="hint">
        Fine-grained tokens cover a single account or organization. Add one per owner and GitDash uses it for
        that owner&apos;s repositories; everything else uses the default token. Each token needs read-only{' '}
        <PermissionList permissions={providers.github.tokenPermissions} />.{' '}
        <ExternalLink href={providers.github.newTokenUrl(target)}>
          {target ? `Create a token for ${target}` : 'Create a token'}
        </ExternalLink>
      </p>
      {owners.length > 0 && (
        <ul className="token-list">
          {owners.map((o) => (
            <li key={o.owner} className="token-item">
              <span className="token-item-name">
                <strong>{o.owner}</strong> <span className="muted">via {o.login}</span>
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOwner(o.owner);
                  setToken('');
                  tokenInput.current?.focus();
                }}
              >
                Replace
              </button>
              <button
                type="button"
                className="icon-btn danger"
                aria-label={`Remove token for ${o.owner}`}
                onClick={() => void remove(o.owner)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="token-form" onSubmit={save}>
        <input
          type="text"
          aria-label="Account or organization"
          placeholder="Account or organization"
          spellCheck={false}
          autoComplete="off"
          maxLength={39}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        />
        <input
          ref={tokenInput}
          type="password"
          aria-label="Access token for this owner"
          placeholder="github_pat_…"
          spellCheck={false}
          autoComplete="off"
          maxLength={255}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || owner.trim().length === 0 || token.trim().length === 0}
        >
          {busy ? 'Verifying…' : replacing ? 'Replace' : 'Add'}
        </button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
    </>
  );
}

export function SettingsPanel({
  open,
  onClose,
  config,
  update,
  accounts,
  accountErrors = {},
  ownerTokens,
  onChangeToken,
  onSignOut,
  onOwnerTokensChanged,
}: {
  open: boolean;
  onClose: () => void;
  config: DashboardConfig;
  update: Update;
  /** What is stored for each service; `null` when it could not be read. */
  accounts: Record<ProviderId, TokenSummary | null>;
  /** Services whose stored token could not be read, with the reason. */
  accountErrors?: Partial<Record<ProviderId, string>>;
  ownerTokens: OwnerToken[];
  /** Connects a service, or replaces its token. */
  onChangeToken: (provider: ProviderId) => void;
  onSignOut: (provider: ProviderId) => void;
  onOwnerTokensChanged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tokenOwners = useMemo(() => ownerTokens.map((o) => o.owner), [ownerTokens]);
  const connected = useMemo(() => PROVIDER_IDS.filter((p) => accounts[p]?.hasDefault), [accounts]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const inbox = config.inbox;
  const setInbox = (patch: Partial<typeof inbox>) => update((c) => ({ ...c, inbox: { ...c.inbox, ...patch } }));

  return (
    <dialog
      ref={ref}
      className="settings"
      aria-label="Settings"
      onClose={onClose}
      onClick={(e) => {
        // Clicking the backdrop closes the panel.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="settings-inner">
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </header>

        <section className="settings-section">
          <h3>Pinned repositories</h3>
          <RepoList config={config} update={update} tokenOwners={tokenOwners} connected={connected} />
        </section>

        <section className="settings-section">
          <h3>Needs you</h3>
          <label className="check">
            <input type="checkbox" checked={inbox.enabled} onChange={(e) => setInbox({ enabled: e.target.checked })} />
            Show sidebar
          </label>
          <fieldset disabled={!inbox.enabled} className="plain">
            <label className="check">
              <input
                type="checkbox"
                checked={inbox.reviewRequests}
                onChange={(e) => setInbox({ reviewRequests: e.target.checked })}
              />
              Review requests
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={inbox.myPullRequests}
                onChange={(e) => setInbox({ myPullRequests: e.target.checked })}
              />
              Your pull requests
            </label>
            <label className="inline-field nested-field">
              Group by
              <select
                value={config.layout.groupMyPullRequests}
                disabled={!inbox.myPullRequests}
                onChange={(e) => {
                  const groupMyPullRequests = e.target.value as PrGrouping;
                  update((c) => ({ ...c, layout: { ...c.layout, groupMyPullRequests } }));
                }}
              >
                {PR_GROUPINGS.map((g) => (
                  <option key={g} value={g}>
                    {PR_GROUPING_LABELS[g]}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={inbox.assigned} onChange={(e) => setInbox({ assigned: e.target.checked })} />
              Assigned to you
            </label>
            <NumberField label="Items per group" value={inbox.limit} onChange={(limit) => setInbox({ limit })} />
            <label className="check">
              <input
                type="checkbox"
                checked={config.notifications}
                onChange={(e) => {
                  const notifications = e.target.checked;
                  update((c) => ({ ...c, notifications }));
                  // Ask the OS now, while the user is looking, rather than when
                  // the first notification arrives.
                  if (notifications) void canNotify().catch(() => undefined);
                }}
              />
              Desktop notifications for new items
            </label>
          </fieldset>
          <p className="hint">
            Fetched from every connected service. On GitHub, that is the default token plus any per-owner tokens
            that belong to the same account; items only visible to a token for another account are not shown.
          </p>
        </section>

        <section className="settings-section">
          <h3>General</h3>
          <label className="inline-field">
            Refresh
            <select
              value={config.refreshMinutes}
              onChange={(e) => update((c) => ({ ...c, refreshMinutes: Number(e.target.value) }))}
            >
              {REFRESH_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Manually' : `Every ${m} min`}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            Theme
            <select
              value={config.theme}
              onChange={(e) => {
                const theme = THEMES.find((t) => t === e.target.value);
                if (theme) update((c) => ({ ...c, theme }));
              }}
            >
              {THEMES.map((t) => (
                <option key={t} value={t}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Access tokens</h3>
          <h4>GitHub</h4>
          {accounts.github?.hasDefault ? (
            <>
              <p>
                {accounts.github.defaultLogin ? (
                  <>Default token: GitHub account <strong>{accounts.github.defaultLogin}</strong>.</>
                ) : (
                  'Default token is set.'
                )}
              </p>
              <p className="hint">Used for the &ldquo;Needs you&rdquo; sidebar and any owner without its own token.</p>
              <TokenActions provider="github" onChangeToken={onChangeToken} onSignOut={onSignOut} />
              <h4>Per-owner tokens</h4>
              <OwnerTokens owners={ownerTokens} onChanged={onOwnerTokensChanged} />
            </>
          ) : (
            <>
              <NotConnected provider="github" error={accountErrors.github} onConnect={onChangeToken} />
              {/* Removing the default token keeps per-owner ones; they must stay removable. */}
              {ownerTokens.length > 0 && (
                <>
                  <h4>Per-owner tokens</h4>
                  <OwnerTokens owners={ownerTokens} onChanged={onOwnerTokensChanged} />
                </>
              )}
            </>
          )}
          <h4>GitLab</h4>
          {accounts.gitlab?.hasDefault ? (
            <>
              <p>
                Connected to <strong>{accounts.gitlab.host ?? 'GitLab'}</strong>
                {accounts.gitlab.defaultLogin && <> as <strong>{accounts.gitlab.defaultLogin}</strong></>}.
              </p>
              <p className="hint">One token covers every group and project your GitLab account can see.</p>
              <TokenActions provider="gitlab" onChangeToken={onChangeToken} onSignOut={onSignOut} />
            </>
          ) : (
            <NotConnected provider="gitlab" error={accountErrors.gitlab} onConnect={onChangeToken} />
          )}
        </section>

        <section className="settings-section">
          <h3>Backup</h3>
          <Backup config={config} update={update} />
        </section>
      </div>
    </dialog>
  );
}
