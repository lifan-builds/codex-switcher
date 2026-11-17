# Lifan fork on macOS

Maintained at https://github.com/lifan-builds/codex-switcher. Includes quota-stopped and interrupted conversation recovery, automatic account switching on quota exhaustion, and direct OAuth re-login for invalid ChatGPT accounts.

## Build

```bash
pnpm install --frozen-lockfile
pnpm build:fork:mac
```

Produces `src-tauri/target/release/bundle/macos/Codex Switcher.app` and applies/verifies an ad-hoc code signature for local macOS use. Fork builds label the window and header as **Lifan fork** and disable the upstream updater (`VITE_FORK_BUILD=true` and empty updater endpoints in `src-tauri/tauri.fork.conf.json`) so upstream releases cannot overwrite fork features.

## Install and Rollback

The bundle keeps the upstream app identifier (`com.lampese.codex-switcher`) and `/Applications/Codex Switcher.app` path:
- Account storage remains in `~/.codex-switcher` (`accounts.json`, `settings.json`).
- Active Codex credentials remain in `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
- Do not run dev and release Switcher builds simultaneously.

To replace an installed copy:
1. Quit Codex Switcher (running Codex sessions can stay open while updating Switcher itself).
2. Back up `/Applications/Codex Switcher.app` and credential files privately (`0700` dirs, `0600` files).
3. Copy the built bundle with `ditto 'src-tauri/target/release/bundle/macos/Codex Switcher.app' '/Applications/Codex Switcher.app'` and launch `/Applications/Codex Switcher.app`.

To roll back: quit Switcher, restore the previous `.app` bundle with `ditto`, and leave `~/.codex-switcher/accounts.json` and `~/.codex/auth.json` in place unless recovering from specific credential corruption (older backups may contain rotated single-use refresh tokens).
