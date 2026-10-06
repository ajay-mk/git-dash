# git-dash

A glanceable, customizable desktop dashboard for your GitHub repositories.
Pin the repos you care about, choose what each card shows, and see at a glance
what is failing, what needs your review, and what is waiting on you.

- **Repo cards** with a colour-coded status stripe: CI failing on the default
  branch (red), pull requests needing attention (amber), CI running (yellow),
  all good (green).
- **Per-repo widgets**: default-branch CI, open pull requests (with CI and
  review state, optional draft hiding), and open issues (optionally filtered by
  label). Toggle and configure each per repository.
- **"Needs you" sidebar**: PRs awaiting your review, your own PRs (highlighting
  ones to fix or ready to merge), and issues/PRs assigned to you.
- **Auto-refresh** on a configurable interval, paused while the window is
  hidden.
- Light/dark theme following the system, with a manual override.
- Config export/import (it never contains your token).

Built with [Tauri 2](https://tauri.app), React and TypeScript. GitHub is the
first provider; the data layer is provider-agnostic (`src/providers/`) so other
services can be added later.

## Installing

Download the installer for your platform from the
[Releases](../../releases) page:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `git-dash_<version>_aarch64.dmg` |
| macOS (Intel) | `git-dash_<version>_x64.dmg` |
| Windows | `git-dash_<version>_x64-setup.exe` or `git-dash_<version>_x64_en-US.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

Each release includes `SHA256SUMS.txt`. Check your download against it before
running it, for example with `sha256sum -c SHA256SUMS.txt --ignore-missing`
(Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS) or
`Get-FileHash <file>` (Windows PowerShell).

**The builds are not code-signed yet**, so your operating system will warn you
the first time you open them:

- **macOS** blocks the app with a message that Apple could not verify it is
  free of malware. The app is only ad-hoc signed, not signed with an Apple
  Developer ID or notarized. To open it once, go to *System Settings → Privacy
  & Security*, find the message about git-dash and choose *Open Anyway*.
- **Windows** SmartScreen shows "Windows protected your PC". Choose *More info
  → Run anyway*. The installer is not Authenticode-signed, so it also shows an
  unknown publisher.
- **Linux** packages are not signed (there is no repository or GPG signature);
  rely on the checksums.

There is no auto-updater yet: install new versions from the Releases page.

## Security

Your tokens are stored in the operating system's keychain and are never
exposed to the app's UI layer. All GitHub calls are made by the Rust backend, which
only allows read-only GraphQL queries to `api.github.com`. See
[SECURITY.md](SECURITY.md) for the full model and how to report issues.

## Creating a token

**Fine-grained token (recommended).** Create one at
<https://github.com/settings/personal-access-tokens/new> with *read-only*
access to: Metadata, Contents, Pull requests, Issues, Commit statuses and
Actions. A fine-grained token is limited to one account or organization.

**Classic token.** Works across organizations. Public repositories need no
scopes; private repositories need `repo`, which also grants write access.
git-dash only sends read-only queries, but prefer fine-grained tokens where
possible.

**Organizations with SAML SSO.** A classic token must be authorized for each
organization that enforces SSO: on <https://github.com/settings/tokens>, choose
*Configure SSO* next to the token and authorize the organization. You can do
this yourself; no admin is needed. An OAuth token (`gho_`, for example from
`gh auth token`) does not appear on that page: sign in through the
organization's SSO and authorize the app again instead. Until then, the
organization's repositories show an SSO error and the "Needs you" list notes
that some results are hidden.

**Organization token policies.** An organization can require owner approval
for fine-grained tokens, or forbid classic or long-lived tokens. While a
fine-grained token is pending approval, or when a repository was not selected
for it, GitHub reports the repository as not found.

### Several accounts or organizations

git-dash keeps a **default token** plus optional **per-owner tokens**, so you
can use a fine-grained token for your personal repositories and another for
each organization:

1. Add the default token on first launch (usually one for your own account).
2. In **Settings → Access tokens → Per-owner tokens**, enter an account or
   organization name and a token for it. git-dash verifies the token with
   GitHub and shows the login it belongs to; the token itself is never shown
   again.
3. Pinned repositories owned by that account or organization are fetched with
   its token. All other repositories use the default token.

The **"Needs you"** sidebar searches with the default token, then merges in
results from per-owner tokens that belong to the same GitHub user,
de-duplicated. Items visible only to a token that belongs to a *different*
user are not shown, and per-owner tokens that fail are skipped there (their
repository cards show the error instead).

## Development

Prerequisites: Node.js 22 (see `.nvmrc`), a stable Rust toolchain, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
OS.

```sh
npm ci
npm run tauri dev      # run the desktop app with hot reload
npm run check          # typecheck, lint, unit and component tests (frontend)
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
npm run tauri build    # produce installers for your platform
```

### Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a version tag is pushed.

1. Bump the version everywhere it is recorded (`package.json`,
   `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`):

   ```sh
   npm run version:set -- 1.2.3   # plain X.Y.Z; MSI installers reject suffixes like -beta
   ```

   Do not use `npm version`: `.npmrc` disables scripts, so it would only update
   `package.json`. CI runs `npm run version:check` to catch files that drift.
2. Commit, merge to `main`, then tag that commit and push the tag:

   ```sh
   git tag v1.2.3 && git push origin v1.2.3
   ```

3. The workflow checks that the tag matches the app version, builds installers
   for macOS (Apple Silicon and Intel), Windows and Linux, and creates a
   **draft** release with the installers and `SHA256SUMS.txt`.
4. Review the draft on the Releases page, edit the notes and publish it.

To redo a failed release, delete the draft release (and the tag, if the commit
changes) before pushing the tag again. Code signing and the updater are not set
up yet; the workflow marks where their secrets go.

### Project layout

```
src/                    React frontend (no access to the token)
  config/               dashboard config schema, validation, persistence
  providers/            provider-agnostic model + GitHub implementation
    tokens.ts           grouping repos by token, merging inbox results
  components/           UI
  hooks/useDashboard.ts data loading and refresh
src-tauri/              Rust backend
  src/token.rs          OS keychain token storage (default + per-owner)
  src/github.rs         GitHub API client (the only place the token is used)
  src/graphql_guard.rs  read-only query enforcement
  capabilities/         least-privilege permissions for the webview
```

### Adding a provider

1. Add its id to `ProviderId` in `src/providers/types.ts`.
2. Implement the `Provider` interface (see `src/providers/github/`) and register
   it in `src/providers/index.ts`.
3. Add a backend client and token slot in `src-tauri/src/` with a
   read-only command, and grant it in `src-tauri/capabilities/default.json`.

## License

[MIT](LICENSE)
