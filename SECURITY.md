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

GitDash is a desktop app (Tauri) with no server component. Nobody but the
user ever holds their credentials.

| Concern | How it is handled |
| --- | --- |
| Token storage | A default token plus optional per-owner tokens (one per GitHub account or organization), each stored as its own entry in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). Never written to disk by the app, never put in config files or exports. A non-secret index entry records which owners have a token and the login GitHub reported for each. |
| Token exposure to the UI | The webview never receives a token. The Rust backend attaches it to requests; the frontend can only *set*, *clear* or *list* tokens, and the list contains only owner names and logins (`src-tauri/src/commands.rs`). |
| Token selection | The frontend passes an owner name (or nothing) with each query and the backend picks the token: that owner's token if configured, the default token otherwise. A per-owner token is only used for that owner's repositories and for the "Needs you" searches, and like every token it is only ever sent to `api.github.com`. |
| Keychain entry names | Fixed allow-list: the frontend cannot name keychain entries. Owners are validated against GitHub's login rules (1-39 letters, digits or hyphens; no `:`), lowercased, and mapped to `github:owner:<owner>`, so they cannot collide with the default (`github`) or index (`github:index`) entries. At most 20 per-owner tokens are stored. |
| Network destinations | The backend only talks to `https://api.github.com/graphql`, with HTTPS enforced and redirects disabled so the token cannot be forwarded elsewhere. The webview's CSP blocks all network access other than IPC to the backend. |
| Write access | The backend rejects any GraphQL document containing a `mutation` or `subscription` operation (`src-tauri/src/graphql_guard.rs`), so even a token with write scopes cannot be used to change anything through GitDash. Read-only tokens are still recommended. |
| Injection | User input (owners, repo names, labels) is only ever passed as GraphQL variables, never interpolated into query text. API data is rendered as text (raw HTML rendering is forbidden by lint rules). |
| Untrusted API data | URLs are only rendered as links if they are plain `https://github.com/` URLs; label colours must be hex. External links open in the system browser, restricted to `https://github.com/*` by a Tauri capability. |
| Webview navigation | The main window can only ever show the bundled app; any other navigation is blocked. |
| Imported config | Validated and normalised (`src/config/schema.ts`) before use; it contains no secrets. |
| Supply chain | Exact-pinned npm dependencies with install scripts disabled, a committed `Cargo.lock`, GitHub Actions referenced by release tag with read-only workflow permissions, and Dependabot for npm, Cargo and Actions. |
| Release builds | Installers are built by GitHub Actions from a version tag, never on a developer machine. The build jobs have a read-only token; only the final job that creates the draft release can write, and it runs no project code. Every release lists SHA-256 checksums of its files. Builds are **not yet code-signed** (macOS builds are only ad-hoc signed and not notarized), so the checksums and the release page are the only way to check that a download is genuine. |

## Out of scope

- Attacks requiring local administrator access or a compromised OS account
  (such a user can read the keychain anyway).
- The security of GitHub itself.
