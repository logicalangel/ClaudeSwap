---
description: Show your Claude accounts and switch between them
allowed-tools: Bash(claude-switch:*)
argument-hint: [email or name of the account to switch to]
---

Help the user see and switch their Claude Code account using the `claude-switch` CLI.

If an argument was provided ("$ARGUMENTS"), switch to that account:

```bash
claude-switch use "$ARGUMENTS"
```

Otherwise, list the saved accounts:

```bash
claude-switch list
```

Show the command output to the user. If a switch happened, remind them that it
takes effect in a new `claude` session, not the current one. To add an account
they have not used yet, they sign in once with `claude auth login` and it is saved
automatically.
