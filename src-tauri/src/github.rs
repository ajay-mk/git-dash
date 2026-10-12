//! Minimal GitHub GraphQL client. The token is attached here and nowhere else.

use std::time::Duration;

use reqwest::{header, redirect, StatusCode};
use serde_json::{json, Value};

use crate::error::{Error, Result};

const GRAPHQL_ENDPOINT: &str = "https://api.github.com/graphql";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub struct GitHubClient {
    http: reqwest::Client,
}

impl GitHubClient {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("GitDash/", env!("CARGO_PKG_VERSION")))
            .https_only(true)
            // Never follow redirects: the token must only ever go to the
            // fixed GitHub API endpoint.
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| Error::Internal)?;
        Ok(Self { http })
    }

    /// Sends a GraphQL request and returns the decoded JSON body, which may
    /// contain both `data` and `errors` (GraphQL partial results).
    pub async fn graphql(&self, token: &str, query: &str, variables: &Value) -> Result<Value> {
        let response = self
            .http
            .post(GRAPHQL_ENDPOINT)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::ACCEPT, "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await?;

        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(Error::Unauthorized),
            status if is_rate_limited(status, response.headers()) => {
                return Err(Error::RateLimited)
            }
            StatusCode::FORBIDDEN => {
                // The rate-limit headers are optional, so also check the body.
                let body = read_body(response).await.unwrap_or_default();
                return Err(if mentions_rate_limit(&body) {
                    Error::RateLimited
                } else {
                    Error::Http(StatusCode::FORBIDDEN.as_u16())
                });
            }
            status if !status.is_success() => return Err(Error::Http(status.as_u16())),
            _ => {}
        }

        let body = read_body(response).await?;
        serde_json::from_slice(&body).map_err(|_| Error::Network("invalid response".into()))
    }

    /// Checks a token by asking GitHub who it belongs to.
    pub async fn viewer_login(&self, token: &str) -> Result<String> {
        let body = self
            .graphql(token, "query { viewer { login } }", &json!({}))
            .await?;
        login_from(&body)
    }
}

/// A bad token gets HTTP 401 before this point. A 200 without a login means
/// GitHub answered with errors instead (e.g. a rate limit), which says
/// nothing about the token itself.
fn login_from(body: &Value) -> Result<String> {
    body.pointer("/data/viewer/login")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Network("GitHub could not verify the token right now".into()))
}

async fn read_body(response: reqwest::Response) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_RESPONSE_BYTES)
    {
        return Err(Error::RequestTooLarge);
    }
    let body = response.bytes().await?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(Error::RequestTooLarge);
    }
    Ok(body.to_vec())
}

/// A 403 without rate-limit headers can still be a secondary rate limit;
/// GitHub then says so in the message ("You have exceeded a secondary rate
/// limit").
fn mentions_rate_limit(body: &[u8]) -> bool {
    String::from_utf8_lossy(body)
        .to_ascii_lowercase()
        .contains("rate limit")
}

/// GitHub signals secondary rate limits with 429, or with 403 plus either
/// `retry-after` or `x-ratelimit-remaining: 0`. Other 403s are checked with
/// `mentions_rate_limit`.
fn is_rate_limited(status: StatusCode, headers: &header::HeaderMap) -> bool {
    match status {
        StatusCode::TOO_MANY_REQUESTS => true,
        StatusCode::FORBIDDEN => {
            headers.contains_key(header::RETRY_AFTER)
                || headers
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v.as_bytes() == b"0")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> header::HeaderMap {
        let mut map = header::HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, header::HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn detects_rate_limits() {
        assert!(is_rate_limited(
            StatusCode::TOO_MANY_REQUESTS,
            &headers(&[])
        ));
        assert!(is_rate_limited(
            StatusCode::FORBIDDEN,
            &headers(&[("retry-after", "60")])
        ));
        assert!(is_rate_limited(
            StatusCode::FORBIDDEN,
            &headers(&[("x-ratelimit-remaining", "0")])
        ));
    }

    #[test]
    fn detects_rate_limits_from_the_body() {
        let body = br#"{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}"#;
        assert!(mentions_rate_limit(body));
        assert!(!mentions_rate_limit(
            br#"{"message":"Resource not accessible by personal access token"}"#
        ));
        assert!(!mentions_rate_limit(b""));
    }

    #[test]
    fn other_forbidden_responses_are_not_rate_limits() {
        assert!(!is_rate_limited(StatusCode::FORBIDDEN, &headers(&[])));
        assert!(!is_rate_limited(
            StatusCode::FORBIDDEN,
            &headers(&[("x-ratelimit-remaining", "12")])
        ));
        assert!(!is_rate_limited(
            StatusCode::OK,
            &headers(&[("retry-after", "60")])
        ));
    }

    #[test]
    fn reads_the_viewer_login() {
        let body = json!({ "data": { "viewer": { "login": "octocat" } } });
        assert_eq!(login_from(&body).unwrap(), "octocat");
    }

    #[test]
    fn graphql_errors_do_not_count_as_a_rejected_token() {
        let body =
            json!({ "errors": [{ "type": "RATE_LIMITED", "message": "API rate limit exceeded" }] });
        assert!(matches!(login_from(&body), Err(Error::Network(_))));
    }
}
