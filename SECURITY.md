# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Include steps to reproduce and the affected version. You should
get an acknowledgement within a few days.

## Supported versions

Only the latest release receives security fixes.

## Security model

git-dash is a desktop app (Tauri) with no server component. Nobody but the
user ever holds their credentials.

| Concern | How it is handled |
| --- | --- |
| Token storage | Stored in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). Never written to disk by the app, never put in config files or exports. |
| Token exposure to the UI | The webview never receives the token. The Rust backend attaches it to requests; the frontend can only *set*, *clear* or *check for* a token (`src-tauri/src/commands.rs`). |
| Network destinations | The backend only talks to `https://api.github.com/graphql`, with HTTPS enforced and redirects disabled so the token cannot be forwarded elsewhere. The webview's CSP blocks all network access other than IPC to the backend. |
| Write access | The backend rejects any GraphQL document containing a `mutation` or `subscription` operation (`src-tauri/src/graphql_guard.rs`), so even a token with write scopes cannot be used to change anything through git-dash. Read-only tokens are still recommended. |
| Injection | User input (owners, repo names, labels) is only ever passed as GraphQL variables, never interpolated into query text. API data is rendered as text (raw HTML rendering is forbidden by lint rules). |
| Untrusted API data | URLs are only rendered as links if they are plain `https://github.com/` URLs; label colours must be hex. External links open in the system browser, restricted to `https://github.com/*` by a Tauri capability. |
| Webview navigation | The main window can only ever show the bundled app; any other navigation is blocked. |
| Imported config | Validated and normalised (`src/config/schema.ts`) before use; it contains no secrets. |
| Supply chain | Exact-pinned npm dependencies with install scripts disabled, a committed `Cargo.lock`, SHA-pinned GitHub Actions, and Dependabot for all three. |

## Out of scope

- Attacks requiring local administrator access or a compromised OS account
  (such a user can read the keychain anyway).
- The security of GitHub itself.
