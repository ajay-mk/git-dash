//! HTTP plumbing shared by the provider clients.

use std::time::Duration;

use reqwest::redirect;

use crate::error::{Error, Result};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// An HTTPS-only client that never follows redirects, so a token only ever
/// goes to the endpoint it was sent to.
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("IsItGreen/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .redirect(redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Internal)
}

/// Reads a response body, refusing anything larger than 8 MiB. The body is
/// read chunk by chunk, so a server that sends more than it announced (or
/// announces nothing) is cut off at the limit instead of being buffered.
pub async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
    {
        return Err(Error::RequestTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(Error::RequestTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
