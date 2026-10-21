# ClaudeSwap improvement report

Findings from a review of v0.4.0, and what 0.5.0 did about each one. See
`CHANGELOG.md` for the user-facing summary.

## Correctness and reliability

| # | Finding | Status in 0.5.0 |
|---|---|---|
| 1.1 | Pinned workspaces overwrote tokens Claude had refreshed with an older saved copy, which could log the workspace (or the global login) out. | **Fixed.** The newest token always wins: env dirs are synced back to the store on every refresh, `materializeEnvDir` never downgrades, and the global login gets a newer token if a pinned workspace refreshed it. Covered by tests. |
| 1.2 | Rewrites of `~/.claude.json` and the credential files were not atomic. | **Fixed.** Temp file plus rename (following symlinks), and an unparseable `~/.claude.json` is left alone instead of being replaced. |
| 1.3 | A capture during `claude auth login` could pair one account's metadata with another account's token. | **Fixed.** The login has to stay unchanged for 300 ms, and a token already saved under another account is rejected. Covered by a test. |
| 1.4 | The store and the keychain were rewritten every 20 seconds. | **Fixed.** Writes are skipped when nothing changed, and overlapping refreshes are coalesced. |
| 1.5 | Pinned workspaces held a stale copy of `settings.json`. | **Fixed.** `settings.json`, `CLAUDE.md`, `commands`, `agents`, `skills`, `plugins` and `output-styles` are symlinked, with a copy as the fallback where links are not allowed. |
| 1.6 | With `CLAUDE_CONFIG_DIR` set, Claude Code on macOS keeps credentials in a keychain entry keyed to that directory. | **Mitigated.** The docs confirm the entry is per directory but don't give its name. ClaudeSwap reads the likely name (sha256 prefix), falls back to the plain name and the file, and only updates an entry that already exists, so a wrong guess never leaves stray keychain items. **Needs a manual check on a Mac.** |

## Packaging and distribution

| Finding | Status |
|---|---|
| About 2,000 `node_modules` files, `.DS_Store` and the `.vsix` were committed; the build tools weren't declared. | **Fixed.** Added `.gitignore`, removed them from git, and declared the build tools and new dev tools in `devDependencies` with a lockfile. |
| `marketplace.json` wasn't at the repo root and pointed at another repo. | **Fixed.** Moved to `.claude-plugin/marketplace.json` with `"source": "./claude-plugin"`. |
| `/account` relies on `claude-switch` being on PATH. | **Not a problem.** I was wrong in the first report: Claude Code puts a plugin's `bin/` on the Bash tool's PATH. No change needed. |
| The engine is duplicated in the plugin by hand. | **Guarded.** `npm run check:sync` runs in CI. |
| Not on Open VSX. | **Ready.** The release workflow publishes there once you add an `OVSX_PAT` secret. |

## Quality

- Added 10 engine tests (`npm test`), ESLint (`npm run lint`), CI on Linux, macOS and Windows, and a tag-triggered release workflow.
- Added `CHANGELOG.md`.

## Features

| Idea | Status |
|---|---|
| Show the plan | **Done.** It comes from `subscriptionType` in the credentials. |
| Action after a switch | **Done.** The notification has an "Open Claude terminal" button. ClaudeSwap doesn't kill running sessions, because it can't reliably tell which terminals run `claude`. |
| Rate-limit helper | **Not done.** The extension gets no signal when a session hits its limit. A Claude Code hook would be the way to build it. |
| Token health warning | **Not done.** The refresh token's validity can only be checked by using it, which would rotate it. |
| Windows Credential Manager | **Partly done.** The secrets file is now restricted to the current user with `icacls`. Full Credential Manager support needs a native module. |
| Status line shows the pin | **Done.** It shows the name and a 📌 in pinned workspaces. |
| Account names and colours | **Done.** Rename from the menu or `claude-switch rename`, plus the `claudeAccounts.accountColors` setting. |
