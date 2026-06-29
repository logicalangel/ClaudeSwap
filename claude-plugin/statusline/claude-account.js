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

let email = "not signed in";
try {
  const acct = JSON.parse(fs.readFileSync(file, "utf8")).oauthAccount;
  if (acct && acct.emailAddress) email = acct.emailAddress;
} catch {
  /* leave default */
}

process.stdout.write(`✻ ${email}`);
