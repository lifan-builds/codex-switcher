# Lifan fork on macOS

This fork is maintained at https://github.com/lifan-builds/codex-switcher. Its main branch includes quota-stopped conversation recovery, automatic account switching, and direct re-login for invalid accounts. The recovery checkbox and progress/results panel belong to the recovery feature.

Build with `pnpm install --frozen-lockfile` and `pnpm build:fork:mac`. This creates `src-tauri/target/release/bundle/macos/Codex Switcher.app` and applies/verifies an ad-hoc signature for local macOS use. It is not an Apple-notarized distribution. The window and header identify it as the Lifan fork. The fork configuration disables the upstream updater, both the visible update checker and its configured endpoints, so an upstream release cannot replace these features through the app. Updates are built from this fork manually until a signed fork update channel is configured.

Feature tracking:

| Feature | Issue | PR |
| --- | --- | --- |
| Quota-stopped chat recovery, confirmation toggle, and progress/results | [#1](https://github.com/lifan-builds/codex-switcher/issues/1) | [#2](https://github.com/lifan-builds/codex-switcher/pull/2) |
| Automatic switching to available quota | [#3](https://github.com/lifan-builds/codex-switcher/issues/3) | [#4](https://github.com/lifan-builds/codex-switcher/pull/4) |
| Re-login for invalid accounts | [#5](https://github.com/lifan-builds/codex-switcher/issues/5) | [#6](https://github.com/lifan-builds/codex-switcher/pull/6) |

The combined upstream contribution remains [Lampese PR #206](https://github.com/Lampese/codex-switcher/pull/206).

The bundle keeps the original app identifier and installation path `/Applications/Codex Switcher.app`, preserving existing preferences and launch references. Accounts remain in `~/.codex-switcher`; Codex auth remains in its configured Codex home. Do not run release and dev Switcher copies simultaneously.

Before replacing an installed copy, quit Switcher, back up the app bundle and account/auth files privately (directories mode 0700; credential files mode 0600), and copy the built app with `ditto` into `/Applications`. Open that exact path and verify the Lifan fork label and all accounts. Do not close Codex merely to update Switcher. Never commit or upload credentials or local backups.

Rollback: quit the fork, move its app bundle aside, restore the previous app from the private backup with `ditto`, and reopen `/Applications/Codex Switcher.app`. Leave current account/auth files in place unless recovering a specific credential corruption: old refresh tokens may already have rotated. This installation does not create or change login items; existing references to the installed path continue to work.

Validation: re-login was confirmed working by the user on October 19, 2026. Recovery has live macOS evidence; automatic switching has policy and simulated integration coverage, with a real quota-triggered switch and Windows runtime still outstanding.
