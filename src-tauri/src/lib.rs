mod commands;
mod error;
mod github;
mod gitlab;
mod graphql_guard;
mod http;
mod token;
mod window_state;

use std::sync::Arc;

use tauri::{
    webview::{NewWindowResponse, WebviewWindowBuilder},
    Manager, RunEvent, Url, WebviewUrl, WindowEvent,
};

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

/// The app never opens windows of its own. A request for one (a middle- or
/// Ctrl-click on a link, `window.open`) would otherwise get a bare webview
/// popup on Windows, outside the navigation allow-list. Links that
/// `open_external` would accept go to the system browser instead, like a
/// normal click; anything else is dropped.
fn on_new_window<R: tauri::Runtime>(
    tokens: &Arc<token::TokenStore>,
    url: Url,
) -> NewWindowResponse<R> {
    let tokens = Arc::clone(tokens);
    // The allow-list reads the keychain, which must not block the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        if commands::may_open(&tokens, &url) {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        }
    });
    NewWindowResponse::Deny
}

const DEFAULT_SIZE: (f64, f64) = (1280.0, 840.0);
const MIN_SIZE: (f64, f64) = (480.0, 400.0);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        tokens: Arc::new(token::TokenStore::default()),
        github: github::GitHubClient::new().expect("failed to initialise HTTP client"),
        gitlab: gitlab::GitLabClient::new().expect("failed to initialise HTTP client"),
    };

    let tokens = Arc::clone(&state.tokens);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                window_state::track(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::token_list,
            commands::token_set,
            commands::token_clear,
            commands::github_graphql,
            commands::gitlab_graphql,
            commands::open_external,
        ])
        .setup(|app| {
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("GitDash")
                .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .on_navigation(is_app_url)
                .on_new_window(move |url, _| on_new_window(&tokens, url));
            // Reopen where the window was closed. A position on a screen that
            // is no longer connected is dropped and the OS places the window.
            let saved = window_state::load(app.handle(), MIN_SIZE.0, MIN_SIZE.1);
            app.manage(window_state::Tracker::new(saved.map(|(bounds, _)| bounds)));
            let position = saved
                .filter(|(_, on_screen)| *on_screen)
                .map(|(bounds, _)| bounds);
            if let Some((saved, _)) = saved {
                builder = builder
                    .inner_size(saved.width, saved.height)
                    .maximized(saved.maximized);
            }
            if let Some(bounds) = &position {
                builder = window_state::position_builder(builder, bounds);
            }
            let window = builder.build()?;
            if let Some(bounds) = &position {
                window_state::position_window(&window, bounds)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building GitDash")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                window_state::save(app);
            }
        });
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
}
