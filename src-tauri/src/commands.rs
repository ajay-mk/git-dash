//! Commands exposed to the frontend. Each one must also be granted in
//! `capabilities/default.json`.

use serde_json::Value;
use tauri::{async_runtime, State};

use crate::error::{Error, Result};
use crate::github::GitHubClient;
use crate::graphql_guard;
use crate::token::{validate_format, Owner, Provider, Slot, TokenStore, TokenSummary};
use std::sync::Arc;

pub struct AppState {
    pub tokens: Arc<TokenStore>,
    pub github: GitHubClient,
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
/// account or organization. Returns the account login the token belongs to.
#[tauri::command]
pub async fn token_set(
    state: State<'_, AppState>,
    provider: String,
    token: String,
    owner: Option<String>,
) -> Result<String> {
    let provider = Provider::parse(&provider)?;
    let slot = Slot::from_owner(parse_owner(owner)?);
    let token = token.trim().to_owned();
    validate_format(&token)?;
    let login = match provider {
        Provider::GitHub => state.github.viewer_login(&token).await?,
    };
    let stored_login = login.clone();
    blocking(&state.tokens, move |t| {
        t.set(provider, &slot, &token, &stored_login)
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
