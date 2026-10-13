//! Access-token storage backed by the operating system's keychain.
//!
//! Tokens never leave the Rust side of the app: the frontend can ask which
//! tokens exist, set a new one, or clear one, but it can never read one back.
//!
//! Each provider has a *default* token plus optional *per-owner* tokens keyed
//! by account/organization login. Fine-grained GitHub tokens are limited to a
//! single resource owner, so per-owner tokens let one app cover a personal
//! account and several organizations at once.

use std::collections::{hash_map, BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::gitlab::{is_valid_login, Host};

const SERVICE: &str = "io.github.ajay-mk.gitdash";
/// Service name used before the rename to GitDash. Entries found there are
/// moved to [`SERVICE`] the first time they are read.
const LEGACY_SERVICE: &str = "io.github.ajay-mk.git-dash";
const MAX_TOKEN_LEN: usize = 255;
const MIN_TOKEN_LEN: usize = 20;
const MAX_OWNER_LEN: usize = 39;
/// Upper bound on per-owner tokens, which also bounds the index entry size.
pub const MAX_OWNER_TOKENS: usize = 20;

/// Providers that can hold a token. Kept as an allow-list so the frontend
/// cannot create arbitrary keychain entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    pub fn parse(id: &str) -> Result<Self> {
        match id {
            "github" => Ok(Provider::GitHub),
            "gitlab" => Ok(Provider::GitLab),
            other => Err(Error::UnknownProvider(other.chars().take(32).collect())),
        }
    }

    fn account(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
        }
    }
}

/// A validated account or organization login, normalised to lowercase
/// (GitHub logins are case-insensitive).
///
/// Uses the same rules as `OWNER_RE` in `src/config/schema.ts`: 1-39 ASCII
/// letters, digits or hyphens, starting with a letter or digit. This keeps
/// keychain entry names to a fixed, predictable shape.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Owner(String);

impl Owner {
    pub fn parse(login: &str) -> Result<Self> {
        let bytes = login.as_bytes();
        let valid = (1..=MAX_OWNER_LEN).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-');
        if valid {
            Ok(Owner(login.to_ascii_lowercase()))
        } else {
            Err(Error::InvalidOwner)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Which token of a provider: the default one or the one for an owner.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Slot {
    Default,
    Owner(Owner),
}

impl Slot {
    pub fn from_owner(owner: Option<Owner>) -> Self {
        owner.map_or(Slot::Default, Slot::Owner)
    }

    /// Keychain account name. The default slot keeps the pre-multi-token name
    /// so existing installs keep working. Owners cannot contain ':', so owner
    /// entries can never collide with each other or with the index entry.
    fn account(&self, provider: Provider) -> String {
        match self {
            Slot::Default => provider.account().to_owned(),
            Slot::Owner(owner) => format!("{}:owner:{}", provider.account(), owner.as_str()),
        }
    }
}

fn index_account(provider: Provider) -> String {
    format!("{}:index", provider.account())
}

/// Basic sanity check before a token is sent anywhere or stored.
///
/// GitHub tokens (classic `ghp_`, fine-grained `github_pat_`, OAuth `gho_`, ...)
/// only contain ASCII letters, digits and underscores. GitLab tokens
/// (`glpat-...`, newer ones with `.`-separated parts) also use `-` and `.`,
/// and a self-hosted instance's custom token prefix may add `+=/@:`.
pub fn validate_format(provider: Provider, token: &str) -> Result<()> {
    let len = token.len();
    let charset_ok = token.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || b == b'_'
            || (provider == Provider::GitLab && b"-.+=/@:".contains(&b))
    });
    if (MIN_TOKEN_LEN..=MAX_TOKEN_LEN).contains(&len) && charset_ok {
        Ok(())
    } else {
        Err(Error::InvalidTokenFormat)
    }
}

/// Non-secret bookkeeping stored next to the tokens: which owners have a
/// token, the login each token belongs to (the keychain cannot be
/// enumerated portably), and for GitLab the instance the default token is for.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    default_login: Option<String>,
    /// GitLab only: the instance the default token was verified against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    /// Owner -> login of the account the token belongs to.
    #[serde(default)]
    owners: BTreeMap<String, String>,
}

