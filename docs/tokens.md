# Access tokens

GitDash reads GitHub and GitLab with personal access tokens that you create,
or for GitHub with your [GitHub CLI](#github-cli) login. Tokens are stored in
your operating system's keychain and never shown again after you save them. All requests are read-only; see
[SECURITY.md](../SECURITY.md). You can connect either service or both; the
rest of this page covers GitHub first, then [GitLab](#gitlab).

## Fine-grained token (recommended)

A fine-grained token needs *read-only* access to: Metadata, Contents, Pull requests, Issues, Commit statuses and
Actions. [This link](https://github.com/settings/personal-access-tokens/new?name=GitDash&description=Read-only+access+for+the+GitDash+dashboard&metadata=read&contents=read&pull_requests=read&issues=read&statuses=read&actions=read)
opens GitHub's token form with those permissions filled in; the setup screen
links to it too. You still choose *Repository access* yourself (*All
repositories* or a selection), because GitHub cannot fill that in from a link.
Repository access alone grants no permissions, so a token with *All
repositories* but no permissions cannot read anything. A fine-grained token is
limited to one account or organization.

## Classic token

Works across organizations. Public repositories need no scopes; private repositories need `repo`, which also grants write access.
GitDash only sends read-only queries, but prefer fine-grained tokens where
possible.

## Organizations with SAML SSO

A classic token must be authorized for each organization that enforces SSO: on <https://github.com/settings/tokens>, choose
*Configure SSO* next to the token and authorize the organization. You can do
this yourself; no admin is needed. An OAuth token (`gho_`, for example from
`gh auth token`) does not appear on that page: sign in through the
organization's SSO and authorize the app again instead. Until then, the
organization's repositories show an SSO error and the "Needs you" list notes
that some results are hidden.

## Organization token policies

An organization can require owner approval for fine-grained tokens, or forbid classic or long-lived tokens. While a
fine-grained token is pending approval, or when a repository was not selected
for it, GitHub reports the repository as not found. If the organization has
approved GitHub CLI, its login usually still works; see below.

## GitHub CLI

If [GitHub CLI](https://cli.github.com) (`gh`) is installed and signed in
(`gh auth login`), the setup screen offers **Use GitHub CLI login**. GitDash
then uses the account gh is signed in to:

- **No copy is stored.** GitDash records only which account it is linked to,
  and asks gh for the token when it needs one (`gh auth token`), keeping it in
  memory only. `gh auth refresh` and signing in again are picked up on their
  own; `gh auth logout` disconnects GitDash too, within a minute (GitDash asks
  gh again at least once a minute, since signing out does not revoke the token).
- **Organizations that block personal access tokens.** gh's token is an OAuth
  token. It can read an organization's private repositories when the
  organization has approved GitHub CLI as an OAuth app, which many have, even
  where fine-grained tokens need approval or are blocked. If the organization
  has not approved it, only public data is visible. For SAML SSO, sign in
  through the organization's SSO and authorize GitHub CLI again.
- **It can also make changes.** gh always asks GitHub for at least the `repo`,
  `read:org` and `gist` scopes, and GitHub has no read-only scope for private
  repositories. GitDash itself only ever runs its own read-only queries
  ([SECURITY.md](../SECURITY.md)), but prefer a fine-grained token where your
  organization allows one.
- **Pinned to one account.** GitDash links to the account gh is using at that
  moment and keeps using that account, even after `gh auth switch`. To link
  another account, switch gh to it first, then link again. In **Settings →
  Access tokens → Per-owner tokens**, enter an owner and choose **Use GitHub
  CLI** to use gh's login for just that owner.
- **Where gh must be installed.** GitDash only runs gh from its usual install
  locations, never from `PATH`; see [Setting up GitHub CLI](#setting-up-github-cli).
- GitDash never uses `GH_TOKEN` or `GITHUB_TOKEN`, even if they are set; only
  tokens gh itself stores are used. gh 2.40 or newer is needed.

### Setting up GitHub CLI

If the setup screen does not offer **Use GitHub CLI login**, open *Use your
GitHub CLI login instead* there (or in Settings under per-owner tokens) for
these steps with the exact locations for your system:

1. Install GitHub CLI: `brew install gh` on macOS, `winget install --id
   GitHub.cli` on Windows, or see the
   [install guide](https://github.com/cli/cli#installation).
2. In a terminal, run `gh auth login` and choose *GitHub.com*. With several
   accounts, `gh auth switch` picks the one GitDash should use.
3. Make sure gh is in one of the places GitDash looks:

   | System | Locations |
   | --- | --- |
   | macOS | `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` (MacPorts) |
   | Linux | `/usr/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/snap/bin`, `/run/current-system/sw/bin` (NixOS) |
   | macOS and Linux | `~/.nix-profile/bin`, `/nix/var/nix/profiles/default/bin` (Nix) |
   | Windows | `%ProgramFiles%\GitHub CLI` (official installer), `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `%ProgramData%\chocolatey\bin` |

   If `which gh` shows somewhere else (for example `~/.local/bin` or a
   version manager), link it into one of them:

   ```sh
   sudo mkdir -p /usr/local/bin && sudo ln -sf "$(which gh)" /usr/local/bin/gh
   ```

   On Windows, if `where gh` shows another location, install gh again with
   one of the installers above. GitDash refuses a gh that anyone could
   replace (one in, or linked from, a folder everyone can write to).
4. Choose **Check again**, then **Use GitHub CLI login**.

If GitDash then says GitHub CLI is not signed in, run `gh auth login` again
(or `gh auth status` to see which accounts gh knows). Once fixed in gh, the
next refresh works without linking again.

## Several accounts or organizations

GitDash keeps a **default token** plus optional **per-owner tokens**, so you
can use a fine-grained token for your personal repositories and another for
each organization:

1. Add the default token on first launch (usually one for your own account).
2. In **Settings → Access tokens → Per-owner tokens**, enter an account or
   organization name and a token for it. GitDash verifies the token with
   GitHub and shows the login it belongs to; the token itself is never shown
   again.
3. Pinned repositories owned by that account or organization are fetched with
   its token. All other repositories use the default token.

The **"Needs you"** sidebar searches with the default token, then merges in
results from per-owner tokens (or GitHub CLI links) that belong to the same
GitHub user,
de-duplicated. Items visible only to a token that belongs to a *different*
user are not shown, and per-owner tokens that fail are skipped there (their
repository cards show the error instead).

## GitLab

GitDash works with gitlab.com and with self-hosted GitLab 18 or newer that is
reachable over HTTPS. Certificates from a private certificate authority work
when your operating system trusts that authority. Choose **GitLab** on the setup screen, or **Settings →
Access tokens → Connect GitLab** once GitHub is connected.

1. Enter your instance, such as `gitlab.com` or `gitlab.example.com` (add the
   port if it is not 443).
2. Create a personal access token with only the **`read_api`** scope. On
   gitlab.com the setup screen links to the token form with the name and
   scope filled in; on a self-hosted instance it shows the address of that
   form (*User settings → Access tokens*).
3. Paste the token. GitDash checks it with that instance and shows the
   username it belongs to.

The instance is saved with the token, and the token is only ever sent to that
instance. One token covers every group and project your account can see, so
GitLab has no per-owner tokens. One GitLab instance can be connected at a
time; connecting another replaces it.

Pin a project in Settings with `group/project`, `group/subgroup/project` or a
link to any page of it; when both services are connected, pick the service
next to the field (a pasted link picks it for you). Merge requests fill the
pull request lists, the card's CI shows the latest pipeline on the default
branch, and the **"Needs you"** sidebar adds merge requests waiting on your
review, your own merge requests, and issues and merge requests assigned to
you.

Approval rules beyond what GitLab Free reports are not shown: a merge request
counts as approved once someone has approved it and GitLab reports no
missing approvals.
