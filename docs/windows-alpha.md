# Windows alpha

Download the `-setup.exe` from this fork's alpha release and run it on an Intel/AMD
64-bit Windows PC. The installer can download WebView2 if needed, so keep an
internet connection available. No Rust, Node.js, or developer tools are needed.

This installer is unsigned. Windows may display an unknown-publisher warning.
Check the release source and compare `Get-FileHash .\<installer-name>.exe -Algorithm SHA256`
in PowerShell with `SHA256SUMS.txt` before deciding whether to run it. Do not disable
Windows security protections globally.

If Switcher is already installed, quit it and privately back up
`%USERPROFILE%\.codex-switcher` and your Codex home (normally `%USERPROFILE%\.codex`)
before installing. The alpha uses the existing app identity and account store;
do not run it alongside another Switcher copy. Keep backups out of shared folders.

Open Switcher and confirm the **Lifan fork** title. Sign in on this PC. First test
a manual account switch with a harmless Codex chat; enable automatic switching
only after confirming close, switch, and reopen work. Upstream auto-updates are
disabled in this build; install future fork alphas manually.

Quota-stopped conversation recovery requires a Codex CLI supporting `codex queue`
and a desktop app registered for `codex://` links. Recovery of other running chats
interrupted by switching is currently macOS-only. Windows end-to-end account
switching and recovery still need live validation on your machine.

## Building another alpha

Run **Windows fork alpha** from GitHub Actions on the fork's `main` branch. It runs
frontend and Rust tests on Windows, builds the fork configuration as an NSIS x64
installer, and uploads `windows-x64-alpha` with a SHA-256 checksum and source commit.
The app version is the base version plus `-alpha.<workflow-run-number>`.

After a successful run, publish those files as a GitHub **prerelease**, targeting
the exact commit in `BUILD.txt`. Use a tag beginning `alpha-` to distinguish this
channel from upstream releases. Never include local accounts or authentication
files. The upstream multi-platform release workflow is disabled in this fork.
