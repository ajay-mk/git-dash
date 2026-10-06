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
            .user_agent(concat!("git-dash/", env!("CARGO_PKG_VERSION")))
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
            status if !status.is_success() => return Err(Error::Http(status.as_u16())),
            _ => {}
        }

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
        serde_json::from_slice(&body).map_err(|_| Error::Network("invalid response".into()))
    }

    /// Checks a token by asking GitHub who it belongs to.
    pub async fn viewer_login(&self, token: &str) -> Result<String> {
        let body = self
            .graphql(token, "query { viewer { login } }", &json!({}))
            .await?;
        body.pointer("/data/viewer/login")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(Error::Unauthorized)
    }
}
