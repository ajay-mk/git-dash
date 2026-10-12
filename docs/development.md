# Development

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

## Project layout

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

## Adding a provider

1. Add its id to `ProviderId` in `src/providers/types.ts`.
2. Implement the `Provider` interface (see `src/providers/github/`) and register
   it in `src/providers/index.ts`.
3. Add a backend client and token slot in `src-tauri/src/` with a
   read-only command, and grant it in `src-tauri/capabilities/default.json`.

Releases are covered in [releasing.md](releasing.md).
