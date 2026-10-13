//! Minimal GitLab GraphQL client, for gitlab.com or a self-hosted instance.
//!
//! The instance is chosen when a token is saved and stored next to it, so a
//! stored token is only ever sent to the host it was verified against.

use reqwest::{StatusCode, Url};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::http::{client, read_body};

pub const GITLAB_COM: &str = "gitlab.com";
const MAX_HOST_LEN: usize = 253;

/// A GitLab instance: a lowercase DNS name plus a port when it is not 443,
/// the same shape as `URL.host` in the browser. Always reached over HTTPS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Host(String);

impl Host {
    /// Accepts `gitlab.example.com`, `gitlab.example.com:8443` or the same
    /// with `https://` in front and an optional trailing slash. Paths,
    /// credentials, IP addresses and plain `http://` are rejected.
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim();
        let rest = match input.split_once("://") {
            Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => rest,
            Some(_) => return Err(Error::InvalidHost),
            None => input,
        };
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        if rest.is_empty()
            || rest.len() > MAX_HOST_LEN + 6
            || rest.contains(['/', '@', '?', '#', '\\'])
        {
            return Err(Error::InvalidHost);
        }
        let url = Url::parse(&format!("https://{rest}/")).map_err(|_| Error::InvalidHost)?;
        let domain = url.host_str().ok_or(Error::InvalidHost)?;
        // Only DNS names: no IP addresses, and at least one dot, which also
        // keeps out `localhost`.
        let is_ip = domain.starts_with('[') || domain.parse::<std::net::Ipv4Addr>().is_ok();
        if is_ip || !domain.contains('.') || domain.len() > MAX_HOST_LEN {
            return Err(Error::InvalidHost);
        }
        Ok(Host(match url.port() {
            Some(port) => format!("{domain}:{port}"),
            None => domain.to_owned(),
        }))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn graphql_endpoint(&self) -> String {
        format!("https://{}/api/graphql", self.0)
    }

    /// Whether `url` is a web page on this instance.
    pub fn serves(&self, url: &Url) -> bool {
        let host = match (url.host_str(), url.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            (None, _) => return false,
        };
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && host == self.0
    }
}

pub struct GitLabClient {
    http: reqwest::Client,
}

impl GitLabClient {
    pub fn new() -> Result<Self> {
        Ok(Self { http: client()? })
    }

    /// Sends a GraphQL request to `host` and returns the decoded JSON body,
    /// which may contain both `data` and `errors`.
    pub async fn graphql(
        &self,
        host: &Host,
        token: &str,
        query: &str,
        variables: &Value,
    ) -> Result<Value> {
        let response = self
            .http
            .post(host.graphql_endpoint())
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await?;

        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(Error::Unauthorized),
            StatusCode::TOO_MANY_REQUESTS => return Err(Error::RateLimited),
            StatusCode::FORBIDDEN => {
                // GitLab answers 403 `insufficient_scope` for a token without
                // `read_api` (e.g. `read_user` only).
                let body = read_body(response).await.unwrap_or_default();
                return Err(
                    if String::from_utf8_lossy(&body).contains("insufficient_scope") {
                        Error::InsufficientScope
                    } else {
                        Error::Http(StatusCode::FORBIDDEN.as_u16())
                    },
                );
            }
            status if !status.is_success() => return Err(Error::Http(status.as_u16())),
            _ => {}
        }

        let body = read_body(response).await?;
        serde_json::from_slice(&body).map_err(|_| Error::Network("invalid response".into()))
    }

    /// Checks a token by asking the instance who it belongs to.
    pub async fn viewer_login(&self, host: &Host, token: &str) -> Result<String> {
        let body = self
            .graphql(
                host,
                token,
                "query { currentUser { username } }",
                &json!({}),
            )
            .await?;
        login_from(&body)
    }
}

