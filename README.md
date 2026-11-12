# ClaudeSwap

See which Claude Code account you are signed into, and switch between accounts
(for example personal and company) and Anthropic API keys. Works in two places
that share the same saved accounts and keys: the VS Code status bar, and Claude
Code chat.

## What it does

- Shows your active Claude account in the VS Code status bar and in the Claude
  Code status line.
- Switches accounts in one click (VS Code) or one command (chat).
- Switches to a saved API key the same way, and back to your account.
- Remembers each account the first time you sign in, so there is no setup.
- Updates on its own when you sign in or out from the CLI.
- Works on macOS, Linux, and Windows.

Accounts you save in one place show up in the other, because both use the same
store (the OS keychain on macOS, a protected file on Linux and Windows).

## In VS Code

Click the account in the status bar. The menu lists your accounts with their plan
(Pro, Max, Team, Enterprise) and your saved API keys; pick one to switch to it.
The same menu has **Add account**, **Add API key**, pinning, and **Manage…**
(rename, forget, the Claude Code status line, refresh).

### Out of credits in the middle of a session

Pick your other account in the status bar menu. Claude sessions that are already
open keep the previous account until they restart, so ClaudeSwap offers two ways
to carry on with the same conversation:

- **Reload window**: the Claude Code panel reopens and continues your
  conversation with the new account.
- **Continue in terminal**: runs `claude --continue`, which picks up the latest
  conversation of this folder.

Give accounts short names like "Work" and "Personal" (ClaudeSwap offers this
when it saves a new account, or use **Manage… → Rename**).
To tell them apart at a glance, colour the status bar text per account:

```json
{ "claudeAccounts.accountColors": { "Work": "#4FC1FF", "Personal": "#D97757" } }
```

To install: open the Extensions view, search for **ClaudeSwap**, and click
**Install**. Your active account appears in the status bar right away.

## Use an API key

Choose **Add API key** in the menu, give the key a name (for example "Work API")
and paste it. ClaudeSwap asks the Anthropic API whether it accepts the key (one
request that lists models and costs nothing) and does not save a key it rejects.
Then pick it in the menu like an account. Claude Code uses the key
from the next `claude` session on, and the status bar shows 🔑 and its name. Pick
an account to go back; your claude.ai login was never removed.

The key is kept in the macOS Keychain (on Linux and Windows, in a file only you
can read under `~/.claude/claude-switch/keys`). To switch, ClaudeSwap sets
Claude Code's `apiKeyHelper` setting to a one-line command that reads the key
from there, so the key itself never goes into `settings.json`. If you already
have your own `apiKeyHelper`, ClaudeSwap leaves it alone and says so.

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock, Vertex and Foundry
settings outrank `apiKeyHelper` in Claude Code, so ClaudeSwap warns when one of
them is set.

## Use a different account per project

Open the status bar menu and choose **Pin an account or key to this workspace**.
Pick an account or API key and ClaudeSwap binds it to this project, for example
to keep a company project on the company account. The choice is saved in the
project's `.vscode/settings.json` (an email, not a secret):

```json
{ "claudeAccounts.account": "you@company.com" }
```

For an API key the value is the key's name.

From then on, Claude in this window uses that account: the Claude Code panel
and every `claude` in the integrated terminal. Your global login and other
windows are untouched, so you can open two projects in two windows on two
different accounts and run them at the same time. New sessions use the pin right
away; reload the window so sessions that are already open switch too.

A pinned workspace never falls back to another account. If the pinned account or
key cannot be found or set up, Claude stays signed out in that window (the status
bar shows it in red) until you add it or unpin. **Add account** from a pinned
window still signs in globally, not inside the pinned workspace.

It works by giving the project its own Claude config directory (its credentials,
plus links to your `settings.json`, `CLAUDE.md`, commands, agents, skills and
plugins, so later changes reach it too) and pointing `CLAUDE_CONFIG_DIR` at it for
this window's terminals and for the Claude Code panel, which reads it from the
window's extension host. Conversations of a pinned project are kept in that
directory too. Tokens Claude refreshes there are copied back to your
saved accounts, so the global login and pinned projects never hand each other an
expired token. While an API key is in use globally, a project pinned to an
account gets a copy of your settings without the key, so it keeps its account.
Unbind from the same menu.

## In Claude Code chat

Install the plugin from this repository's marketplace:

```
/plugin marketplace add LogicalAngel/claudeswap
/plugin install claude-switch@logicalangel
```

Run `/account` to see your accounts and keys, or `/account you@company.com` (or a
name such as `/account Work` or `/account "Work API"`) to switch.

Never paste an API key into chat. To add one from chat, copy it and run
`! pbpaste | claude-switch add-key "Work API"` (on Linux use `wl-paste` or
`xclip -o`), or use **Add API key** in VS Code.

Show the active account in Claude Code's status line with **Manage… → Show the
account in Claude Code's status line** in VS Code. It copies the script to
`~/.claude/claude-switch/statusline.js` and points `settings.json` at it, and asks
before replacing a status line you already have. Without VS Code, point your
`settings.json` at the bundled script (use the absolute path where the plugin is
installed):

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
claude-switch rename you@company.com Work
claude-switch add-key "Work API"      # type the key hidden, or pipe it in
claude-switch use "Work API"
claude-switch forget "Work API"
```

The status line shows the account's name if you gave it one, 🔑 and the key's
name while an API key is in use, and a 📌 in a pinned workspace.

A switch in chat takes effect in a new `claude` session, because Claude Code keeps
the current session's token in memory.

## Add an account

In VS Code choose **Add account**, or in a terminal run `claude auth login`. Sign
in with the other account once and it is saved automatically; ClaudeSwap tells
you and offers to name it. Signing in makes the new account the active one; the
previous one stays saved, so switch back from the menu when you want.

## Under the hood

Claude Code keeps account metadata in `~/.claude.json` (the `oauthAccount` field;
`$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set) and OAuth tokens in
the OS credential store: the Keychain on macOS, or `~/.claude/.credentials.json`
on Linux and Windows (it respects `CLAUDE_CONFIG_DIR`). A Console login also
keeps an API key there, which ClaudeSwap saves with the account. ClaudeSwap
saves a snapshot of each account it sees and writes the chosen one back when you
switch. It reads and writes only the same
places Claude Code already uses, and writes files atomically so a running `claude`
never sees a half-written `~/.claude.json`. On Windows the saved-accounts file is
restricted to your user with `icacls`. Keychain writes go through `security -i`,
so secrets do not show in the process list. Set `CLAUDE_SWITCH_STORE=file` to
keep snapshots and API keys in protected files instead of the Keychain.

This depends on how Claude Code currently stores things, so a future update could
change it.

## Build from source

```bash
npm install
npm test                # engine tests (never touch your real login)
npm run lint
npm run build:icon      # regenerate the icon font and logo (needs rsvg-convert)
npm run sync:plugin     # copy the shared engine into the plugin (CI checks this)
npm run package         # build the VS Code extension (.vsix)
```

Pushing a `v*` tag builds the `.vsix`, attaches it to a GitHub release, and
publishes to the VS Code Marketplace and Open VSX when the `VSCE_PAT` and
`OVSX_PAT` repository secrets are set.

VS Code extension: open the folder and press F5 to run it in an Extension
Development Host. Claude Code plugin: `claude --plugin-dir ./claude-plugin` to load
it locally.
