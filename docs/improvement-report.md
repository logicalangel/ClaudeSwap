# ClaudeSwap improvement report (v0.4.0)

Based on a read-through of `extension.js`, `lib/credentials.js`, the `claude-plugin/` folder, `package.json` and the repo layout. Nothing below has been changed in code yet.

## 1. Correctness and reliability (fix first)

**1.1 Pinned workspaces can get logged out by stale tokens (likely bug).**
`materializeEnvDir()` copies the saved snapshot into `claude-switch/envs/<uuid>/.credentials.json`, and it does this every time the workspace activates. A `claude` running in that terminal refreshes its OAuth token into that env dir, but nothing copies the refreshed token back into the store. If refresh tokens rotate (single use), the next activation overwrites the fresh token with the old one and the session stops authenticating. The same thing happens when one account is active globally and pinned somewhere else: two copies of one refresh token each refresh on their own, and one of them invalidates the other.
*Fix:* treat the newest credentials as the source of truth. Before overwriting, read the env dir's `.credentials.json` and keep it if its `expiresAt` is newer. Also capture env dirs back into the store, in the same way `captureCurrent()` does for the global login.

**1.2 Non-atomic writes to `~/.claude.json`.**
`writeOauthAccount()` reads, changes and rewrites the whole file, and Claude Code writes the same file all the time (history, project state). If a `claude` process is running, a switch can drop that process's changes, and a crash in the middle of a write leaves the file corrupt. *Fix:* write to a temp file and `rename()` it into place. Do the same for `.credentials.json`, `index.json` and `secrets.json`.

**1.3 Capture race during sign-in.**
`captureCurrent()` pairs `oauthAccount` from `.claude.json` with whatever credentials are live at that moment. During `claude auth login` the two files are written at different times, so a 400 ms debounce can save account A's metadata with account B's token under A's uuid. *Fix:* only save when the token matches the account (for example, the token's account or org claims), or wait until both files have stopped changing.

**1.4 Keychain churn every 20 seconds on macOS.**
The poll and every window-focus event call `captureCurrent()`, which spawns `security` twice and runs `add-generic-password -U`, plus a rewrite of `index.json`, even when nothing has changed. That wastes CPU and can trigger Keychain access prompts. *Fix:* hash the last saved blob and skip the write when the hash is the same.

**1.5 Workspace env dirs keep an old copy of settings.**
`settings.json` is copied once, so later changes to the global settings (MCP servers, permissions, hooks) don't reach pinned workspaces. *Fix:* symlink `settings.json` instead of copying it, falling back to a copy on Windows. Consider doing the same for `CLAUDE.md`, `commands/`, `agents/` and `plugins/`.

**1.6 macOS custom config dirs.** Check whether Claude Code on macOS with `CLAUDE_CONFIG_DIR` set reads `.credentials.json` from that directory or a separate Keychain entry. If it uses the Keychain, pinning is broken on macOS.

## 2. Packaging and distribution

- **About 2,000 `node_modules` files are committed**, and the build tools (`svg2ttf`, `svgicons2svgfont`, `ttf2woff` …) aren't listed in `package.json`. Add a `.gitignore` (`node_modules/`, `*.vsix`, `.DS_Store`), remove `.DS_Store` and `claudeswap-0.4.0.vsix` from git, and declare the build tools as `devDependencies`. Attach the `.vsix` to GitHub Releases instead.
- **Plugin marketplace layout.** `marketplace.json` sits in `claude-plugin/.claude-plugin/` and points at a different repo (`LogicalAngel/claude-switch`). `/plugin marketplace add LogicalAngel/claudeswap` looks for `.claude-plugin/marketplace.json` at the repo root. Either move it there with `"source": "./claude-plugin"`, or confirm that the separate repo exists and is kept in sync.
- **`/account` relies on `claude-switch` being on PATH.** To be safe, call `node "${CLAUDE_PLUGIN_ROOT}/bin/claude-switch"` in `commands/account.md` (and widen `allowed-tools` to match).
- **Duplicate engine.** `npm run sync:plugin` copies `lib/credentials.js` by hand. Add a CI check that fails when the two copies differ, or build both from one source.
- Publish to **Open VSX** as well, so Cursor, Windsurf and VSCodium users can install it. Most of the target audience uses those editors.

## 3. Quality

- No tests, lint or CI. The engine has no dependency on VS Code, so unit tests are easy to write: point `CLAUDE_CONFIG_DIR` at a temp dir, set `CLAUDE_SWITCH_STORE=file`, then test capture, switch and resolve. Add a GitHub Action that runs tests, ESLint and `vsce package` on each PR.
- Add a `CHANGELOG.md`. The Marketplace shows it, and it explains changes when Claude Code's storage format shifts.

## 4. Feature ideas, ranked by value per effort

1. **Show the plan or org type** (Pro, Max, Team, Enterprise) next to each account. `organizationType` is already saved but never shown.
2. **"Switch and restart Claude" action.** After a global switch, offer to kill and relaunch `claude` in open terminals, because the switch only applies to new sessions.
3. **Rate-limit helper.** When a `claude` session hits its usage limit, offer to move this workspace to another saved account.
4. **Token health.** Show a warning icon when a saved account's refresh token has expired, with a one-click re-login.
5. **Windows Credential Manager** support (through `keytar` or PowerShell) instead of a 0600 file, which doesn't really protect anything on NTFS.
6. **Status line that shows the pin:** have `claude-account.js` add 📌 when `CLAUDE_CONFIG_DIR` points into `claude-switch/envs/`.
7. **Account aliases** ("Work", "Personal") and colours in the status bar, so you can tell accounts apart at a glance.
