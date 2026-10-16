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
   **draft** release with the installers, the signed update files,
   `latest.json` and `SHA256SUMS.txt`.
4. Review the draft on the Releases page, edit the notes and publish it.
   Publishing is what offers the update to installed apps: they read
   `latest.json` from the latest published release.

To redo a failed release, delete the draft release (and the tag, if the commit
changes) before pushing the tag again. Code signing is not set up yet; the
workflow marks where its secrets go.

## Updates

The app updates itself with Tauri's
[updater](https://v2.tauri.app/plugin/updater/). Every update file is signed
with a minisign key, and the app refuses any file whose signature does not
match the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`),
or that was signed for a different version than `latest.json` announces.

The app downloads `latest.json` and the update files from this repository's
releases without signing in, so updates only work while the repository is
public. To host them elsewhere, change `plugins.updater.endpoints` and the
download URLs that `scripts/updater.mjs` writes.

The private key lives in two repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

Keep a backup of the key file and its password outside GitHub. **If either is
lost, installed apps can no longer be updated**: a new key means a new public
key in the app, which users have to install by hand once.

To make a new key pair (only when replacing a lost or leaked key):

```sh
npx tauri signer generate -w ~/.tauri/gitdash.key
```

Put the contents of `~/.tauri/gitdash.key.pub` in `plugins.updater.pubkey`
and update both secrets.

Only the *Sign the update files* job of the release workflow reads these
secrets. The
build jobs run third-party code (npm packages, Cargo build scripts, the Tauri
action), so they never get the key: each makes a throwaway key, which the
bundler needs to produce update files at all. The sign job then signs every
update file again with the real key (`tauri signer sign --app-version`), and
`scripts/updater.mjs manifest` refuses any file whose signature was not made
with the key in `plugins.updater.pubkey`. The sign job installs the locked
dependencies with scripts disabled and runs only the Tauri CLI.

Only release builds make update files: `src-tauri/tauri.release.conf.json`
turns on `createUpdaterArtifacts`, so a local `npm run tauri build` needs no
key. To try a release build locally, set the two variables (any key works,
e.g. one from `npx tauri signer generate`) and add
`--config src-tauri/tauri.release.conf.json`.

`scripts/updater.mjs` writes `latest.json`. Each build records the files the
bundler made signatures for (the macOS `.app.tar.gz`, the Windows `.msi` and `-setup.exe`,
and the Linux packages), and the sign job lists them by platform and
installer, so each app updates from the same kind of file it was installed
from.
