# Installing IsItGreen

Download the installer for your platform from the
[Releases](https://github.com/ajay-mk/git-dash/releases) page:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `IsItGreen_<version>_aarch64.dmg` |
| macOS (Intel) | `IsItGreen_<version>_x64.dmg` |
| Windows | `IsItGreen_<version>_x64-setup.exe` or `IsItGreen_<version>_x64_en-US.msi` |
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
  & Security*, find the message about IsItGreen and choose *Open Anyway*.
- **Windows** SmartScreen shows "Windows protected your PC". Choose *More info
  → Run anyway*. The installer is not Authenticode-signed, so it also shows an
  unknown publisher.
- **Linux** packages are not signed (there is no repository or GPG signature);
  rely on the checksums.

## Updates

IsItGreen looks for a new release when it starts and every six hours. When one
is out, a banner offers *Restart to update*; IsItGreen downloads it, checks its
signature against the key built into the app, installs it and restarts. On
Windows the installer runs with a progress bar and reopens IsItGreen. Turn
automatic checks off, or check by hand, under *Settings → Updates*.

An update replaces the app the same way it was installed (the `.app`, the
Windows installer you used, the AppImage, or the `.deb`/`.rpm` package, which
asks for your password). Versions released before the updater was added
cannot update themselves: install the latest one from the
[Releases](https://github.com/ajay-mk/git-dash/releases) page once.

Next, [create an access token](tokens.md).
