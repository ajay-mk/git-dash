fn main() {
    // Declaring the app's commands here makes Tauri generate a permission for
    // each one, so every command must be explicitly granted in
    // `capabilities/` before the frontend can call it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "token_list",
            "token_set",
            "token_clear",
            "token_link_gh",
            "gh_status",
            "github_graphql",
            "gitlab_graphql",
            "open_external",
            "save_window_state",
        ]),
    ))
    .expect("failed to run tauri-build");
}
