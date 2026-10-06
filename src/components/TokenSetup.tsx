import { useState, type FormEvent } from 'react';
import { providers } from '../providers';
import { tokens } from '../lib/transport';
import { ExternalLink } from './ExternalLink';

export function TokenSetup({ onDone, onCancel, reason }: {
  onDone: (login: string) => void;
  onCancel?: () => void;
  reason?: string | null;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = providers.github;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const login = await tokens.set(provider.id, value);
      setValue('');
      onDone(login);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save token');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup">
      <form className="setup-card" onSubmit={submit}>
        <h1>Connect GitHub</h1>
        {reason && <p className="error-text">{reason}</p>}
        <p>
          git-dash needs a personal access token. It is stored in your operating system&apos;s keychain
          and only ever sent to <code>api.github.com</code>. The app itself never displays or exports it.
        </p>
        <details>
          <summary>Which token should I create?</summary>
          <ul className="help-list">
            <li>
              <strong>Fine-grained token (recommended):</strong> read-only access to <em>Metadata</em>,{' '}
              <em>Contents</em>, <em>Pull requests</em>, <em>Issues</em>, <em>Commit statuses</em> and{' '}
              <em>Actions</em>. A fine-grained token covers one account or organization; you can add tokens
              for other organizations later in Settings.
            </li>
            <li>
              <strong>Classic token:</strong> works across organizations. No scopes are needed for public
              repositories; private ones need <code>repo</code>, which also grants write access. git-dash
              only ever sends read-only queries, but prefer fine-grained tokens where you can.
            </li>
          </ul>
          <p>
            <ExternalLink href={provider.tokenHelpUrl}>Create a fine-grained token</ExternalLink>
            {' · '}
            <ExternalLink href="https://github.com/settings/tokens/new?description=git-dash">
              Create a classic token
            </ExternalLink>
          </p>
        </details>
        <label className="field">
          <span>Access token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="github_pat_…"
            required
            maxLength={255}
          />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="actions">
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || value.trim().length === 0}>
            {busy ? 'Verifying…' : 'Save token'}
          </button>
        </div>
      </form>
    </main>
  );
}
