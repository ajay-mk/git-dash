use serde::Serialize;

/// Errors returned to the frontend.
///
/// Messages are written by us and never include the access token or raw
/// response bodies, so they are safe to display.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("No access token configured")]
    NoToken,
    #[error("The access token was rejected by the provider")]
    Unauthorized,
    #[error("Invalid access token format")]
    InvalidTokenFormat,
    #[error("Invalid account or organization name")]
    InvalidOwner,
    #[error("Enter the address of a GitLab instance, such as gitlab.com or gitlab.example.com")]
    InvalidHost,
    #[error("Only GitHub uses tokens per account or organization")]
    OwnerTokensUnsupported,
    #[error("The token is missing the read_api scope")]
    InsufficientScope,
    #[error("Only links to GitHub or your GitLab instance can be opened")]
    ForbiddenUrl,
    #[error("Too many access tokens; remove one first")]
    TooManyTokens,
    #[error("Only read-only GraphQL queries are allowed")]
    ForbiddenOperation,
    #[error("Request too large")]
    RequestTooLarge,
    #[error("Unsupported provider: {0}")]
    UnknownProvider(String),
    #[error("API rate limit reached; try again later")]
    RateLimited,
    #[error("Provider returned HTTP {0}")]
    Http(u16),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Secure storage error: {0}")]
    Keyring(String),
    #[error("Internal error")]
    Internal,
}

impl Error {
    fn kind(&self) -> &'static str {
        match self {
            Error::NoToken => "no_token",
            Error::Unauthorized => "unauthorized",
            Error::InvalidTokenFormat => "invalid_token_format",
            Error::InvalidOwner => "invalid_owner",
            Error::InvalidHost => "invalid_host",
            Error::OwnerTokensUnsupported => "owner_tokens_unsupported",
            Error::InsufficientScope => "insufficient_scope",
            Error::ForbiddenUrl => "forbidden_url",
            Error::TooManyTokens => "too_many_tokens",
            Error::ForbiddenOperation => "forbidden_operation",
            Error::RequestTooLarge => "request_too_large",
            Error::UnknownProvider(_) => "unknown_provider",
            Error::RateLimited => "rate_limited",
            Error::Http(_) => "http",
            Error::Network(_) => "network",
            Error::Keyring(_) => "keyring",
            Error::Internal => "internal",
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(err: reqwest::Error) -> Self {
        // `without_url` keeps request URLs out of messages; headers (and thus
        // the token) are never part of reqwest's error formatting.
        let err = err.without_url();
        if err.is_timeout() {
            Error::Network("request timed out".into())
        } else if err.is_connect() {
            Error::Network("could not connect".into())
        } else if err.is_decode() {
            Error::Network("invalid response".into())
        } else {
            Error::Network("request failed".into())
        }
    }
}

impl From<keyring::Error> for Error {
    fn from(err: keyring::Error) -> Self {
        match err {
            keyring::Error::NoEntry => Error::NoToken,
            keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
                Error::Keyring("the system keychain is unavailable".into())
            }
            _ => Error::Keyring("could not access the system keychain".into()),
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
