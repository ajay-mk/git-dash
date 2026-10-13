//! Commands exposed to the frontend. Each one must also be granted in
//! `capabilities/default.json`.

use reqwest::Url;
use serde_json::Value;
use tauri::{async_runtime, AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};
use crate::github::GitHubClient;
use crate::gitlab::{GitLabClient, Host, GITLAB_COM};
use crate::graphql_guard;
use crate::token::{validate_format, Owner, Provider, Slot, TokenStore, TokenSummary};
use std::sync::Arc;

pub struct AppState {
    pub tokens: Arc<TokenStore>,
    pub github: GitHubClient,
    pub gitlab: GitLabClient,
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

/// Executes a read-only GraphQL query against the GitHub API, using the token
/// configured for `owner` if there is one and the default token otherwise.
#[tauri::command]
pub async fn github_graphql(
    state: State<'_, AppState>,
    query: String,
    variables: Value,
    owner: Option<String>,
) -> Result<Value> {
    graphql_guard::ensure_read_only(&query)?;
    if !variables.is_object() || variables.to_string().len() > graphql_guard::MAX_QUERY_BYTES {
        return Err(Error::RequestTooLarge);
    }
    let owner = parse_owner(owner)?;
    let (slot, token) = blocking(&state.tokens, move |t| {
        t.resolve(Provider::GitHub, owner.as_ref())
    })
    .await?;
    let result = state.github.graphql(&token, &query, &variables).await;
    if matches!(result, Err(Error::Unauthorized)) {
        // Revoked or expired: make the next call re-read the keychain.
        state.tokens.forget_cached(Provider::GitHub, &slot);
    }
    result
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
