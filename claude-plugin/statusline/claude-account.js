#!/usr/bin/env node
// Status line segment that shows the active Claude account or saved API key.
// Self-contained so it can be referenced by an absolute path from settings.json.
// The account is not in the status line stdin payload, so it reads Claude
// Code's files directly.
const fs = require("fs");
const os = require("os");
const path = require("path");

const custom = !!process.env.CLAUDE_CONFIG_DIR;
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
// Claude Code reads .claude.json from CLAUDE_CONFIG_DIR when that is set, else
// from the home directory (a legacy <config>/.config.json wins when present).
let file = path.join(dir, ".config.json");
if (!fs.existsSync(file)) file = path.join(custom ? dir : os.homedir(), ".claude.json");

// A ClaudeSwap-pinned workspace runs from <store>/envs/<id>; the saved
// accounts index sits two levels up.
const envMatch = dir.match(/^(.*)[\\/]claude-switch[\\/]envs[\\/][^\\/]+[\\/]?$/);
const storeDir = envMatch ? path.join(envMatch[1], "claude-switch") : path.join(dir, "claude-switch");

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

let name = "not signed in";
let icon = "✻";

// A saved API key in use (ClaudeSwap's apiKeyHelper) wins over the login.
const settings = readJson(path.join(dir, "settings.json")) || {};
const helper = typeof settings.apiKeyHelper === "string" ? settings.apiKeyHelper : "";
const keyMatch =
  helper.match(/-s claude-switch-apikey -a ([0-9a-f]{12}) -w/) || helper.match(/claude-switch[\\/]keys[\\/]([0-9a-f]{12})\b/);

if (keyMatch) {
  const key = (readJson(path.join(storeDir, "apikeys.json")) || []).find((k) => k.id === keyMatch[1]);
  name = key ? key.name : "API key";
  icon = "🔑";
} else {
  const acct = (readJson(file) || {}).oauthAccount;
  if (acct && acct.emailAddress) name = acct.emailAddress;
  const id = acct && (acct.accountUuid || acct.emailAddress);
  const entry = (readJson(path.join(storeDir, "index.json")) || []).find((p) => p.uuid === id);
  if (entry && entry.alias) name = entry.alias;
}

process.stdout.write(`${icon} ${name}${envMatch ? " 📌" : ""}`);
