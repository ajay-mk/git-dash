# Installing GitDash

Download the installer for your platform from the
[Releases](https://github.com/ajay-mk/git-dash/releases) page:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `GitDash_<version>_aarch64.dmg` |
| macOS (Intel) | `GitDash_<version>_x64.dmg` |
| Windows | `GitDash_<version>_x64-setup.exe` or `GitDash_<version>_x64_en-US.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

## Verifying the download

Each release includes `SHA256SUMS.txt`. Check your download against it before
running it, for example with `sha256sum -c SHA256SUMS.txt --ignore-missing`
(Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS) or
`Get-FileHash <file>` (Windows PowerShell).

## First launch

**The builds are not code-signed yet**, so your operating system will warn you
the first time you open them:

- **macOS** blocks the app with a message that Apple could not verify it is
  free of malware. The app is only ad-hoc signed, not signed with an Apple
  Developer ID or notarized. To open it once, go to *System Settings → Privacy
  & Security*, find the message about GitDash and choose *Open Anyway*.
- **Windows** SmartScreen shows "Windows protected your PC". Choose *More info
  → Run anyway*. The installer is not Authenticode-signed, so it also shows an
  unknown publisher.
- **Linux** packages are not signed (there is no repository or GPG signature);
  rely on the checksums.

There is no auto-updater yet: install new versions from the
[Releases](https://github.com/ajay-mk/git-dash/releases) page.

Next, [create an access token](tokens.md).
