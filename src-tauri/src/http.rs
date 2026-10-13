//! HTTP plumbing shared by the provider clients.

use std::time::Duration;

use reqwest::redirect;

use crate::error::{Error, Result};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// An HTTPS-only client that never follows redirects, so a token only ever
/// goes to the endpoint it was sent to.
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("GitDash/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .redirect(redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Internal)
}

/// Reads a response body, refusing anything larger than 8 MiB.
pub async fn read_body(response: reqwest::Response) -> Result<Vec<u8>> {
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
