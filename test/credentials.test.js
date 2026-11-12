// Engine tests. Each test gets a fresh fake home and config dir, the file-based
// store and no keychain access, so nothing touches the real login or keychain.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const ENGINE = require.resolve("../lib/credentials");
const ROOT = path.join(__dirname, "..");
const isWin = process.platform === "win32";

const KEY = "sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz-0123456789-WXYZ";

// customDir: run as if CLAUDE_CONFIG_DIR pointed at the config dir.
function setup({ customDir = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudeswap-"));
  const config = path.join(home, ".claude");
  fs.mkdirSync(config);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (customDir) process.env.CLAUDE_CONFIG_DIR = config;
  else delete process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_SWITCH_STORE = "file";
  process.env.CLAUDE_SWITCH_KEYCHAIN = "off";
  process.env.CLAUDE_SWITCH_STABLE_MS = "5";
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    delete process.env[v];
  }
  return load({ home, config, claudeJson: path.join(customDir ? config : home, ".claude.json") });
}

function load(t) {
  delete require.cache[ENGINE];
  const engine = require(ENGINE);
  const credFile = path.join(t.config, ".credentials.json");
  const settings = path.join(t.config, "settings.json");
  return {
    ...t,
    engine,
    credFile,
    settings,
    readSettings: () => JSON.parse(fs.readFileSync(settings, "utf8")),
    env: () => ({ ...process.env }),
    login(acct, token, extra = {}) {
      fs.writeFileSync(credFile, creds(token));
      const j = fs.existsSync(t.claudeJson) ? JSON.parse(fs.readFileSync(t.claudeJson, "utf8")) : {};
      j.oauthAccount = acct;
      delete j.primaryApiKey;
      Object.assign(j, extra);
      fs.writeFileSync(t.claudeJson, JSON.stringify(j));
    },
  };
}

