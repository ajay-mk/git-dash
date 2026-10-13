import { useRef, useState, type FormEvent } from 'react';
import { providers } from '../providers';
import { GITLAB_COM, normalizeGitLabHost } from '../providers/gitlab/host';
import { PROVIDER_IDS, type ProviderId } from '../providers/types';
import { tokens } from '../lib/transport';
import logo from '../assets/logo.svg';
import { ExternalLink } from './ExternalLink';
import { PermissionList } from './PermissionList';

function GitHubHelp() {
  const provider = providers.github;
  return (
    <>
      <p>
        GitDash needs a personal access token. It is stored in your operating system&apos;s keychain
        and only ever sent to <code>api.github.com</code>. The app itself never displays or exports it.
      </p>
      <ol className="help-list">
        <li>
          <ExternalLink href={provider.newTokenUrl()}>Create a fine-grained token</ExternalLink>. The link
          fills in the read-only permissions GitDash needs:{' '}
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
            repositories; private ones need <code>repo</code>, which also grants write access. GitDash
            only ever sends read-only queries, but prefer fine-grained tokens where you can.{' '}
            <ExternalLink href="https://github.com/settings/tokens/new?description=GitDash">
              Create a classic token
            </ExternalLink>
          </li>
        </ul>
      </details>
    </>
  );
}

function GitLabHelp({ host }: { host: string | null }) {
  const provider = providers.gitlab;
  const tokenUrl = provider.newTokenUrl(host);
  return (
    <>
      <p>
        GitDash needs a personal access token. It is stored in your operating system&apos;s keychain
        and only ever sent to <code>{host ?? 'your GitLab instance'}</code>. The app itself never displays or
        exports it.
      </p>
      <ol className="help-list">
        <li>
          {host === GITLAB_COM ? (
            <ExternalLink href={tokenUrl}>Create a personal access token</ExternalLink>
          ) : (
            <>
              On your instance, open <em>User settings</em>, then <em>Access tokens</em>
              {host && (
                <>
                  {' '}
                  (<code className="url-text">{tokenUrl}</code>)
                </>
              )}
            </>
          )}
          . It needs only the read-only <PermissionList permissions={provider.tokenPermissions} /> scope
          {host === GITLAB_COM ? ', which the link fills in' : ''}.
        </li>
        <li>Choose an expiry date, create the token and paste it below.</li>
      </ol>
      <p className="hint">
        One token covers every group and project your account can see. Self-hosted instances need GitLab 18
        or newer and must be reachable over HTTPS.
      </p>
    </>
  );
}

export function TokenSetup({ provider: initial = 'github', gitlabHost, onDone, onCancel, reason }: {
  /** The service to connect first; the user can switch. */
  provider?: ProviderId;
  /**
   * The GitLab instance already connected, if any. A replacement token is
   * almost always for the same instance, and must not go to gitlab.com by
   * default.
   */
  gitlabHost?: string | null;
  onDone: (login: string, provider: ProviderId) => void;
  onCancel?: () => void;
  reason?: string | null;
}) {
  // The input is uncontrolled: React mirrors a controlled input's value into
  // its `value` attribute, which would put the token in the page markup.
  const input = useRef<HTMLInputElement>(null);
  const [providerId, setProviderId] = useState<ProviderId>(initial);
  const [hostInput, setHostInput] = useState(gitlabHost ?? GITLAB_COM);
  const [hasValue, setHasValue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = providers[providerId];
  const host = normalizeGitLabHost(hostInput);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (providerId === 'gitlab' && !host) {
      setError('Enter the address of your GitLab instance, such as gitlab.com or gitlab.example.com.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const value = input.current?.value ?? '';
      const login = providerId === 'gitlab' ? await tokens.set('gitlab', value, null, host) : await tokens.set('github', value);
      if (input.current) input.current.value = '';
      setHasValue(false);
      onDone(login, providerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save token');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup">
      <form className="setup-card" onSubmit={submit}>
        <h1>
          <img className="setup-logo" src={logo} alt="" />
          Connect {provider.label}
        </h1>
        <div className="segmented" role="group" aria-label="Service">
          {PROVIDER_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="segment"
              aria-pressed={id === providerId}
              disabled={busy}
              onClick={() => {
                if (id === providerId) return;
                // A token typed for one service must never be sent to another.
                if (input.current) input.current.value = '';
                setHasValue(false);
                setProviderId(id);
                setError(null);
              }}
            >
              {providers[id].label}
            </button>
          ))}
        </div>
        {reason && <p className="error-text">{reason}</p>}
        {providerId === 'github' ? <GitHubHelp /> : <GitLabHelp host={host} />}
        {providerId === 'gitlab' && (
          <label className="field">
            <span>GitLab instance</span>
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              placeholder="gitlab.com or gitlab.example.com"
              maxLength={260}
              required
            />
          </label>
        )}
        <label className="field">
          <span>Access token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            ref={input}
            onChange={(e) => setHasValue(e.target.value.trim().length > 0)}
            placeholder={providerId === 'gitlab' ? 'glpat-…' : 'github_pat_…'}
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
