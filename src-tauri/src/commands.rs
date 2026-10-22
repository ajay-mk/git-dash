//! Commands exposed to the frontend. Each one must also be granted in
//! `capabilities/default.json`.

use reqwest::Url;
use serde_json::Value;
use tauri::{async_runtime, AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};
use crate::github::GitHubClient;
use crate::gitlab::{GitLabClient, Host, GITLAB_COM};
use crate::token::{validate_format, Owner, Provider, Resolved, Slot, TokenStore, TokenSummary};
use crate::{gh, github_queries, graphql_guard};
use std::sync::Arc;

pub struct AppState {
    pub tokens: Arc<TokenStore>,
    pub github: GitHubClient,
    pub gitlab: GitLabClient,
    /// Held while a token is read from the GitHub CLI, so requests that
    /// arrive together (as they do at startup) run gh once, not each.
    pub gh_read: async_runtime::Mutex<()>,
}

/// Runs a blocking keychain operation off the async runtime's worker threads.
async fn blocking<T, F>(tokens: &Arc<TokenStore>, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&TokenStore) -> Result<T> + Send + 'static,
{
    let tokens = Arc::clone(tokens);
    async_runtime::spawn_blocking(move || f(&tokens))
        .await
        .map_err(|_| Error::Internal)?
}

fn parse_owner(owner: Option<String>) -> Result<Option<Owner>> {
    owner.as_deref().map(Owner::parse).transpose()
}

/// Which tokens are stored for `provider` and whose they are. Never returns
/// a token itself.
#[tauri::command]
pub async fn token_list(state: State<'_, AppState>, provider: String) -> Result<TokenSummary> {
    let provider = Provider::parse(&provider)?;
    blocking(&state.tokens, move |t| t.summary(provider)).await
}

/// Verifies `token` with the provider, then stores it in the OS keychain,
/// either as the default token or, with `owner`, as the token for that
/// account or organization (GitHub only). For GitLab, `host` names the
/// instance (gitlab.com when left out); it is stored with the token, which is
/// only ever sent there. Returns the account login the token belongs to.
#[tauri::command]
pub async fn token_set(
    state: State<'_, AppState>,
    provider: String,
    token: String,
    owner: Option<String>,
    host: Option<String>,
) -> Result<String> {
    let provider = Provider::parse(&provider)?;
    let owner = parse_owner(owner)?;
    let token = token.trim().to_owned();
    validate_format(provider, &token)?;
    let (login, host) = match provider {
        Provider::GitHub => {
            if host.is_some() {
                return Err(Error::InvalidHost);
            }
            (state.github.viewer_login(&token).await?, None)
        }
        Provider::GitLab => {
            if owner.is_some() {
                return Err(Error::OwnerTokensUnsupported);
            }
            let host = Host::parse(host.as_deref().unwrap_or(GITLAB_COM))?;
            (state.gitlab.viewer_login(&host, &token).await?, Some(host))
        }
    };
    let slot = Slot::from_owner(owner);
    let stored_login = login.clone();
    blocking(&state.tokens, move |t| {
        t.set(provider, &slot, &token, &stored_login, host.as_ref())
    })
    .await?;
    Ok(login)
}

/// Removes the default token, or with `owner`, that owner's token.
#[tauri::command]
pub async fn token_clear(
    state: State<'_, AppState>,
    provider: String,
    owner: Option<String>,
) -> Result<()> {
    let provider = Provider::parse(&provider)?;
    let slot = Slot::from_owner(parse_owner(owner)?);
    blocking(&state.tokens, move |t| t.clear(provider, &slot)).await
}

/// Runs one of GitDash's own read-only GitHub queries (`github_queries.rs`),
/// named by `operation`, using the token configured for `owner` if there is
/// one and the default token otherwise. The frontend never sends query text.
#[tauri::command]
pub async fn github_graphql(
    state: State<'_, AppState>,
    operation: String,
    variables: Value,
    owner: Option<String>,
) -> Result<Value> {
    if variables.to_string().len() > graphql_guard::MAX_QUERY_BYTES {
        return Err(Error::RequestTooLarge);
    }
    let (query, variables) = github_queries::resolve(&operation, variables)?;
    // Defence in depth: the documents are ours, but check them anyway.
    graphql_guard::ensure_read_only(&query)?;
    let owner = parse_owner(owner)?;
    let resolved = blocking(&state.tokens, move |t| {
        t.resolve(Provider::GitHub, owner.as_ref())
    })
    .await?;
    let (slot, token) = match resolved {
        Resolved::Token { slot, token } => (slot, token),
        Resolved::FromGh { slot, login } => {
            let token = read_gh(&state, &slot, login).await?;
            (slot, token)
        }
    };
    let result = state.github.graphql(&token, &query, &variables).await;
    if matches!(result, Err(Error::Unauthorized)) {
        // Revoked or expired: make the next call re-read the keychain, or ask
        // the GitHub CLI again (which picks up `gh auth refresh`).
        state.tokens.forget_cached(Provider::GitHub, &slot);
    }
    result
}

