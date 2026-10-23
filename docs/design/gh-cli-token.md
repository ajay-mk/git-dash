# Scoping: use the GitHub CLI's token

Status: implemented with option (b), the live link, plus built-in GitHub
queries. See [What was built](#what-was-built). The rest of this page is the
original scoping, corrected where we learned more.

## Problem

Some organizations block personal access tokens, or require an owner to
approve each fine-grained token. Those users can't connect GitDash to their
org's private repositories today, or have to wait for approval.

Many of the same orgs have already approved the GitHub CLI as an OAuth app.
Its token (`gh auth token`, a `gho_` token) can then read private org
repositories that a fine-grained token can't. [tokens.md](../tokens.md)
already says a user can paste that token by hand. The question is whether
GitDash should offer a **Use GitHub CLI** button instead.

## 1. Options

### (a) One-time import

The backend runs `gh auth token --hostname github.com [--user <login>]`,
verifies the result with `viewer { login }` as `token_set` does today, and
stores it in GitDash's own keychain entry. From then on it is an ordinary
stored token: `resolve`, the cache, `forget_cached` on 401 and `token_clear`
all work unchanged.

- Simple: one new command that ends in the existing `TokenStore::set`.
- `gh` is only needed at import time. Once imported, GitDash works even if
  gh is uninstalled or logged out.
- **Two copies of the token** exist: gh's and GitDash's. Logging out of gh
  does not stop GitDash. Revoking the OAuth grant on GitHub does.
- Rotation: `gho_` tokens do not expire on their own. They stop working when
  the user revokes the app, when `gh auth logout` or a re-login makes GitHub
  revoke the old token, when an org admin revokes access, or after a year
  unused. `gh auth refresh` (for example to add scopes) may issue a new token
  and revoke the old one. In each case GitDash gets a 401 and shows the
  reconnect screen, where one click imports again.

### (b) Live link

GitDash stores no token, only a marker that a slot is "linked to gh" (and
for which account). Each time the cache is empty it runs `gh auth token`
again, so `gh auth refresh`, a re-login or `gh auth switch` is picked up
automatically.

- One copy of the secret, owned by gh. Logging out of gh disconnects
  GitDash, which matches what users expect from "use my gh login".
- After a 401, GitDash runs gh again before showing an error, so rotation
  heals itself.
- **GitDash depends on gh at runtime.** If gh breaks (moved by a Homebrew
  upgrade, PATH change, keyring locked), every request served by that slot
  fails until the user notices.
- More code in `TokenStore`: a slot can now be backed by the keychain or by
  a process, and the "is there a default token" check (`summary`) must not
  spawn gh on every call.
- If the link follows gh's *active* account, `gh auth switch` silently
  changes which GitHub user GitDash reads as. Pinning the link to a login
  (`--user`) avoids that.

### Trade-offs common to both

| Issue | Notes |
| --- | --- |
| gh not installed | Hide the button, or show it disabled with a link to <https://cli.github.com>. |
| gh not on PATH in a GUI app | On macOS an app started from Finder or the Dock gets only `/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew's `/opt/homebrew/bin` and `/usr/local/bin` are missing. Linux desktop launchers vary; Windows is usually fine. GitDash must look in known locations itself (see section 2). |
| Logged out of gh | `gh auth token` exits non-zero with "no oauth token found". Show "Run `gh auth login` first". |
| Several gh accounts | gh 2.40+ supports several accounts per host. `gh auth status --json hosts` lists them without tokens; `gh auth token --user <login>` picks one. With more than one, the UI asks which. |
| Where gh keeps the token | By default gh 2.40+ stores it in the OS keychain (service `gh:github.com`). With `--insecure-storage`, or when no keychain is available, it is plain text in `~/.config/gh/hosts.yml`. GitDash should **always ask the gh binary**, never read either location itself: reading gh's keychain item from GitDash would trigger a macOS keychain prompt for a different app, and parsing `hosts.yml` ties GitDash to gh's file format. |
| Environment overrides | `gh auth token` prints `GH_TOKEN` / `GITHUB_TOKEN` if set, and honours `GH_CONFIG_DIR` and `GH_HOST`. The child process should get a minimal environment (see section 2) so these can't change what is returned. |
| GitHub Enterprise | Out of scope: GitDash only talks to `api.github.com`, so the command always passes `--hostname github.com`. |
| Old gh versions | `--user` needs gh 2.40 (late 2023). Older versions have one account per host; run without `--user` and verify the login afterwards. |

## 2. Security impact

Measured against [SECURITY.md](../../SECURITY.md).

**Spawning a process.** This is the first time the backend runs another
program. Rules:

- Fixed argument list built in Rust: `["auth", "token", "--hostname",
  "github.com"]`, plus `["--user", login]` where `login` has passed
  `is_valid_login`. Nothing from the webview reaches the command line except
  that validated login. No shell.
- Minimal environment: clear it, then pass only what gh needs to find its
  config and keychain (`HOME`, `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` on
  Windows, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`
  for Secret Service on Linux). Set `GH_PROMPT_DISABLED=1`,
  `GH_NO_UPDATE_NOTIFIER=1` and `NO_COLOR=1`; drop `GH_TOKEN`,
  `GITHUB_TOKEN`, `GH_CONFIG_DIR`, `GH_HOST`, `GH_ENTERPRISE_TOKEN`.