function creds({ rt, exp, plan = "pro" }) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${rt}`, refreshToken: rt, expiresAt: exp, subscriptionType: plan },
  });
}

// What Claude Code would get from an apiKeyHelper command (run in a shell).
function runHelper(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const A = { accountUuid: "uuid-a", emailAddress: "a@work.com", organizationName: "Work" };
const B = { accountUuid: "uuid-b", emailAddress: "b@home.dev" };

test("captures the live account with its plan", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100, plan: "max" });
  const res = await t.engine.captureCurrent();
  assert.equal(res.saved, true);
  const [entry] = t.engine.listAccounts();
  assert.equal(entry.email, "a@work.com");
  assert.equal(entry.plan, "max");
  assert.equal((await t.engine.getSecret("uuid-a")).credentials, creds({ rt: "a1", exp: 100, plan: "max" }));
});

test("switching restores credentials and keeps other .claude.json keys", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  t.login(B, { rt: "b1", exp: 100 });
  const j = JSON.parse(fs.readFileSync(t.claudeJson, "utf8"));
  j.projects = { "/x": { history: [1, 2] } };
  fs.writeFileSync(t.claudeJson, JSON.stringify(j));
  await t.engine.captureCurrent();

  const res = await t.engine.switchTo("uuid-a");
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(t.claudeJson, "utf8"));
  assert.equal(after.oauthAccount.emailAddress, "a@work.com");
  assert.deepEqual(after.projects, { "/x": { history: [1, 2] } });
  assert.equal(fs.readFileSync(t.credFile, "utf8"), creds({ rt: "a1", exp: 100 }));
  if (!isWin) assert.equal(fs.statSync(t.credFile).mode & 0o777, 0o600);
});

test("reads ~/.claude.json and ignores a stray .claude.json in ~/.claude", async () => {
  const t = setup();
  // Left behind by a run with CLAUDE_CONFIG_DIR=~/.claude; Claude Code ignores it.
  const stray = path.join(t.config, ".claude.json");
  fs.writeFileSync(stray, JSON.stringify({ oauthAccount: A }));
  t.login(B, { rt: "b1", exp: 100 });
  assert.equal(t.engine.paths.CLAUDE_JSON, path.join(t.home, ".claude.json"));
  assert.equal(t.engine.currentAccount().emailAddress, "b@home.dev");
  await t.engine.captureCurrent();
  assert.equal((await t.engine.getSecret("uuid-b")).credentials, creds({ rt: "b1", exp: 100 }));
  assert.equal(await t.engine.getSecret("uuid-a"), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(stray, "utf8")), { oauthAccount: A });
});

test("uses CLAUDE_CONFIG_DIR/.claude.json when that variable is set", async () => {
  const t = setup({ customDir: true });
  assert.equal(t.engine.paths.CLAUDE_JSON, path.join(t.config, ".claude.json"));
  t.login(A, { rt: "a1", exp: 100 });
  assert.equal(t.engine.currentAccount().emailAddress, "a@work.com");
});

test("inside a pinned workspace the CLI still sees the global store", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  process.env.CLAUDE_CONFIG_DIR = dir;
  const inside = load(t);
  assert.equal(inside.engine.pinnedEnvId, "uuid-a");
  assert.equal(inside.engine.paths.CLAUDE_JSON, path.join(t.home, ".claude.json"));
  assert.equal(inside.engine.paths.INDEX_FILE, path.join(t.config, "claude-switch", "index.json"));
  assert.deepEqual(
    inside.engine.listAccounts().map((p) => p.uuid),
    ["uuid-a"]
  );
});

test("refuses to rewrite an unparseable .claude.json", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  t.login(B, { rt: "b1", exp: 100 });
  await t.engine.captureCurrent();
  fs.writeFileSync(t.claudeJson, "{ broken");
  await assert.rejects(t.engine.switchTo("uuid-a"), /not valid JSON/);
  assert.equal(fs.readFileSync(t.claudeJson, "utf8"), "{ broken");
});

test("does not rewrite the store when nothing changed", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const secrets = path.join(t.config, "claude-switch", "secrets.json");
  const index = path.join(t.config, "claude-switch", "index.json");
  const before = [fs.statSync(secrets).ino, fs.statSync(index).ino];
  await t.engine.captureCurrent();
  // Atomic writes replace the inode, so an unchanged inode means no write.
  assert.deepEqual([fs.statSync(secrets).ino, fs.statSync(index).ino], before);
});

test("skips a capture that pairs one account with another's token", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  // Mid-login: metadata already says B, credentials are still A's.
  t.login(B, { rt: "a1", exp: 100 });
  const res = await t.engine.captureCurrent();
  assert.equal(res.saved, false);
  assert.equal(await t.engine.getSecret("uuid-b"), null);
});

test("pinned env dir keeps a token Claude refreshed there", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  // Claude, running in the pinned workspace, refreshes the token.
  fs.writeFileSync(path.join(dir, ".credentials.json"), creds({ rt: "a2", exp: 200 }));

  await t.engine.materializeEnvDir("uuid-a");
  assert.equal(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"), creds({ rt: "a2", exp: 200 }));
  assert.equal((await t.engine.getSecret("uuid-a")).credentials, creds({ rt: "a2", exp: 200 }));
});

test("global login picks up a newer token refreshed in an env dir", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  fs.writeFileSync(path.join(dir, ".credentials.json"), creds({ rt: "a2", exp: 200 }));

  await t.engine.captureCurrent();
  assert.equal(fs.readFileSync(t.credFile, "utf8"), creds({ rt: "a2", exp: 200 }));
});

test("env dir links shared settings instead of copying them", async (ctx) => {
  if (isWin) return ctx.skip("symlinks need developer mode");
  const t = setup();
  fs.writeFileSync(t.settings, '{"model":"x"}');
  fs.mkdirSync(path.join(t.config, "commands"));
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  assert.equal(fs.readlinkSync(path.join(dir, "settings.json")), t.settings);
  assert.equal(fs.readlinkSync(path.join(dir, "commands")), path.join(t.config, "commands"));
  fs.writeFileSync(t.settings, '{"model":"y"}');
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), '{"model":"y"}');
});

test("aliases resolve and survive later captures", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  assert.equal(t.engine.setAlias("uuid-a", "Work"), true);
  t.login(A, { rt: "a2", exp: 200 });
  await t.engine.captureCurrent();
  assert.equal(t.engine.resolve("work").uuid, "uuid-a");
  assert.equal(t.engine.label(t.engine.resolve("a@work.com")), "Work");
});

test("removing an account deletes its snapshot and env dir", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  await t.engine.removeAccount("uuid-a");
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await t.engine.getSecret("uuid-a"), null);
  assert.deepEqual(t.engine.listAccounts(), []);
});

test("decodes keychain output that security prints as hex", () => {
  const t = setup();
  const text = '{"displayName":"پریا"}';
  assert.equal(t.engine.decodeKeychainOutput(Buffer.from(text).toString("hex") + "\n"), text);
  // Printable data is never shown as hex, so a hex-looking value stays as is.
  assert.equal(t.engine.decodeKeychainOutput("deadbeef\n"), "deadbeef");
  assert.equal(t.engine.decodeKeychainOutput('{"a":1}\n'), '{"a":1}');
});

// ---- API keys -------------------------------------------------------------

test("saves an API key privately and lists only its name and last four characters", async () => {
  const t = setup();
  const entry = await t.engine.addApiKey("Work API", ` ${KEY}\n`);
  assert.equal(entry.hint, "WXYZ");
  const listFile = fs.readFileSync(t.engine.paths.KEYS_FILE, "utf8");
  assert.equal(listFile.includes(KEY), false);
  assert.equal(await t.engine.getApiKey(entry.id), KEY);
  const secretFile = path.join(t.config, "claude-switch", "keys", entry.id);
  if (!isWin) assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  assert.equal(t.engine.resolveAny("work api").key.id, entry.id);
});

test("rejects bad keys and names that are already taken", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  t.engine.setAlias("uuid-a", "Work");
  await assert.rejects(t.engine.addApiKey("Work", KEY), /already called/);
  await assert.rejects(t.engine.addApiKey("a@work.com", KEY), /already called/);
  await assert.rejects(t.engine.addApiKey("Other", "sk-ant has spaces in it ok"), /does not look like/);
  await assert.rejects(t.engine.addApiKey("", KEY), /name/);
  await t.engine.addApiKey("Other", KEY);
  assert.throws(() => t.engine.setAlias("uuid-a", "other"), /already called/);
});

test("using a key sets an apiKeyHelper that prints it and keeps other settings", async () => {
  const t = setup();
  fs.writeFileSync(t.settings, '{\n    "model": "opus",\n    "env": {"X": "1"}\n}\n');
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const entry = await t.engine.addApiKey("Work API", KEY);

  const res = await t.engine.useApiKey(entry.id);
  assert.equal(res.ok, true);
  const s = t.readSettings();
  assert.equal(s.model, "opus");
  assert.deepEqual(s.env, { X: "1" });
  assert.equal(s.apiKeyHelper.includes(KEY), false);
  assert.equal(runHelper(s.apiKeyHelper), KEY);
  assert.match(fs.readFileSync(t.settings, "utf8"), /^\{\n {4}"model"/); // indentation kept
  assert.equal(t.engine.activeApiKey().id, entry.id);
  // The claude.ai login stays in place underneath.
  assert.equal(fs.readFileSync(t.credFile, "utf8"), creds({ rt: "a1", exp: 100 }));
});

test("never replaces an apiKeyHelper the user wrote", async () => {
  const t = setup();
  fs.writeFileSync(t.settings, JSON.stringify({ apiKeyHelper: "~/bin/my-key.sh" }));
  const entry = await t.engine.addApiKey("Work API", KEY);
  const res = await t.engine.useApiKey(entry.id);
  assert.equal(res.ok, false);
  assert.match(res.error, /its own apiKeyHelper/);
  assert.equal(await t.engine.clearApiKey(), false);
  assert.equal(t.readSettings().apiKeyHelper, "~/bin/my-key.sh");
});

test("switching to an account removes the key; switching keys replaces it", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  t.login(B, { rt: "b1", exp: 100 });
  await t.engine.captureCurrent();
  const k1 = await t.engine.addApiKey("One", KEY);
  const k2 = await t.engine.addApiKey("Two", KEY.replace("WXYZ", "QQQQ"));

  await t.engine.useApiKey(k1.id);
  await t.engine.useApiKey(k2.id);
  assert.equal(t.engine.activeApiKey().id, k2.id);
  assert.match(runHelper(t.readSettings().apiKeyHelper), /QQQQ$/);

  const res = await t.engine.switchTo("uuid-a");
  assert.equal(res.ok, true);
  assert.equal(t.engine.activeApiKey(), null);
  assert.equal("apiKeyHelper" in t.readSettings(), false);
  assert.equal(t.engine.currentAccount().emailAddress, "a@work.com");
});

test("a workspace pinned to an account does not pick up the global key", async (ctx) => {
  if (isWin) return ctx.skip("symlinks need developer mode");
  const t = setup();
  fs.writeFileSync(t.settings, JSON.stringify({ model: "opus" }, null, 2));
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  const envSettings = path.join(dir, "settings.json");
  assert.equal(fs.lstatSync(envSettings).isSymbolicLink(), true);

  const entry = await t.engine.addApiKey("Work API", KEY);
  await t.engine.useApiKey(entry.id);
  assert.equal(fs.lstatSync(envSettings).isSymbolicLink(), false);
  const pinned = JSON.parse(fs.readFileSync(envSettings, "utf8"));
  assert.equal(pinned.model, "opus");
  assert.equal("apiKeyHelper" in pinned, false);
  // The global file kept its helper (nothing was written through the link).
  assert.equal(t.engine.helperKeyId(t.readSettings().apiKeyHelper), entry.id);

  // Later edits to the global settings reach the pinned copy on the next sync.
  const g = t.readSettings();
  g.model = "sonnet";
  fs.writeFileSync(t.settings, JSON.stringify(g));
  await t.engine.captureCurrent();
  assert.equal(JSON.parse(fs.readFileSync(envSettings, "utf8")).model, "sonnet");

  await t.engine.clearApiKey();
  assert.equal(fs.readlinkSync(envSettings), t.settings);
});

test("a workspace pinned to a key gets its own helper and no login", async () => {
  const t = setup();
  fs.writeFileSync(t.settings, JSON.stringify({ model: "opus" }));
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const entry = await t.engine.addApiKey("Work API", KEY);
  const dir = await t.engine.materializeKeyEnvDir(entry.id);
  assert.equal(path.basename(dir), `key-${entry.id}`);
  const s = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(s.model, "opus");
  assert.equal(runHelper(s.apiKeyHelper), KEY);
  assert.equal(fs.existsSync(path.join(dir, ".credentials.json")), false);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
  assert.equal(meta.oauthAccount, undefined);
  assert.equal(meta.hasCompletedOnboarding, true);
  // The global login is untouched.
  assert.equal(t.engine.activeApiKey(), null);
  // A sync keeps the key env dir and does not treat it as an account.
  await t.engine.captureCurrent();
  assert.deepEqual(
    t.engine.listAccounts().map((p) => p.uuid),
    ["uuid-a"]
  );
});

test("forgetting the key in use removes its helper, secret and env dir", async () => {
  const t = setup();
  const entry = await t.engine.addApiKey("Work API", KEY);
  await t.engine.useApiKey(entry.id);
  const dir = await t.engine.materializeKeyEnvDir(entry.id);
  await t.engine.removeApiKey(entry.id);
  assert.equal("apiKeyHelper" in t.readSettings(), false);
  assert.equal(await t.engine.getApiKey(entry.id), null);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(t.engine.listApiKeys(), []);
});

test("reports settings that outrank saved keys", async () => {
  const t = setup();
  assert.deepEqual(t.engine.authOverrides(), []);
  fs.writeFileSync(t.settings, JSON.stringify({ env: { ANTHROPIC_API_KEY: "x", CLAUDE_CODE_USE_VERTEX: "0" } }));
  assert.deepEqual(t.engine.authOverrides(), ["ANTHROPIC_API_KEY"]);
});

test("a Console login's API key is saved with the account and restored on switch", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 }, { primaryApiKey: "sk-ant-console-key-of-A-000000000" });
  await t.engine.captureCurrent();
  assert.equal((await t.engine.getSecret("uuid-a")).managedApiKey, "sk-ant-console-key-of-A-000000000");
  // A claude.ai /login clears the Console key, as Claude Code does.
  t.login(B, { rt: "b1", exp: 100 });
  await t.engine.captureCurrent();

  await t.engine.switchTo("uuid-a");
  assert.equal(JSON.parse(fs.readFileSync(t.claudeJson, "utf8")).primaryApiKey, "sk-ant-console-key-of-A-000000000");
  await t.engine.switchTo("uuid-b");
  assert.equal(JSON.parse(fs.readFileSync(t.claudeJson, "utf8")).primaryApiKey, undefined);
});

// ---- CLI and status line -------------------------------------------------

test("CLI adds a piped key without printing it, and switches to it", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
  const cli = path.join(ROOT, "claude-plugin", "bin", "claude-switch");
  const out = execFileSync(process.execPath, [cli, "add-key", "Work", "API"], { input: KEY, env: t.env(), encoding: "utf8" });
  assert.match(out, /Saved the API key Work API \(…WXYZ\)/);
  assert.equal(out.includes(KEY), false);

  const used = execFileSync(process.execPath, [cli, "use", "work api"], { env: t.env(), encoding: "utf8" });
  assert.match(used, /Switched to the API key Work API/);
  const list = execFileSync(process.execPath, [cli, "list"], { env: t.env(), encoding: "utf8" });
  assert.match(list, /Active: API key Work API/);
  assert.equal(list.includes(KEY), false);

  const back = execFileSync(process.execPath, [cli, "use", "a@work.com"], { env: t.env(), encoding: "utf8" });
  assert.match(back, /Switched to a@work.com/);
  assert.equal("apiKeyHelper" in t.readSettings(), false);
});

test("status line shows the key in use, else the account", async () => {
  const t = setup();
  const script = path.join(ROOT, "claude-plugin", "statusline", "claude-account.js");
  const run = () => execFileSync(process.execPath, [script], { env: t.env(), encoding: "utf8" });
  fs.writeFileSync(path.join(t.config, ".claude.json"), JSON.stringify({ oauthAccount: B })); // stray
  t.login(A, { rt: "a1", exp: 100 });
  assert.equal(run(), "✻ a@work.com");
  const entry = await t.engine.addApiKey("Work API", KEY);
  await t.engine.useApiKey(entry.id);
  assert.equal(run(), "🔑 Work API");
});
