# Access tokens

GitDash reads GitHub, currently its only supported provider, with a personal
access token that you create. It is stored in your operating system's keychain
and never shown again after you save it. All requests are read-only; see [SECURITY.md](../SECURITY.md).

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
for it, GitHub reports the repository as not found.

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
results from per-owner tokens that belong to the same GitHub user,
de-duplicated. Items visible only to a token that belongs to a *different*
user are not shown, and per-owner tokens that fail are skipped there (their
repository cards show the error instead).