- No stdin, a timeout (about 10 s), and a cap on stdout size. Stdout is
  trimmed and must pass `validate_format`. Stderr is never shown verbatim
  (it could in theory echo a token); map exit codes to fixed messages.
- The token still goes through `viewer_login` before it is used or stored.

**Which binary is trusted.** A GUI app's PATH is not under the user's
control in an obvious way, and PATH lookup would run whatever `gh` comes
first. Proposal: try a fixed list of absolute paths, in order:

- macOS: `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, `/opt/local/bin/gh`
  (MacPorts)
- Linux: `/usr/bin/gh`, `/usr/local/bin/gh`, `/home/linuxbrew/.linuxbrew/bin/gh`,
  `/snap/bin/gh`
- Windows: `%ProgramFiles%\GitHub CLI\gh.exe`, then the winget/scoop shims
  under `%LOCALAPPDATA%`

then fall back to `PATH`. The resolved path is shown in the UI ("Using
/opt/homebrew/bin/gh") so the user can see what ran. An attacker who can
replace a binary in these locations already runs code as the user, which
SECURITY.md lists as out of scope; the list just avoids picking up a `gh`
from a writable, unexpected directory. Optionally let the user set a custom
path in Settings (stored in config, not secret).

**Scopes.** gh always asks for at least `repo`, `read:org` and `gist`
(`gh auth refresh --remove-scopes` cannot drop them), sometimes plus
`workflow`. GitHub has no read-only OAuth scope for private repositories, so
there is no way to get a read-only token from gh. The token is
**write-capable** on every repository the user can push to, broader than the fine-grained token we
recommend. GitDash's protections still hold: the token is only sent to
`api.github.com/graphql`, never to the webview, and the GraphQL guard rejects
mutations and subscriptions. The risk that grows is a copy of a
write-capable token at rest: with (a), GitDash's keychain entry now holds
one. With (b), no new copy exists. The UI should say plainly that this token
can write and that GitDash only reads.

**SSO.** An OAuth token is authorized per org through the org's SSO, not on
the token settings page (tokens.md already says this). If the user ran
`gh auth login` before the org enforced SSO, or never visited the org, gh's
token may still get SAML errors. GitDash's existing SSO notice applies; the
hint should say "sign in to the org's SSO in a browser and re-authorize
GitHub CLI", and for (a) "then import again" is not needed because the
grant is attached to the existing token.

**Org policy.** Using gh's token is not a way around the org's rules: it
works only because the org approved GitHub CLI as an OAuth app. If the org
restricts OAuth apps and hasn't approved gh, the token reads public data
only. The docs should say so to avoid support confusion.

**SECURITY.md changes.**

- *Token storage*: add "a token imported from the GitHub CLI is stored the
  same way" (a), or "a slot linked to the GitHub CLI stores no token; the
  backend asks `gh` for it when needed and keeps it only in memory" (b).
- New row, *Running the GitHub CLI*: the only process the backend starts,
  fixed arguments, minimal environment, binary chosen from a fixed list of
  install locations then PATH, output validated and verified with GitHub
  before use, stderr not shown.
- *Write access*: note that GitHub CLI tokens normally carry `repo`, so the
  GraphQL guard is what keeps GitDash read-only for them.
- *Limits*: compromised webview code could trigger a gh import (it can
  already replace tokens), but still never sees the token.
- New Tauri command (for example `token_import_gh`, and `gh_status` for
  detection) granted in `capabilities/default.json`.

## 3. Fit with default and per-owner tokens, and "Needs you"

- **Default slot** is the natural home. One gh token covers every org that
  approved GitHub CLI, which is exactly what per-owner tokens exist to work
  around. Many users would need nothing else.
- **Per-owner slot**: also allowed, for someone who keeps a fine-grained
  default token for personal repos and uses gh's token only for `acme`.
  `token_set` already accepts any verified token for an owner, so (a) needs
  no change here. For (b) the per-owner index entry needs a "source: gh"
  marker.
- **"Needs you" merge** (`mergeInbox` in `src/providers/tokens.ts`) keeps
  per-owner results only when their viewer matches the default token's
  viewer. A gh token for the same user merges as usual. A gh token for a
  *different* gh account (a work account) is dropped from "Needs you", the
  same as any other token for another user. Worth calling out in the account
  picker: "Results from a different account than your default token are not
  shown in Needs you".
- If gh's token is the default and a per-owner token for the same user also
  exists, the per-owner token still wins for that owner's repos. No change.

## 4. UI changes

**Setup screen (`TokenSetup.tsx`, GitHub tab).** On mount, ask the backend
whether gh is available (`gh_status`: found path, version, logged-in
accounts, no tokens).

- gh found and logged in: show **Use GitHub CLI login** above the token
  steps, with the account (`Signed in as ajay-mk`). One account: one click.
  Several: a small picker. Then the same "Verifying…" state as pasting.
- gh found, not logged in: "Run `gh auth login` in a terminal, then try
  again" with a retry button.
- gh not found: either nothing, or a collapsed note under "Other kinds of
  token" mentioning gh with a link. Pasting stays the main path.
- Short text under the button: this token can also write; GitDash only
  sends read-only queries; org repos work if the org approved GitHub CLI.

**Settings → Access tokens.**

- Default token row shows its source: `ajay-mk (GitHub CLI)` vs
  `ajay-mk (personal access token)`. Requires storing a non-secret `source`
  in the index entry, decoded with the same "drop if malformed" rule.
- Buttons: **Import again from GitHub CLI** (a) or **Unlink** (b), next to
  the existing replace/remove.
- Per-owner form: a **From GitHub CLI** button next to the token field that
  fills the slot from gh instead of a pasted token.
- Errors: map "gh not found", "not logged in", "timed out" and "token
  rejected by GitHub" to fixed messages.

## 5. Recommendation

*Originally* (a), the one-time import. After discussion it changed to **(b),
the live link**, with one requirement added first:

- Every read-only option that avoids an org admin is a write-capable token
  (see the table below), so the only question is whether GitDash keeps a copy.
  With (b) it doesn't: gh stays the only holder.
- With a write-capable token, GitDash's mutation check would be the only thing
  keeping it read-only. So before linking gh, the frontend lost the ability to
  send GitHub query text at all ("persisted queries"): it names one of the
  backend's own queries instead. A bug or injected code in the webview can no
  longer write a query, let alone a mutation.

| Option | Read-only? | Needs an org admin? |
| --- | --- | --- |
| Fine-grained token | Yes | Yes, when the org requires approval or blocks them |
| GitDash GitHub App (what RepoBar does) | Yes | Yes, the org must install it |
| GitDash's own OAuth app | No (`repo`) | Yes, when the org restricts OAuth apps |
| Classic token | No (`repo`) | No, unless the org forbids classic tokens |
| GitHub CLI token | No (`repo`) | No, when the org already approved GitHub CLI |

### What other tools do

None of them store a copy; all read the token when needed:

- **go-gh** (GitHub's library for gh extensions such as gh-dash): `GH_TOKEN` /
  `GITHUB_TOKEN`, then `hosts.yml`, then `gh auth token --secure-storage
  --hostname <host>`; gh found via `GH_PATH` or a safe `PATH` lookup.
- **Homebrew**: `HOMEBREW_GITHUB_API_TOKEN`, then `gh auth token --hostname
  github.com` from its own gh install, stderr hidden, in memory only.
- **mise**: reads gh's `hosts.yml` directly, which misses tokens gh keeps in
  the OS keychain (its default).
- **Zed**: proposed in a discussion, undecided; the open question there is
  whether to do it without the user opting in.

All of these are command-line tools, so `PATH` and environment variables
work for them. A desktop app has neither reliably, which is why GitDash uses
fixed install locations and strips the environment instead.

## What was built

- `src-tauri/src/github_queries.rs`: all GitHub query documents. The
  `github_graphql` command takes an operation name, never query text;
  `GitDashRepos` takes a list of repositories (at most 10) and builds the
  batched query from fixed pieces. The documents were checked token for token
  against the previous TypeScript ones.
- `src-tauri/src/gh.rs`: finds gh in fixed install locations (Homebrew,
  MacPorts, Linux packages, Linuxbrew, Snap, Nix, and on Windows the official
  installer, winget and Scoop; not Chocolatey, whose `%ProgramData%` folder
  other local users can create), refusing world-writable files or
  directories, and runs `gh auth token --hostname
  github.com [--user <login>]` with a cleared environment, fixed `PATH`, no
  stdin, a 10 s limit and a 4 KiB output cap, and maps failures to fixed
  messages. On Windows it starts gh without a console window.
- `src-tauri/src/token.rs`: a slot (default or per-owner) can be linked to a
  gh login. Nothing is stored in the keychain for it; the index records the
  login. Linking deletes any token stored for the slot. Tokens read from gh
  are kept in memory once GitHub confirms they belong to the linked login,
  and dropped on a 401 so the next request asks gh again. gh is also asked
  again after 60 s (`gh auth logout` does not revoke the token, so this is
  what makes signing out disconnect GitDash); the same token skips the
  GitHub check. Linking also runs the pinned `--user` read, so a gh too old
  for it fails at setup. Only one gh read
  runs at a time; requests arriving together reuse its result. When linking,
  the stored token is deleted only after the link is saved.
- Setup steps (install, `gh auth login`, the exact places GitDash looks and
  how to link gh there, **Check again**) on the setup screen and in Settings
  when gh is not found, and in `docs/tokens.md`.
- Commands `gh_status` (where gh was found) and `token_link_gh` (link the
  default slot or an owner to gh's active account).
- UI: **Use GitHub CLI login** on the setup screen when gh is found, **Use
  GitHub CLI** in the per-owner form, "from GitHub CLI" labels and **Unlink
  GitHub CLI** in Settings.
- gh problems at runtime (signed out, wrong account, gh missing) show as a
  banner with the fix rather than the "replace your token" screen; once
  fixed in gh, the next refresh recovers without relinking.
- Docs: `SECURITY.md`, `docs/tokens.md`, `README.md`.

Answers to the original open questions:

1. A stored write-capable token: avoided by the live link.
2. The gh button is shown first on the setup screen when gh is found, with
   the fine-grained token steps below it.
3. No `PATH` fallback and no user-set path (a path the webview could set
   would let it choose what the backend runs).
4. Several gh accounts: the link uses gh's active account at the time of
   linking and stays pinned to it. No account picker yet.
5. After a 401, the next request asks gh again automatically. That is the
   point of a live link, and a revoked token still surfaces as an error.
6. gh 2.40+ is required (`--user`); older versions get a clear message.

### Not done yet

- An account picker when gh has several accounts (`gh auth status --json
  hosts`).
- Built-in queries for GitLab too; GitLab tokens are `read_api` only, so it
  still uses the mutation check.
- Manual testing on macOS (opened from Finder), Windows and a Linux desktop.
  Tests here cover the runner with fake `gh` scripts and the real gh binary
  with throwaway logins.
