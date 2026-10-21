// Engine tests. Each test gets a fresh fake home and config dir, and the
// file-based store, so nothing touches the real login or keychain.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENGINE = require.resolve("../lib/credentials");

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudeswap-"));
  const config = path.join(home, ".claude");
  fs.mkdirSync(config);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.CLAUDE_SWITCH_STORE = "file";
  process.env.CLAUDE_SWITCH_STABLE_MS = "5";
  delete require.cache[ENGINE];
  const engine = require(ENGINE);
  const claudeJson = path.join(home, ".claude.json");
  const credFile = path.join(config, ".credentials.json");
  return {
    engine,
    home,
    config,
    claudeJson,
    credFile,
    login(acct, token) {
      fs.writeFileSync(credFile, creds(token));
      const j = fs.existsSync(claudeJson) ? JSON.parse(fs.readFileSync(claudeJson, "utf8")) : {};
      j.oauthAccount = acct;
      fs.writeFileSync(claudeJson, JSON.stringify(j));
    },
  };
}

function creds({ rt, exp, plan = "pro" }) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${rt}`, refreshToken: rt, expiresAt: exp, subscriptionType: plan },
  });
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
  if (process.platform !== "win32") assert.equal(fs.statSync(t.credFile).mode & 0o777, 0o600);
});

test("refuses to rewrite an unparseable .claude.json", async () => {
  const t = setup();
  t.login(A, { rt: "a1", exp: 100 });
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
  if (process.platform === "win32") return ctx.skip("symlinks need developer mode");
  const t = setup();
  fs.writeFileSync(path.join(t.config, "settings.json"), '{"model":"x"}');
  fs.mkdirSync(path.join(t.config, "commands"));
  t.login(A, { rt: "a1", exp: 100 });
  await t.engine.captureCurrent();
  const dir = await t.engine.materializeEnvDir("uuid-a");
  assert.equal(fs.readlinkSync(path.join(dir, "settings.json")), path.join(t.config, "settings.json"));
  assert.equal(fs.readlinkSync(path.join(dir, "commands")), path.join(t.config, "commands"));
  fs.writeFileSync(path.join(t.config, "settings.json"), '{"model":"y"}');
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
