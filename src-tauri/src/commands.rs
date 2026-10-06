//! Commands exposed to the frontend. Each one must also be granted in
//! `capabilities/default.json`.

use serde_json::Value;
use tauri::{async_runtime, State};

use crate::error::{Error, Result};
use crate::github::GitHubClient;
use crate::graphql_guard;
use crate::token::{validate_format, Provider, TokenStore};
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

/// Whether a token is stored for `provider`. Never returns the token itself.
#[tauri::command]
pub async fn token_status(state: State<'_, AppState>, provider: String) -> Result<bool> {
    let provider = Provider::parse(&provider)?;
    blocking(&state.tokens, move |t| t.has(provider)).await
}

/// Verifies `token` with the provider, then stores it in the OS keychain.
/// Returns the account login the token belongs to.
#[tauri::command]
pub async fn token_set(
    state: State<'_, AppState>,
    provider: String,
    token: String,
) -> Result<String> {
    let provider = Provider::parse(&provider)?;
    let token = token.trim().to_owned();
    validate_format(&token)?;
    let login = match provider {
        Provider::GitHub => state.github.viewer_login(&token).await?,
    };
    blocking(&state.tokens, move |t| t.set(provider, &token)).await?;
    Ok(login)
}

#[tauri::command]
pub async fn token_clear(state: State<'_, AppState>, provider: String) -> Result<()> {
    let provider = Provider::parse(&provider)?;
    blocking(&state.tokens, move |t| t.clear(provider)).await
}

/// Executes a read-only GraphQL query against the GitHub API.
#[tauri::command]
pub async fn github_graphql(
    state: State<'_, AppState>,
    query: String,
    variables: Value,
) -> Result<Value> {
    graphql_guard::ensure_read_only(&query)?;
    if !variables.is_object() || variables.to_string().len() > graphql_guard::MAX_QUERY_BYTES {
        return Err(Error::RequestTooLarge);
    }
    let token = blocking(&state.tokens, |t| t.get(Provider::GitHub)).await?;
    let result = state.github.graphql(&token, &query, &variables).await;
    if matches!(result, Err(Error::Unauthorized)) {
        // Revoked or expired: make the next call re-read the keychain.
        state.tokens.forget_cached(Provider::GitHub);
    }
    result
}
