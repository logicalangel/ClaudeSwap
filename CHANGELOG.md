# Changelog

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
