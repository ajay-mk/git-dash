import { useState, type ReactNode } from 'react';
import type { GhStatus } from '../lib/transport';
import { ExternalLink } from './ExternalLink';

/**
 * How to make the GitHub CLI login available to GitDash, step by step, for
 * when gh was not found where GitDash looks for it.
 */
export function GhSetupSteps({ status, onRecheck }: { status: GhStatus; onRecheck: () => void }) {
  const windows = status.searched.some((p) => p.includes('\\'));
  return (
    <ol className="help-list">
      <li>
        Install GitHub CLI:{' '}
        {windows ? (
          <>
            <code>winget install --id GitHub.cli</code>, or Scoop, Chocolatey or the official installer
          </>
        ) : (
          <>
            <code>brew install gh</code> on macOS, or your Linux package manager
          </>
        )}{' '}
        (<ExternalLink href="https://github.com/cli/cli#installation">install guide</ExternalLink>).
      </li>
      <li>
        In a terminal, run <code>gh auth login</code> and choose <em>GitHub.com</em>. With several accounts, run{' '}
        <code>gh auth switch</code> to pick the one GitDash should use.
      </li>
      <li>
        GitDash only runs gh from these places, never from your <code>PATH</code>:
        <ul className="gh-paths">
          {status.searched.map((p) => (
            <li key={p}>
              <code className="url-text">{p}</code>
            </li>
          ))}
        </ul>
        {windows ? (
          <>
            If <code>where gh</code> shows another location, install it again with one of the installers above.
          </>
        ) : (
          <>
            If <code>which gh</code> shows another location, link it into one of them, for example:
            <pre className="command">
              <code>sudo mkdir -p /usr/local/bin &amp;&amp; sudo ln -sf &quot;$(which gh)&quot; /usr/local/bin/gh</code>
            </pre>
          </>
        )}
      </li>
      <li>
        <button type="button" className="btn" onClick={onRecheck}>
          Check again
        </button>
      </li>
    </ol>
  );
}

/** A collapsed section with the steps, rendered only once opened. */
export function GhSetupHelp({ summary, status, onRecheck, children }: {
  summary: string;
  status: GhStatus;
  onRecheck: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="gh-help" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && (
        <>
          {children}
          <GhSetupSteps status={status} onRecheck={onRecheck} />
        </>
      )}
    </details>
  );
}