impl Index {
    /// Parses a stored index, dropping anything malformed instead of failing,
    /// so a damaged entry can never lock the user out.
    fn decode(raw: &str) -> Self {
        let Ok(index) = serde_json::from_str::<Index>(raw) else {
            return Index::default();
        };
        let valid_login = |l: &String| is_valid_login(l);
        Index {
            default_login: index.default_login.filter(valid_login),
            host: index
                .host
                .filter(|h| Host::parse(h).is_ok_and(|p| p.as_str() == h)),
            owners: index
                .owners
                .into_iter()
                .filter(|(owner, login)| {
                    Owner::parse(owner).is_ok_and(|o| o.as_str() == owner) && valid_login(login)
                })
                .take(MAX_OWNER_TOKENS)
                .collect(),
        }
    }

    fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

/// What the frontend may learn about the stored tokens. Never the tokens.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenSummary {
    pub has_default: bool,
    pub default_login: Option<String>,
    /// GitLab only: the instance the default token is for.
    pub host: Option<String>,
    pub owners: Vec<OwnerToken>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct OwnerToken {
    pub owner: String,
    pub login: String,
}

#[derive(Default)]
struct Inner {
    cache: HashMap<(Provider, Slot), String>,
    indexes: HashMap<Provider, Index>,
}

/// In-memory cache in front of the keychain, so we do not hit the keychain
/// (which may prompt the user on some platforms) for every request.
///
/// Deliberately does not implement `Debug` so tokens cannot end up in logs.
#[derive(Default)]
pub struct TokenStore {
    inner: Mutex<Inner>,
}

fn entry(account: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, account)?)
}

fn legacy_entry(account: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(LEGACY_SERVICE, account)?)
}

/// Reads `account`, moving it over from the legacy service if it only exists
/// there. Removing the legacy copy is best effort: [`TokenStore::clear`]
/// deletes both, so a leftover copy cannot bring a cleared token back.
fn read(account: &str) -> Result<String> {
    Ok(read_or_migrate(&entry(account)?, &legacy_entry(account)?)?)
}

fn read_or_migrate(current: &keyring::Entry, legacy: &keyring::Entry) -> keyring::Result<String> {
    match current.get_password() {
        Err(keyring::Error::NoEntry) => {}
        other => return other,
    }
    let secret = legacy.get_password()?;
    current.set_password(&secret)?;
    let _ = legacy.delete_credential();
    Ok(secret)
}

