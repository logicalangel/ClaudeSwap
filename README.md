# ClaudeSwap

See which Claude Code account you are signed into, and switch between accounts
(for example personal and company). Works in two places that share the same saved
accounts: the VS Code status bar, and Claude Code chat.

## What it does

- Shows your active Claude account in the VS Code status bar and in the Claude
  Code status line.
- Switches accounts in one click (VS Code) or one command (chat).
- Remembers each account the first time you sign in, so there is no setup.
- Updates on its own when you sign in or out from the CLI.
- Works on macOS, Linux, and Windows.

Accounts you save in one place show up in the other, because both use the same
store (the OS keychain on macOS, a protected file on Linux and Windows).

## In VS Code

Click the account in the status bar. The menu lists your accounts; pick one to
switch to it. The same menu has **Add account**, **Forget a saved account**, and
**Refresh**.

To install: open the Extensions view, search for **ClaudeSwap**, and click
**Install**. Your active account appears in the status bar right away.

## Use a different account per project

Open the status bar menu and choose **Use an account for this workspace**. Pick an
account and ClaudeSwap binds it to this project. The choice is saved in the
project's `.vscode/settings.json` (an email, not a secret):

```json
{ "claudeAccounts.account": "you@company.com" }
```

From then on, any `claude` you run in this project's integrated terminal uses that
account, while your global login and other windows are untouched. So you can open
two projects in two windows on two different accounts and run them at the same
time. Open a new terminal after binding; existing terminals need a relaunch.

It works by giving the project its own Claude config directory (credentials plus a
copy of your settings) and pointing `CLAUDE_CONFIG_DIR` at it for this window's
terminals. Unbind from the same menu.

## In Claude Code chat

Run `/account` to see your accounts, or `/account you@company.com` to switch.

Show the active account in the status line by pointing your `settings.json` at the
bundled script (use the absolute path where the plugin is installed):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/claude-plugin/statusline/claude-account.js"
  }
}
```

You can also run the CLI directly:

```
claude-switch list
claude-switch use you@company.com
```

A switch in chat takes effect in a new `claude` session, because Claude Code keeps
the current session's token in memory.

## Add an account

In VS Code choose **Add account**, or in a terminal run `claude auth login`. Sign
in with the other account once and it is saved automatically. After that it shows
up in both places.

## Under the hood

Claude Code keeps account metadata in `~/.claude.json` (the `oauthAccount` field)
and OAuth tokens in the OS credential store: the Keychain on macOS, or
`~/.claude/.credentials.json` on Linux and Windows (it respects
`CLAUDE_CONFIG_DIR`). ClaudeSwap saves a snapshot of each account it sees and
writes the chosen one back when you switch. It reads and writes only the same
places Claude Code already uses. Set `CLAUDE_SWITCH_STORE=file` to keep snapshots
in a protected file instead of the Keychain.

This depends on how Claude Code currently stores things, so a future update could
change it.

## Build from source

```bash
npm install
npm run build:icon      # regenerate the icon font and logo (needs rsvg-convert)
npm run sync:plugin     # copy the shared engine into the plugin
vsce package            # build the VS Code extension (.vsix)
```

VS Code extension: open the folder and press F5 to run it in an Extension
Development Host. Claude Code plugin: `claude --plugin-dir ./claude-plugin` to load
it locally.
