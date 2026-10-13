mod commands;
mod error;
mod github;
mod graphql_guard;
mod token;

use std::sync::Arc;

use tauri::{
    webview::{NewWindowResponse, WebviewWindowBuilder},
    Url, WebviewUrl,
};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use commands::AppState;

/// The webview may only ever show the bundled app. Any attempt to navigate
/// elsewhere (a stray link, injected content) is blocked; external links are
/// opened in the system browser via the opener plugin instead.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            // Vite dev server, debug builds only.
            Some("localhost") => cfg!(debug_assertions) && url.port() == Some(1420),
            _ => false,
        },
        _ => false,
    }
}

/// Same rule as `isSafeExternalUrl` in `src/lib/url.ts`: plain
/// `https://github.com/...` URLs only.
fn is_github_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// The app never opens windows of its own. A request for one (a middle- or
/// Ctrl-click on a link, `window.open`) would otherwise get a bare webview
/// popup on Windows, outside the navigation allow-list. GitHub links go to the
/// system browser instead, like a normal click; anything else is dropped.
fn on_new_window<R: tauri::Runtime>(url: Url) -> NewWindowResponse<R> {
    if is_github_url(&url) {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
    NewWindowResponse::Deny
}

/// What is remembered about the window between launches.
const WINDOW_STATE: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        tokens: Arc::new(token::TokenStore::default()),
        github: github::GitHubClient::new().expect("failed to initialise HTTP client"),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE)
                // Restored in `setup` instead, before the window is shown.
                .skip_initial_state("main")
                .build(),
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::token_list,
            commands::token_set,
            commands::token_clear,
            commands::github_graphql,
        ])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("GitDash")
                .inner_size(1280.0, 840.0)
                .min_inner_size(480.0, 400.0)
                .on_navigation(is_app_url)
                .on_new_window(|url, _| on_new_window(url))
                // Hidden until its saved size and position are applied, so it
                // does not appear at the default size and then jump.
                .visible(false)
                .build()?;
            // A saved position on a monitor that is no longer connected is
            // ignored, and the OS places the window instead.
            let _ = window.restore_state(WINDOW_STATE);
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GitDash");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allow_list() {
        assert!(is_app_url(&Url::parse("tauri://localhost/").unwrap()));
        assert!(is_app_url(
            &Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(!is_app_url(&Url::parse("https://github.com/").unwrap()));
        assert!(!is_app_url(
            &Url::parse("https://tauri.localhost.evil.com/").unwrap()
        ));
        assert!(!is_app_url(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(!is_app_url(&Url::parse("http://localhost:8080/").unwrap()));
    }

    #[test]
    fn new_windows_only_open_github_links() {
        assert!(is_github_url(
            &Url::parse("https://github.com/ajay-mk/git-dash/pull/1").unwrap()
        ));
        for bad in [
            "http://github.com/",
            "https://github.com:8443/",
            "https://user@github.com/",
            "https://github.com.evil.com/",
            "https://gist.github.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ] {
            assert!(!is_github_url(&Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
