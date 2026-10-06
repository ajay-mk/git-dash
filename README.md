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

## Security

Your token is stored in the operating system's keychain and is never exposed
to the app's UI layer. All GitHub calls are made by the Rust backend, which
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

## Development

Prerequisites: Node.js 22 (see `.nvmrc`), a stable Rust toolchain, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
OS.

```sh
npm ci
npm run tauri dev      # run the desktop app with hot reload
npm run check          # typecheck, lint and unit tests (frontend)
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
npm run tauri build    # produce installers for your platform
```

### Project layout

```
src/                    React frontend (no access to the token)
  config/               dashboard config schema, validation, persistence
  providers/            provider-agnostic model + GitHub implementation
  components/           UI
  hooks/useDashboard.ts data loading and refresh
src-tauri/              Rust backend
  src/token.rs          OS keychain token storage
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
