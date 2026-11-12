---
description: Show your Claude accounts and API keys, and switch between them
allowed-tools: Bash(claude-switch:*)
argument-hint: [email or name of the account or API key to switch to]
---

Help the user see and switch their Claude Code account or saved API key using the
`claude-switch` CLI.

If an argument was provided ("$ARGUMENTS"), switch to that account or key:

```bash
claude-switch use "$ARGUMENTS"
```

Otherwise, list the saved accounts and API keys:

```bash
claude-switch list
```

Show the command output to the user. If a switch happened, remind them that it
takes effect in a new `claude` session, not the current one. To add an account
they have not used yet, they sign in once with `claude auth login` and it is saved
automatically.

Never ask for an API key in chat and never put one in a command. If the user wants
to add a key, tell them to copy it and run `! pbpaste | claude-switch add-key <name>`
themselves (macOS; on Linux use `wl-paste` or `xclip -o`), or to use **Add API
key** in the ClaudeSwap menu in VS Code. If they paste a key into chat anyway, do
not repeat it, and suggest they rotate it in the Anthropic Console.