fn delete(entry: &keyring::Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

impl Inner {
    fn index(&mut self, provider: Provider) -> Result<&mut Index> {
        match self.indexes.entry(provider) {
            hash_map::Entry::Occupied(e) => Ok(e.into_mut()),
            hash_map::Entry::Vacant(e) => {
                let index = match read(&index_account(provider)) {
                    Ok(raw) => Index::decode(&raw),
                    Err(Error::NoToken) => Index::default(),
                    Err(err) => return Err(err),
                };
                Ok(e.insert(index))
            }
        }
    }

    fn save_index(&mut self, provider: Provider) -> Result<()> {
        let raw = self.index(provider)?.encode();
        entry(&index_account(provider))?.set_password(&raw)?;
        Ok(())
    }

    fn get(&mut self, provider: Provider, slot: &Slot) -> Result<String> {
        let key = (provider, slot.clone());
        if let Some(token) = self.cache.get(&key) {
            return Ok(token.clone());
        }
        let token = read(&slot.account(provider))?;
        self.cache.insert(key, token.clone());
        Ok(token)
    }
}

impl TokenStore {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.inner.lock().map_err(|_| Error::Internal)
    }

    /// Picks the token that serves `owner`: that owner's own token if one is
    /// configured, otherwise the default token. Returns the slot used, so the
    /// caller can forget it if the provider rejects it.
    /// Blocking: call from a blocking-safe context.
    pub fn resolve(&self, provider: Provider, owner: Option<&Owner>) -> Result<(Slot, String)> {
        let mut inner = self.lock()?;
        if let Some(owner) = owner {
            if inner.index(provider)?.owners.contains_key(owner.as_str()) {
                let slot = Slot::Owner(owner.clone());
                match inner.get(provider, &slot) {
                    Ok(token) => return Ok((slot, token)),
                    // Removed from the keychain behind our back: fall back.
                    Err(Error::NoToken) => {}
                    Err(err) => return Err(err),
                }
            }
        }
        let token = inner.get(provider, &Slot::Default)?;
        Ok((Slot::Default, token))
    }

    pub fn summary(&self, provider: Provider) -> Result<TokenSummary> {
        let mut inner = self.lock()?;
        let stored = match inner.get(provider, &Slot::Default) {
            Ok(_) => true,
            Err(Error::NoToken) => false,
            Err(err) => return Err(err),
        };
        let index = inner.index(provider)?;
        // A GitLab token is only usable with the instance it was verified
        // against; one left without it by an interrupted write must be
        // entered again, host included.
        let has_default = stored && (provider != Provider::GitLab || index.host.is_some());
        Ok(TokenSummary {
            has_default,
            default_login: index.default_login.clone().filter(|_| has_default),
            host: index.host.clone().filter(|_| has_default),
            owners: index
                .owners
                .iter()
                .map(|(owner, login)| OwnerToken {
                    owner: owner.clone(),
                    login: login.clone(),
                })
                .collect(),
        })
    }

    /// The default token together with the instance it was verified against,
    /// read under one lock so a concurrent `set` cannot pair a token with
    /// another token's host. Blocking: call from a blocking-safe context.
    pub fn resolve_with_host(&self, provider: Provider) -> Result<(Slot, String, Host)> {
        let mut inner = self.lock()?;
        let host = inner
            .index(provider)?
            .host
            .as_deref()
            .and_then(|h| Host::parse(h).ok())
            .ok_or(Error::NoToken)?;
        let token = inner.get(provider, &Slot::Default)?;
        Ok((Slot::Default, token, host))
    }

    /// The GitLab instance the default token was verified against.
    pub fn host(&self, provider: Provider) -> Result<Option<Host>> {
        let mut inner = self.lock()?;
        Ok(inner
            .index(provider)?
            .host
            .as_deref()
            .and_then(|h| Host::parse(h).ok()))
    }

    /// Stores `token` (already verified to belong to `login`, on `host` for
    /// GitLab) in `slot`.
    pub fn set(
        &self,
        provider: Provider,
        slot: &Slot,
        token: &str,
        login: &str,
        host: Option<&Host>,
    ) -> Result<()> {
        validate_format(provider, token)?;
        let mut inner = self.lock()?;
        if let Slot::Owner(owner) = slot {
            let owners = &inner.index(provider)?.owners;
            if !owners.contains_key(owner.as_str()) && owners.len() >= MAX_OWNER_TOKENS {
                return Err(Error::TooManyTokens);
            }
        }
        // The stored host decides where the default token is sent, so a new
        // token must never be paired with an old host, even if a keychain
        // write fails halfway. Unbind the host first and bind it again only
        // once the token is stored: an interrupted change leaves no host,
        // which fails closed (nothing is sent) until the token is entered again.
        let previous = inner.index(provider)?.clone();
        let unbind = matches!(slot, Slot::Default) && previous.host.is_some();
        if unbind {
            let index = inner.index(provider)?;
            index.host = None;
            index.default_login = None;
            if let Err(err) = inner.save_index(provider) {
                *inner.index(provider)? = previous;
                return Err(err);
            }
        }
        let stored = entry(&slot.account(provider)).and_then(|e| Ok(e.set_password(token)?));
        if let Err(err) = stored {
            if unbind {
                // The old token is still in place, so its host can be restored.
                *inner.index(provider)? = previous;
                let _ = inner.save_index(provider);
            }
            return Err(err);
        }
        inner
            .cache
            .insert((provider, slot.clone()), token.to_owned());
        let index = inner.index(provider)?;
        let unbound = index.clone();
        match slot {
            Slot::Default => {
                index.default_login = Some(login.to_owned());
                index.host = host.map(|h| h.as_str().to_owned());
            }
            Slot::Owner(owner) => {
                index
                    .owners
                    .insert(owner.as_str().to_owned(), login.to_owned());
            }
        }
        let saved = inner.save_index(provider);
        if saved.is_err() && provider == Provider::GitLab && matches!(slot, Slot::Default) {
            // Keep memory in line with the stored index, and drop the token
            // so it is not left behind without the host it belongs to.
            *inner.index(provider)? = unbound;
            inner.cache.remove(&(provider, slot.clone()));
            if let Ok(e) = entry(&slot.account(provider)) {
                let _ = delete(&e);
            }
        }
        saved
    }

    pub fn clear(&self, provider: Provider, slot: &Slot) -> Result<()> {
        let mut inner = self.lock()?;
        inner.cache.remove(&(provider, slot.clone()));
        let account = slot.account(provider);
        delete(&entry(&account)?)?;
        delete(&legacy_entry(&account)?)?;
        let index = inner.index(provider)?;
        match slot {
            Slot::Default => {
                index.default_login = None;
                index.host = None;
            }
            Slot::Owner(owner) => {
                index.owners.remove(owner.as_str());
            }
        }
        inner.save_index(provider)
    }

    /// Drops the cached copy (e.g. after the provider rejected it) without
    /// touching the keychain.
    pub fn forget_cached(&self, provider: Provider, slot: &Slot) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.cache.remove(&(provider, slot.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_github_token_shapes() {
        let gh = Provider::GitHub;
        assert!(validate_format(gh, "ghp_0123456789abcdefghijABCDEFGHIJ012345").is_ok());
        assert!(validate_format(gh, &format!("github_pat_{}", "a1".repeat(40))).is_ok());
        assert!(validate_format(gh, "glpat-0123456789abcdefghij").is_err());
    }

    #[test]
    fn accepts_gitlab_token_shapes() {
        let gl = Provider::GitLab;
        assert!(validate_format(gl, "glpat-0123456789abcdefghij").is_ok());
        assert!(validate_format(gl, "glpat-AbCdEf0123456789_xYz.01.0w1a2b3c4").is_ok());
        assert!(validate_format(gl, "glpat-0123456789 abcdefghij").is_err());
        assert!(validate_format(gl, "corp+pat=/@:-0123456789abcdefghij").is_ok());
        assert!(validate_format(gl, "glpat-0123456789\nabcdefghij").is_err());
        assert!(validate_format(gl, "glpat-0123456789%abcdefghij").is_err());
    }

    #[test]
    fn rejects_bad_tokens() {
        for provider in [Provider::GitHub, Provider::GitLab] {
            assert!(validate_format(provider, "").is_err());
            assert!(validate_format(provider, "short").is_err());
            assert!(validate_format(provider, "ghp_0123456789abcdef ghijABCDEFGHIJ").is_err());
            assert!(validate_format(provider, "ghp_0123456789abcdefghij\nABCDEFGHIJ").is_err());
            assert!(validate_format(provider, &"a".repeat(MAX_TOKEN_LEN + 1)).is_err());
        }
    }

    #[test]
    fn provider_allow_list() {
        assert_eq!(Provider::parse("github").unwrap(), Provider::GitHub);
        assert_eq!(Provider::parse("gitlab").unwrap(), Provider::GitLab);
        assert_eq!(Slot::Default.account(Provider::GitLab), "gitlab");
        assert_eq!(index_account(Provider::GitLab), "gitlab:index");
        assert!(Provider::parse("evil").is_err());
    }

    #[test]
    fn owner_validation_matches_frontend_rules() {
        for ok in ["a", "ajay-mk", "Acme-Corp", "0rg", &"a".repeat(39)] {
            assert!(Owner::parse(ok).is_ok(), "{ok} should be valid");
        }
        for bad in [
            "",
            "-acme",
            "acme_corp",
            "acme corp",
            "acme:index",
            "acme/repo",
            "../acme",
            "acmé",
            &"a".repeat(40),
        ] {
            assert!(
                matches!(Owner::parse(bad), Err(Error::InvalidOwner)),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn owner_is_case_insensitive() {
        assert_eq!(Owner::parse("Acme").unwrap(), Owner::parse("acme").unwrap());
        assert_eq!(Owner::parse("Acme").unwrap().as_str(), "acme");
    }

    #[test]
    fn keychain_account_names() {
        let gh = Provider::GitHub;
        // Unchanged from the single-token layout, so existing tokens still load.
        assert_eq!(Slot::Default.account(gh), "github");
        assert_eq!(
            Slot::Owner(Owner::parse("Acme-Corp").unwrap()).account(gh),
            "github:owner:acme-corp"
        );
        assert_eq!(index_account(gh), "github:index");
        assert_eq!(Slot::from_owner(None), Slot::Default);
    }

    #[test]
    fn owner_accounts_never_collide_with_reserved_names() {
        let gh = Provider::GitHub;
        for owner in ["index", "github", "owner"] {
            let account = Slot::Owner(Owner::parse(owner).unwrap()).account(gh);
            assert_ne!(account, Slot::Default.account(gh));
            assert_ne!(account, index_account(gh));
        }
    }

    fn mock_entry(account: &str) -> keyring::Entry {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        keyring::Entry::new(SERVICE, account).unwrap()
    }

    #[test]
    fn legacy_entries_move_to_the_new_service() {
        let (current, legacy) = (mock_entry("github"), mock_entry("github"));
        legacy.set_password("old-token").unwrap();
        assert_eq!(read_or_migrate(&current, &legacy).unwrap(), "old-token");
        assert_eq!(current.get_password().unwrap(), "old-token");
        assert!(matches!(
            legacy.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn current_entries_win_over_legacy_ones() {
        let (current, legacy) = (mock_entry("github"), mock_entry("github"));
        current.set_password("new-token").unwrap();
        legacy.set_password("old-token").unwrap();
        assert_eq!(read_or_migrate(&current, &legacy).unwrap(), "new-token");
        assert_eq!(legacy.get_password().unwrap(), "old-token");
    }

    #[test]
    fn missing_everywhere_is_no_entry() {
        let (current, legacy) = (mock_entry("github"), mock_entry("github"));
        assert!(matches!(
            read_or_migrate(&current, &legacy),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn index_round_trips() {
        let mut index = Index {
            default_login: Some("ajay-mk".into()),
            host: Some("gitlab.example.com:8443".into()),
            ..Index::default()
        };
        index.owners.insert("acme".into(), "ajay-mk".into());
        assert_eq!(Index::decode(&index.encode()), index);
    }

    #[test]
    fn index_decode_drops_malformed_entries() {
        let raw = r#"{
            "default_login": "bad login",
            "host": "https://evil.example.com/x",
            "owners": { "acme": "ajay-mk", "Upper": "x", "bad:owner": "x", "ok": "<script>" }
        }"#;
        let index = Index::decode(raw);
        assert_eq!(index.default_login, None);
        assert_eq!(index.host, None);
        assert_eq!(index.owners.len(), 1);
        assert_eq!(
            index.owners.get("acme").map(String::as_str),
            Some("ajay-mk")
        );

        assert_eq!(Index::decode("not json"), Index::default());
        assert_eq!(Index::decode("[]"), Index::default());
    }

    fn store_with(provider: Provider, host: Option<&str>) -> TokenStore {
        let store = TokenStore::default();
        {
            let mut inner = store.lock().unwrap();
            inner
                .cache
                .insert((provider, Slot::Default), "glpat-token".into());
            let index = Index {
                default_login: Some("jane.doe".into()),
                host: host.map(str::to_owned),
                ..Index::default()
            };
            inner.indexes.insert(provider, index);
        }
        store
    }

    #[test]
    fn a_gitlab_token_without_its_instance_is_not_connected() {
        let bound = store_with(Provider::GitLab, Some("gitlab.example.com"));
        assert!(bound.summary(Provider::GitLab).unwrap().has_default);
        let unbound = store_with(Provider::GitLab, None);
        let summary = unbound.summary(Provider::GitLab).unwrap();
        assert!(!summary.has_default);
        assert_eq!(summary.default_login, None);
        assert!(
            store_with(Provider::GitHub, None)
                .summary(Provider::GitHub)
                .unwrap()
                .has_default
        );
    }

    #[test]
    fn index_decode_caps_owner_count() {
        let owners: BTreeMap<String, String> = (0..MAX_OWNER_TOKENS + 5)
            .map(|i| (format!("org{i}"), "me".to_owned()))
            .collect();
        let raw = serde_json::json!({ "owners": owners }).to_string();
        assert_eq!(Index::decode(&raw).owners.len(), MAX_OWNER_TOKENS);
    }
}
