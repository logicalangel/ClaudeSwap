#!/usr/bin/env node
// Status line segment that shows the active Claude account. Self-contained so it
// can be referenced by an absolute path from settings.json. The account is not
// in the status line stdin payload, so it reads ~/.claude.json directly.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
let file = path.join(dir, ".claude.json");
if (!fs.existsSync(file)) file = path.join(os.homedir(), ".claude.json");

// A ClaudeSwap-pinned workspace runs from <store>/envs/<uuid>; the saved
// accounts index sits two levels up.
const envMatch = dir.match(/^(.*)[\\/]claude-switch[\\/]envs[\\/][^\\/]+[\\/]?$/);
const indexFile = envMatch
  ? path.join(envMatch[1], "claude-switch", "index.json")
  : path.join(dir, "claude-switch", "index.json");

let name = "not signed in";
try {
  const acct = JSON.parse(fs.readFileSync(file, "utf8")).oauthAccount;
  if (acct && acct.emailAddress) name = acct.emailAddress;
  const key = acct && (acct.accountUuid || acct.emailAddress);
  const entry = JSON.parse(fs.readFileSync(indexFile, "utf8")).find((p) => p.uuid === key);
  if (entry && entry.alias) name = entry.alias;
} catch {
  /* leave what we have */
}

process.stdout.write(`✻ ${name}${envMatch ? " 📌" : ""}`);
