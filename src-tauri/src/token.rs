//! Access-token storage backed by the operating system's keychain.
//!
//! Tokens never leave the Rust side of the app: the frontend can ask whether a
//! token exists, set a new one, or clear it, but it can never read it back.

use std::sync::Mutex;

use crate::error::{Error, Result};

const SERVICE: &str = "io.github.ajay-mk.git-dash";
const MAX_TOKEN_LEN: usize = 255;
const MIN_TOKEN_LEN: usize = 20;

/// Providers that can hold a token. Kept as an allow-list so the frontend
/// cannot create arbitrary keychain entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    GitHub,
}

impl Provider {
    pub fn parse(id: &str) -> Result<Self> {
        match id {
            "github" => Ok(Provider::GitHub),
            other => Err(Error::UnknownProvider(other.chars().take(32).collect())),
        }
    }

    fn account(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
        }
    }
}

/// Basic sanity check before a token is sent anywhere or stored.
///
/// GitHub tokens (classic `ghp_`, fine-grained `github_pat_`, OAuth `gho_`, ...)
/// only contain ASCII letters, digits and underscores.
pub fn validate_format(token: &str) -> Result<()> {
    let len = token.len();
    let charset_ok = token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if (MIN_TOKEN_LEN..=MAX_TOKEN_LEN).contains(&len) && charset_ok {
        Ok(())
    } else {
        Err(Error::InvalidTokenFormat)
    }
}

/// In-memory cache in front of the keychain, so we do not hit the keychain
/// (which may prompt the user on some platforms) for every request.
///
/// Deliberately does not implement `Debug` so the token cannot end up in logs.
#[derive(Default)]
pub struct TokenStore {
    github: Mutex<Option<String>>,
}

impl TokenStore {
    fn slot(&self, provider: Provider) -> &Mutex<Option<String>> {
        match provider {
            Provider::GitHub => &self.github,
        }
    }

    fn entry(provider: Provider) -> Result<keyring::Entry> {
        Ok(keyring::Entry::new(SERVICE, provider.account())?)
    }

    /// Returns the token, loading it from the keychain on first use.
    /// Blocking: call from a blocking-safe context.
    pub fn get(&self, provider: Provider) -> Result<String> {
        let mut slot = self.slot(provider).lock().map_err(|_| Error::Internal)?;
        if let Some(token) = slot.as_ref() {
            return Ok(token.clone());
        }
        let token = Self::entry(provider)?.get_password()?;
        *slot = Some(token.clone());
        Ok(token)
    }

    pub fn has(&self, provider: Provider) -> Result<bool> {
        match self.get(provider) {
            Ok(_) => Ok(true),
            Err(Error::NoToken) => Ok(false),
            Err(err) => Err(err),
        }
    }

    pub fn set(&self, provider: Provider, token: &str) -> Result<()> {
        validate_format(token)?;
        let mut slot = self.slot(provider).lock().map_err(|_| Error::Internal)?;
        Self::entry(provider)?.set_password(token)?;
        *slot = Some(token.to_owned());
        Ok(())
    }

    pub fn clear(&self, provider: Provider) -> Result<()> {
        let mut slot = self.slot(provider).lock().map_err(|_| Error::Internal)?;
        *slot = None;
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Drops the cached copy (e.g. after the provider rejected it) without
    /// touching the keychain.
    pub fn forget_cached(&self, provider: Provider) {
        if let Ok(mut slot) = self.slot(provider).lock() {
            *slot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_github_token_shapes() {
        assert!(validate_format("ghp_0123456789abcdefghijABCDEFGHIJ012345").is_ok());
        assert!(validate_format(&format!("github_pat_{}", "a1".repeat(40))).is_ok());
    }

    #[test]
    fn rejects_bad_tokens() {
        assert!(validate_format("").is_err());
        assert!(validate_format("short").is_err());
        assert!(validate_format("ghp_0123456789abcdef ghijABCDEFGHIJ").is_err());
        assert!(validate_format("ghp_0123456789abcdefghij\nABCDEFGHIJ").is_err());
        assert!(validate_format(&"a".repeat(MAX_TOKEN_LEN + 1)).is_err());
    }

    #[test]
    fn provider_allow_list() {
        assert_eq!(Provider::parse("github").unwrap(), Provider::GitHub);
        assert!(Provider::parse("evil").is_err());
    }
}
