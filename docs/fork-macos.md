# Lifan fork on macOS

This fork is maintained at https://github.com/lifan-builds/codex-switcher. Its main branch includes quota-stopped conversation recovery, automatic account switching, and direct re-login for invalid accounts. The recovery checkbox and progress/results panel belong to the recovery feature.

Build with `pnpm install --frozen-lockfile` and `pnpm build:fork:mac`. This creates `src-tauri/target/release/bundle/macos/Codex Switcher.app` and applies/verifies an ad-hoc signature for local macOS use. It is not an Apple-notarized distribution. The window and header identify it as the Lifan fork. The fork configuration disables the upstream updater, both the visible update checker and its configured endpoints, so an upstream release cannot replace these features through the app. Updates are built from this fork manually until a signed fork update channel is configured.

Feature tracking:

| Feature | Issue | PR |
| --- | --- | --- |
| Quota-stopped chat recovery, confirmation toggle, and progress/results | [#1](https://github.com/lifan-builds/codex-switcher/issues/1) | [#2](https://github.com/lifan-builds/codex-switcher/pull/2) |
| Automatic switching to available quota | [#3](https://github.com/lifan-builds/codex-switcher/issues/3) | [#4](https://github.com/lifan-builds/codex-switcher/pull/4) |
| Re-login for invalid accounts | [#5](https://github.com/lifan-builds/codex-switcher/issues/5) | [#6](https://github.com/lifan-builds/codex-switcher/pull/6) |

The upstream contributions are separate: [recovery #206](https://github.com/Lampese/codex-switcher/pull/206), [automatic switching #209](https://github.com/Lampese/codex-switcher/pull/209), and [re-login #210](https://github.com/Lampese/codex-switcher/pull/210).

The bundle keeps the original app identifier and installation path `/Applications/Codex Switcher.app`, preserving existing preferences and launch references. Accounts remain in `~/.codex-switcher`; Codex auth remains in its configured Codex home. Do not run release and dev Switcher copies simultaneously.

Before replacing an installed copy, quit Switcher, back up the app bundle and account/auth files privately (directories mode 0700; credential files mode 0600), and copy the built app with `ditto` into `/Applications`. Open that exact path and verify the Lifan fork label and all accounts. Do not close Codex merely to update Switcher. Never commit or upload credentials or local backups.

Rollback: quit the fork, move its app bundle aside, restore the previous app from the private backup with `ditto`, and reopen `/Applications/Codex Switcher.app`. Leave current account/auth files in place unless recovering a specific credential corruption: old refresh tokens may already have rotated. This installation does not create or change login items; existing references to the installed path continue to work.

Validation: re-login was confirmed working by the user on October 19, 2026. Recovery has live macOS evidence; automatic switching has policy and simulated integration coverage, with a real quota-triggered switch and Windows runtime still outstanding.

October 25 recovery fix: on macOS, the pre-switch snapshot also captures unfinished
turns whose rollout files are held open by the Codex processes being closed.
Completed, aborted, internal-agent, and pending user-input/approval turns are
excluded. Recovery rechecks the saved log offset before sending a continuation;
a later user message, new turn, completion, or abort suppresses it. Other platforms
retain quota-error recovery. The existing 32-chat cap and two-minute budget remain.
An explicit abort is treated conservatively as stopped, even if shutdown emitted it.

Validation for this fix: 89 Rust tests passed (3 opt-in tests skipped), 29 frontend
tests passed (1 skipped), the four-chat recovery fixture passed, and a read-only
live macOS snapshot found the currently running chat. The signed fork build and
installed binary were verified. No deliberate live Codex restart was performed
for this fix, so the full restart cycle still needs confirmation on the next switch.

October 28 auto-switch timing fix: routine quota checks and temporary read-error
retries now run every 15 seconds. A native five-second monitor of changed rollout
tails can wake a check early after a fresh quota stop; live account quota and
identity must still be verified before closing Codex. Successful switches settle
for one minute; failed switch attempts keep the five-minute protection against
repeated restarts. Native Codex login, restart, and recovery behavior is retained.
Tracking: [delay issue #18](https://github.com/lifan-builds/codex-switcher/issues/18).

Validation: 90 Rust tests passed (3 opt-in tests skipped), 32 frontend tests passed
(1 platform-specific test skipped), and the frontend production build passed.
Fresh/stale stops, resumed chats, quoted errors, internal agents, bounded log
tails, scheduling, short read retries, and switch cooldowns are covered. This does
not measure a real quota-triggered desktop restart or hidden-window behavior on
other operating systems.
