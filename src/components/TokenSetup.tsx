import { useRef, useState, type FormEvent } from 'react';
import { providers } from '../providers';
import { tokens } from '../lib/transport';
import { ExternalLink } from './ExternalLink';
import { PermissionList } from './PermissionList';

export function TokenSetup({ onDone, onCancel, reason }: {
  onDone: (login: string) => void;
  onCancel?: () => void;
  reason?: string | null;
}) {
  // The input is uncontrolled: React mirrors a controlled input's value into
  // its `value` attribute, which would put the token in the page markup.
  const input = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = providers.github;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const login = await tokens.set(provider.id, input.current?.value ?? '');
      if (input.current) input.current.value = '';
      setHasValue(false);
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
        <ol className="help-list">
          <li>
            <ExternalLink href={provider.newTokenUrl()}>Create a fine-grained token</ExternalLink>. The link
            fills in the read-only permissions git-dash needs:{' '}
            <PermissionList permissions={provider.tokenPermissions} />.
          </li>
          <li>
            Under <em>Repository access</em>, choose <em>All repositories</em> or the ones you want to pin.
            GitHub does not let a link fill this in. Repository access alone is not enough: the token also
            needs the permissions above.
          </li>
          <li>Generate the token and paste it below.</li>
        </ol>
        <details>
          <summary>Other kinds of token</summary>
          <ul className="help-list">
            <li>
              A fine-grained token covers one account or organization. You can add tokens for other
              organizations later in Settings.
            </li>
            <li>
              <strong>Classic token:</strong> works across organizations. No scopes are needed for public
              repositories; private ones need <code>repo</code>, which also grants write access. git-dash
              only ever sends read-only queries, but prefer fine-grained tokens where you can.{' '}
              <ExternalLink href="https://github.com/settings/tokens/new?description=git-dash">
                Create a classic token
              </ExternalLink>
            </li>
          </ul>
        </details>
        <label className="field">
          <span>Access token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            ref={input}
            onChange={(e) => setHasValue(e.target.value.trim().length > 0)}
            placeholder="github_pat_…"
            required
            maxLength={255}
          />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="actions">
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || !hasValue}>
            {busy ? 'Verifying…' : 'Save token'}
          </button>
        </div>
      </form>
    </main>
  );
}
