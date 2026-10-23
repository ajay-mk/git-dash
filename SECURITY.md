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
| Token storage | A default token plus optional per-owner tokens (one per GitHub account or organization), each stored as its own entry in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). Never written to disk by the app, never put in config files or exports. A non-secret index entry records which owners have a token and the login GitHub reported for each. GitLab has a single token whose index entry also records the instance it was verified against. A GitHub slot linked to GitHub CLI stores no token at all: the index records the login it is linked to, and the token is read from `gh` when needed and kept in memory only, and gh is asked again at least once a minute, so signing out of gh (which does not revoke the token) also disconnects GitDash. Linking deletes any token stored for that slot. |
| Token exposure to the UI | The webview never receives a token. The Rust backend attaches it to requests; the frontend can only *set*, *clear*, *link to GitHub CLI* or *list* tokens, and the list contains only owner names, logins and whether each comes from GitHub CLI (`src-tauri/src/commands.rs`). |
| Token selection | The frontend passes an owner name (or nothing) with each query and the backend picks the token: that owner's token if configured, the default token otherwise. The app uses a per-owner token only for that owner's repositories and for the "Needs you" searches. The backend cannot check what a query reads, so this is up to the frontend; whichever token is picked, it is only ever sent to `api.github.com`, and only for read-only queries. |
| GitLab instance | The instance is chosen when a GitLab token is saved: an `https` DNS name with an optional port (no paths, credentials or IP addresses), validated in `src-tauri/src/gitlab.rs`. The token is verified against that host and stored with it; queries never name a host, so a stored token is only ever sent to the host it was saved for. Changing the instance means entering the token again. |
| Keychain entry names | Fixed allow-list: the frontend cannot name keychain entries. Owners are validated against GitHub's login rules (1-39 letters, digits or hyphens; no `:`), lowercased, and mapped to `github:owner:<owner>`, so they cannot collide with the default (`github`) or index (`github:index`) entries. At most 20 per-owner tokens are stored. GitLab uses the fixed entries `gitlab` and `gitlab:index`. |
| Running GitHub CLI | The only program the backend starts (`src-tauri/src/gh.rs`). `gh` is taken only from a fixed list of install locations, never from `PATH` or a path the frontend names, and refused if it or its directory is writable by everyone (on Unix; on Windows only folders that need administrator rights or belong to the user are listed, so no shared folder another user could create, such as Chocolatey's under `%ProgramData%`). Some of these locations (Homebrew, a Nix profile, winget and Scoop on Windows) are writable by the user's own account, as for any tool the user installs; a compromised account is out of scope. The arguments are fixed (`auth token --hostname github.com`, plus `--user` with a validated login), with no shell, no stdin, a minimal environment (so `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR` and `GH_HOST` cannot change the result), a 10-second limit that also covers anything gh leaves running, and a cap on output. Only one gh read runs at a time. Its error output is never shown. The token must look like a GitHub token, and a freshly read one is used only after GitHub confirms it belongs to the linked login, so `gh auth switch` cannot silently change the account. |
| Network destinations | The backend only talks to `https://api.github.com/graphql` and the connected GitLab instance's `/api/graphql`, with HTTPS enforced and redirects disabled so a token cannot be forwarded elsewhere. The webview's CSP blocks all network access other than IPC to the backend. |
| Write access | For GitHub, the frontend never sends query text: it names one of GitDash's own read-only queries and passes variables, and repository cards send a list of repositories from which the backend builds the query out of fixed pieces (`src-tauri/src/github_queries.rs`). For GitLab, the backend rejects any GraphQL document containing a `mutation` or `subscription` operation (`src-tauri/src/graphql_guard.rs`); GitHub's built-in queries pass the same check. So even a token with write scopes cannot be used to change anything through GitDash. This matters most for GitHub CLI tokens, which always carry the write-capable `repo` scope. Read-only tokens are still recommended. |
| Injection | User input (owners, repo names, labels) is only ever passed as GraphQL variables, never interpolated into query text. API data is rendered as text (raw HTML rendering is forbidden by lint rules). |
| Untrusted API data | URLs are only rendered as links if they are plain `https://github.com/` URLs or pages on the connected GitLab instance (GitLab data may only link to its own instance); label colours must be hex. External links open in the system browser through a backend command that again allows only `https://github.com/`, `https://gitlab.com/` and the connected instance. |
| Webview navigation | The main window can only ever show the bundled app; any other navigation is blocked. The app never opens extra windows: a request for one (a middle-click on a link, `window.open`) is refused, and links the backend command above would accept open in the system browser instead. |
| Imported config | Validated and normalised (`src/config/schema.ts`) before use; it contains no secrets. |
| Supply chain | Exact-pinned npm dependencies with install scripts disabled, a committed `Cargo.lock`, GitHub Actions pinned to full commit SHAs with read-only workflow permissions, and Dependabot for npm, Cargo and Actions. |
| Release builds | Installers are built by GitHub Actions from a version tag, never on a developer machine, without the Actions cache. The build jobs have a read-only token and no secrets: they sign update files with a throwaway key. A separate job signs them again with the update key, in a step that runs only the Tauri CLI. The key is a secret of a protected `release` environment, available only to that job, only for `v*` tags, and only after the owner approves the run; a tag ruleset limits creating release tags to admins, and the workflow refuses tags on commits not on `main`. The manifest step then refuses any file not signed with the key the app trusts. Only the final job that creates the draft release can write, and it runs no project code. Every release lists SHA-256 checksums of its files. Builds are **not yet code-signed** (macOS builds are only ad-hoc signed and not notarized), so the checksums and the release page are the only way to check that a download is genuine. |

## Limits

The backend assumes the webview may be compromised and keeps tokens and write
access away from it, but code running in the webview can still do what the UI
can: use any stored token for GitDash's own read-only queries (and any
read-only query for GitLab), replace or remove stored tokens (including
pointing the GitLab connection at another instance with a new token), and
link a slot to the GitHub CLI login, which runs `gh` as described above but
still never reveals its token. The CSP above is what stops injected code from running there.

## Out of scope

- Attacks requiring local administrator access or a compromised OS account
  (such a user can read the keychain anyway).
- The security of GitHub and GitLab themselves.
