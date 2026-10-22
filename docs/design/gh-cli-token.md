# Scoping: use the GitHub CLI's token

Status: proposal, not implemented.

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

**Scopes.** `gh auth login` asks for `repo`, `read:org` and `gist` by
default, plus `workflow` for some users. That is **write-capable** on every
repository the user can push to, broader than the fine-grained token we
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

**Build (a), one-time import.** It reuses all of `TokenStore` and the 401
handling, keeps GitDash working when gh is absent later, and needs no
runtime dependency on another program. The rotation cost is small because
`gho_` tokens don't expire on their own, and the reconnect screen can offer
the same one-click import. (b) can follow later as a setting if users
complain about re-importing; the source marker added for (a) is the first
step toward it.

**Rough size: 2-3 days.**

| Part | Estimate |
| --- | --- |
| Rust: `gh` locator, process runner (env, timeout, output cap), `gh_status` and `token_import_gh` commands, `source` in the index, tests with a fake `gh` script | 1-1.5 days |
| Frontend: setup button and account picker, Settings source label and import buttons, error messages, tests | 1 day |
| Docs: tokens.md section, SECURITY.md rows, manual test on macOS (Finder launch), Linux and Windows | 0.5 day |

## Open questions

1. Is a write-capable token stored by GitDash acceptable, given the
   recommendation has been read-only tokens so far? If not, (b) is the only
   option that avoids a stored copy.
2. Should the button be offered first on the setup screen, or stay
   secondary to the fine-grained token flow?
3. Should GitDash ever fall back to `PATH`, or only use the fixed install
   locations plus a user-set path?
4. For several gh accounts: always ask, or default to gh's active account?
5. Should the reconnect screen after a 401 re-import from gh automatically,
   or always wait for a click? (Automatic is close to (b) and hides
   revocations.)
6. Minimum gh version to support, or just require 2.40+ and `--user`?