/// Reads the token for a slot linked to the GitHub CLI account `login`. It is
/// used only once GitHub confirms it belongs to that account, so switching
/// accounts in gh cannot silently change whose data GitDash shows.
async fn read_gh(state: &State<'_, AppState>, slot: &Slot, login: String) -> Result<String> {
    let _one_at_a_time = state.gh_read.lock().await;
    // Whoever held the lock before may have just read it.
    if let Some(token) = state.tokens.cached_gh(Provider::GitHub, slot, &login) {
        return Ok(token);
    }
    let pinned = login.clone();
    let token = async_runtime::spawn_blocking(move || gh::token(Some(&pinned)))
        .await
        .map_err(|_| Error::Internal)??;
    let owner = state.github.viewer_login(&token).await?;
    if !owner.eq_ignore_ascii_case(&login) {
        return Err(Error::GhAccountMismatch);
    }
    state
        .tokens
        .remember_gh(Provider::GitHub, slot, &login, &token);
    Ok(token)
}

/// Whether the GitHub CLI is installed where GitDash looks for it, and where.
#[derive(serde::Serialize)]
pub struct GhStatus {
    path: Option<String>,
    /// Every place GitDash looks, for the setup instructions.
    searched: Vec<String>,
}

#[tauri::command]
pub async fn gh_status() -> Result<GhStatus> {
    let path = async_runtime::spawn_blocking(gh::locate)
        .await
        .map_err(|_| Error::Internal)?;
    Ok(GhStatus {
        path: path.map(|p| p.display().to_string()),
        searched: gh::searched(),
    })
}

/// Links the default slot, or with `owner` that owner's slot, to the account
/// the GitHub CLI is signed in to. GitDash keeps no copy of the token: it is
/// read from gh when needed. Returns the login the link is pinned to.
#[tauri::command]
pub async fn token_link_gh(state: State<'_, AppState>, owner: Option<String>) -> Result<String> {
    let slot = Slot::from_owner(parse_owner(owner)?);
    let token = async_runtime::spawn_blocking(|| gh::token(None))
        .await
        .map_err(|_| Error::Internal)??;
    let login = state.github.viewer_login(&token).await?;
    let pinned = login.clone();
    blocking(&state.tokens, move |t| {
        t.link_gh(Provider::GitHub, &slot, &pinned, &token)
    })
    .await?;
    Ok(login)
}

/// Executes a read-only GraphQL query against the GitLab instance the stored
/// token belongs to. The frontend cannot choose the host.
#[tauri::command]
pub async fn gitlab_graphql(
    state: State<'_, AppState>,
    query: String,
    variables: Value,
) -> Result<Value> {
    graphql_guard::ensure_read_only(&query)?;
    if !variables.is_object() || variables.to_string().len() > graphql_guard::MAX_QUERY_BYTES {
        return Err(Error::RequestTooLarge);
    }
    let (slot, token, host) =
        blocking(&state.tokens, |t| t.resolve_with_host(Provider::GitLab)).await?;
    let result = state
        .gitlab
        .graphql(&host, &token, &query, &variables)
        .await;
    if matches!(result, Err(Error::Unauthorized)) {
        state.tokens.forget_cached(Provider::GitLab, &slot);
    }
    result
}

/// Opens a web page in the system browser. Only GitHub, gitlab.com and the
/// connected GitLab instance are allowed, so untrusted API data cannot open
/// anything else.
#[tauri::command]
pub async fn open_external(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<()> {
    let url = Url::parse(&url).map_err(|_| Error::ForbiddenUrl)?;
    let checked = url.clone();
    if !blocking(&state.tokens, move |t| Ok(may_open(t, &checked))).await? {
        return Err(Error::ForbiddenUrl);
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| Error::Internal)
}

/// Whether `url` may be opened in the system browser. Reads the keychain
/// index, so call it off the main thread.
pub(crate) fn may_open(tokens: &TokenStore, url: &Url) -> bool {
    // A keychain problem must not stop GitHub links from opening.
    let gitlab = tokens.host(Provider::GitLab).ok().flatten();
    is_allowed_link(url, gitlab.as_ref())
}

/// GitHub and gitlab.com pages (where tokens are created before anything is
/// connected), plus pages on the connected GitLab instance.
fn is_allowed_link(url: &Url, gitlab: Option<&Host>) -> bool {
    let well_known = url.scheme() == "https"
        && matches!(url.host_str(), Some("github.com" | GITLAB_COM))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    well_known || gitlab.is_some_and(|host| host.serves(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_allow_list() {
        let url = |s: &str| Url::parse(s).unwrap();
        let gitlab = Host::parse("gitlab.example.com").unwrap();
        assert!(is_allowed_link(&url("https://github.com/a/b"), None));
        assert!(is_allowed_link(
            &url("https://gitlab.example.com/a/b"),
            Some(&gitlab)
        ));
        assert!(!is_allowed_link(
            &url("https://gitlab.example.com/a/b"),
            None
        ));
        // gitlab.com is always allowed: tokens are created there before connecting.
        assert!(is_allowed_link(
            &url("https://gitlab.com/-/user_settings/personal_access_tokens"),
            None
        ));
        assert!(!is_allowed_link(&url("https://gitlab.com:8443/a"), None));
        assert!(!is_allowed_link(
            &url("https://other.example.com/a"),
            Some(&gitlab)
        ));
        assert!(!is_allowed_link(&url("http://github.com/a"), None));
        assert!(!is_allowed_link(&url("https://github.com:8443/a"), None));
        assert!(!is_allowed_link(&url("https://x@github.com/a"), None));
        assert!(!is_allowed_link(
            &url("https://github.com.evil.com/a"),
            None
        ));
        assert!(!is_allowed_link(&url("https://gist.github.com/a"), None));
        assert!(!is_allowed_link(&url("javascript:alert(1)"), None));
        assert!(!is_allowed_link(&url("file:///etc/passwd"), Some(&gitlab)));
    }
}
