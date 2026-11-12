# Changelog

## 0.6.0

### Added
- Switch to an API key. Save Anthropic API keys next to your accounts (**Add API
  key** in VS Code, `claude-switch add-key <name>` in a terminal) and switch to
  one like an account. ClaudeSwap points Claude Code's `apiKeyHelper` setting at
  the key, which stays in the Keychain (or a private file off macOS) and never
  goes into `settings.json`. Your claude.ai login stays in place underneath and
  comes back when you pick an account again.
- Pin an API key to a workspace, the same way as an account.
- The status bar, status line and `/account` show 🔑 and the key's name while a
  key is in use, and warn when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or a
  cloud provider setting would override it.
- `claude-switch forget <name>` forgets an account or key from the CLI.

### Fixed
- ClaudeSwap read and wrote `~/.claude/.claude.json` whenever that file existed.
  Claude Code only uses it when `CLAUDE_CONFIG_DIR` is set, and otherwise uses
  `~/.claude.json`. A leftover file there made the status bar show the wrong
  account. Worse, a new sign-in could be saved under the previous account's name.
  The status line had the same bug.
- `claude-switch` and `/account` inside a pinned workspace used an empty store;
  they now use your saved accounts.
- Signing in with a Console account keeps an API key next to the login. It is now
  saved with the account and restored on a switch, and cleared when switching to
  a claude.ai account, as Claude Code's own `/login` does.
- Saved accounts whose names contain non-Latin letters could not be read back
  from the macOS Keychain.
- Keychain writes go through `security -i` on stdin, so secrets no longer show
  in the process list (except for values too long for it, as in Claude Code).
- A switch no longer writes the token when `~/.claude.json` cannot be updated
  with it.
- Pinned workspaces are kept in step with your settings on every refresh, and
  stray files in the envs folder (such as `.DS_Store`) no longer break a refresh.

## 0.5.0

### Fixed
- Pinned workspaces no longer get logged out. Tokens Claude refreshes inside a
  pinned workspace are copied back to the saved account, and a newer token is
  never overwritten by an older one (in the workspace, the store, or the global
  login).
- `~/.claude.json`, credentials and the saved-account files are written
  atomically, and an unparseable `~/.claude.json` is left untouched instead of
  being replaced.
- Signing in with a new account can no longer save one account's token under
  another account's name: ClaudeSwap waits for the login to settle and checks
  the token is not already another account's.
- The saved store is only rewritten when something changed, instead of on every
  20-second poll (fewer `security` calls on macOS).
- Overlapping refreshes (focus, file watchers, poll) are coalesced into one.
- Pinned workspaces link to your settings, `CLAUDE.md`, commands, agents, skills
  and plugins instead of holding a stale copy of `settings.json`.
- The Claude Code plugin marketplace now lives at the repository root, so
  `/plugin marketplace add LogicalAngel/claudeswap` works.

### Added
- Plan (Pro, Max, Team, Enterprise) shown next to each account.
- Account names ("Work", "Personal"): **Rename an account** in VS Code,
  `claude-switch rename` in the CLI, `/account <name>` in chat.
- `claudeAccounts.accountColors` setting to colour the status bar per account.
- "Open Claude terminal" button after switching or pinning.
- Status line shows the account's name and a 📌 in pinned workspaces.
- Windows: the saved-accounts file is restricted to the current user.
- Tests, ESLint, CI on macOS, Linux and Windows, and a tag-triggered release
  that publishes to the VS Code Marketplace and Open VSX.

## 0.4.0
- Per-workspace accounts, Claude Code plugin with `/account` and status line.
