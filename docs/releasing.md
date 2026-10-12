# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when a version tag is pushed.

1. Bump the version everywhere it is recorded (`package.json`,
   `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`):

   ```sh
   npm run version:set -- 1.2.3   # plain X.Y.Z; MSI installers reject suffixes like -beta
   ```

   Do not use `npm version`: `.npmrc` disables scripts, so it would only update
   `package.json`. CI runs `npm run version:check` to catch files that drift.
2. Commit, merge to `main`, then tag that commit and push the tag:

   ```sh
   git tag v1.2.3 && git push origin v1.2.3
   ```

3. The workflow checks that the tag matches the app version, builds installers
   for macOS (Apple Silicon and Intel), Windows and Linux, and creates a
   **draft** release with the installers and `SHA256SUMS.txt`.
4. Review the draft on the Releases page, edit the notes and publish it.

To redo a failed release, delete the draft release (and the tag, if the commit
changes) before pushing the tag again. Code signing and the updater are not set
up yet; the workflow marks where their secrets go.
