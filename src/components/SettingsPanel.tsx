import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ConfigError,
  defaultWidget,
  defaultWidgets,
  MAX_ITEMS,
  MAX_REPOS,
  MIN_ITEMS,
  parseConfig,
  parseRepoInput,
  REFRESH_CHOICES,
  repoId,
  THEMES,
  WIDGET_LABELS,
  WIDGET_TYPES,
  type DashboardConfig,
  type PinnedRepo,
  type WidgetConfig,
  type WidgetType,
} from '../config/schema';

type Update = (fn: (c: DashboardConfig) => DashboardConfig) => void;

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="inline-field">
      {label}
      <input
        type="number"
        min={MIN_ITEMS}
        max={MAX_ITEMS}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(MAX_ITEMS, Math.max(MIN_ITEMS, Math.round(n))));
        }}
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
                <label className="inline-field">
                  Label
                  <input
                    type="text"
                    maxLength={50}
                    placeholder="any"
                    value={widget.label ?? ''}
                    onChange={(e) => patch({ ...widget, label: e.target.value.trim() || null })}
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RepoList({ config, update }: { config: DashboardConfig; update: Update }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  function add(e: FormEvent) {
    e.preventDefault();
    const parsed = parseRepoInput(input);
    if (!parsed) return setError('Enter a repository as owner/name or a github.com URL.');
    const repo: PinnedRepo = { provider: 'github', ...parsed, widgets: defaultWidgets() };
    if (config.repos.some((r) => repoId(r) === repoId(repo))) return setError('Already pinned.');
    if (config.repos.length >= MAX_REPOS) return setError(`You can pin up to ${MAX_REPOS} repositories.`);
    update((c) => ({ ...c, repos: [...c.repos, repo] }));
    setInput('');
    setError(null);
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
        <input
          type="text"
          aria-label="Repository to pin"
          placeholder="owner/name or GitHub URL"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
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

export function SettingsPanel({ open, onClose, config, update, viewer, onChangeToken, onSignOut }: {
  open: boolean;
  onClose: () => void;
  config: DashboardConfig;
  update: Update;
  viewer: string | null;
  onChangeToken: () => void;
  onSignOut: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

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
          <RepoList config={config} update={update} />
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
            <label className="check">
              <input type="checkbox" checked={inbox.assigned} onChange={(e) => setInbox({ assigned: e.target.checked })} />
              Assigned to you
            </label>
            <NumberField label="Items per group" value={inbox.limit} onChange={(limit) => setInbox({ limit })} />
          </fieldset>
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
          <h3>Account</h3>
          <p>{viewer ? <>Connected to GitHub as <strong>{viewer}</strong>.</> : 'Connected to GitHub.'}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={onChangeToken}>
              Replace token
            </button>
            <button type="button" className="btn btn-danger" onClick={onSignOut}>
              Remove token
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Backup</h3>
          <Backup config={config} update={update} />
        </section>
      </div>
    </dialog>
  );
}
