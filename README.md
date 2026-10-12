<p align="center">
  <img src="src/assets/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">GitDash</h1>

<p align="center">
  A glanceable, customizable desktop dashboard for your GitHub repositories.
</p>

Pin the repos you care about, choose what each card shows, and see at a glance
what is failing, what needs your review, and what is waiting on you.

- **Repo cards** with a colour-coded status dot: CI failing on the default
  branch (red), pull requests needing attention (amber), CI running (yellow),
  all good (green). Drag to reorder and resize them.
- **Per-repo widgets**: default-branch CI, open pull requests (with CI and
  review state, optional draft hiding), and open issues (optionally filtered by
  label).
- **"Needs you" sidebar**: PRs awaiting your review, your own PRs (highlighting
  ones to fix or ready to merge), and issues/PRs assigned to you.
- **Auto-refresh** on a configurable interval, paused while the window is
  hidden.
- Light and dark themes, and config export/import (it never contains your
  token).

## Getting started

1. Download the installer for your platform from the
   [Releases](https://github.com/ajay-mk/git-dash/releases) page. The builds
   are not code-signed yet; [docs/installing.md](docs/installing.md) explains
   the first-launch warnings and how to verify the download.
2. Create a read-only fine-grained token with
   [this link](https://github.com/settings/personal-access-tokens/new?name=GitDash&description=Read-only+access+for+the+GitDash+dashboard&metadata=read&contents=read&pull_requests=read&issues=read&statuses=read&actions=read),
   pick the repositories it can see, and paste it into GitDash.
   [docs/tokens.md](docs/tokens.md) covers classic tokens, SSO and using
   several accounts or organizations.
3. Pin a repository and choose what its card shows.

## Security

Your tokens are stored in the operating system's keychain and are never
exposed to the app's UI layer. All GitHub calls are made by the Rust backend,
which only allows read-only GraphQL queries to `api.github.com`. See
[SECURITY.md](SECURITY.md) for the full model and how to report issues.

## Documentation

- [Installing](docs/installing.md): downloads, checksums, unsigned builds
- [Access tokens](docs/tokens.md): permissions, SSO, per-owner tokens
- [Development](docs/development.md): building, testing, project layout, adding a provider
- [Releasing](docs/releasing.md): cutting a release

Built with [Tauri 2](https://tauri.app), React and TypeScript.

## License

[MIT](LICENSE)