/// GitLab answers an unauthenticated request with `currentUser: null` rather
/// than an error, so that means the token was not accepted. A response with
/// errors instead says nothing about the token.
fn login_from(body: &Value) -> Result<String> {
    if let Some(login) = body
        .pointer("/data/currentUser/username")
        .and_then(Value::as_str)
    {
        return if is_valid_login(login) {
            Ok(login.to_owned())
        } else {
            Err(Error::Network("unexpected response".into()))
        };
    }
    let anonymous = body
        .pointer("/data/currentUser")
        .is_some_and(Value::is_null)
        && body.get("errors").is_none();
    Err(if anonymous {
        Error::Unauthorized
    } else {
        Error::Network("GitLab could not verify the token right now".into())
    })
}

/// Usernames as GitHub and GitLab allow them: ASCII letters, digits, `-`,
/// `_` and `.`. Kept short so they fit in the token index.
pub fn is_valid_login(login: &str) -> bool {
    (1..=255).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        for (input, host) in [
            ("gitlab.com", "gitlab.com"),
            ("GitLab.com", "gitlab.com"),
            ("https://gitlab.example.com/", "gitlab.example.com"),
            ("HTTPS://gitlab.example.com", "gitlab.example.com"),
            (" gitlab.example.com:8443 ", "gitlab.example.com:8443"),
            ("https://gitlab.example.com:443", "gitlab.example.com"),
        ] {
            assert_eq!(Host::parse(input).unwrap().as_str(), host, "{input}");
        }
    }

    #[test]
    fn rejects_unsafe_hosts() {
        for input in [
            "",
            "http://gitlab.example.com",
            "ftp://gitlab.example.com",
            "gitlab.example.com/api",
            "https://gitlab.example.com/group",
            "user@gitlab.example.com",
            "https://user:pass@gitlab.example.com",
            "gitlab.example.com?x=1",
            "gitlab.example.com#x",
            "127.0.0.1",
            "[::1]",
            "localhost",
            "gitlab .com",
            "gitlab.example.com:99999",
        ] {
            assert!(
                matches!(Host::parse(input), Err(Error::InvalidHost)),
                "{input:?} should be rejected"
            );
        }
    }

    #[test]
    fn endpoint_is_fixed_per_host() {
        assert_eq!(
            Host::parse("gitlab.example.com:8443")
                .unwrap()
                .graphql_endpoint(),
            "https://gitlab.example.com:8443/api/graphql"
        );
    }

    #[test]
    fn serves_only_its_own_pages() {
        let host = Host::parse("gitlab.example.com").unwrap();
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(host.serves(&url("https://gitlab.example.com/a/b/-/merge_requests/1")));
        assert!(host.serves(&url("https://gitlab.example.com:443/a")));
        assert!(!host.serves(&url("http://gitlab.example.com/a")));
        assert!(!host.serves(&url("https://gitlab.example.com:8443/a")));
        assert!(!host.serves(&url("https://gitlab.example.com.evil.com/a")));
        assert!(!host.serves(&url("https://user@gitlab.example.com/a")));
        let with_port = Host::parse("gitlab.example.com:8443").unwrap();
        assert!(with_port.serves(&url("https://gitlab.example.com:8443/a")));
        assert!(!with_port.serves(&url("https://gitlab.example.com/a")));
    }

    #[test]
    fn reads_the_current_user() {
        let body = json!({ "data": { "currentUser": { "username": "jane.doe" } } });
        assert_eq!(login_from(&body).unwrap(), "jane.doe");
    }

    #[test]
    fn anonymous_answers_mean_the_token_was_not_accepted() {
        let body = json!({ "data": { "currentUser": null } });
        assert!(matches!(login_from(&body), Err(Error::Unauthorized)));
    }

    #[test]
    fn errors_do_not_count_as_a_rejected_token() {
        let body = json!({ "data": { "currentUser": null }, "errors": [{ "message": "timeout" }] });
        assert!(matches!(login_from(&body), Err(Error::Network(_))));
        assert!(matches!(login_from(&json!({})), Err(Error::Network(_))));
    }

    #[test]
    fn rejects_odd_logins() {
        let body = json!({ "data": { "currentUser": { "username": "<script>" } } });
        assert!(login_from(&body).is_err());
        assert!(is_valid_login("a_b.c-d"));
        assert!(!is_valid_login(""));
        assert!(!is_valid_login("a b"));
        assert!(!is_valid_login("a:b"));
    }
}
