mod error;
mod github;
mod graphql_guard;
mod token;

use tauri::{webview::WebviewWindowBuilder, Url, WebviewUrl};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("git-dash")
                .inner_size(1280.0, 840.0)
                .min_inner_size(480.0, 400.0)
                .on_navigation(is_app_url)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running git-dash");
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
