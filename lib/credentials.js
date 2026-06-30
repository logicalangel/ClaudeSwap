// Shared account engine used by both the VS Code extension and the Claude Code
// plugin CLI. No VS Code dependencies. Stores saved accounts in the OS keychain
// on macOS, or a 0600 file on Linux/Windows (the same approach Claude Code uses
// for its own credentials), so both surfaces see the same accounts.
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CRED_FILE = path.join(CONFIG_DIR, ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials"; // Claude Code's live tokens (macOS)
const STORE_SERVICE = "claude-switch"; // our saved snapshots (macOS keychain)
const STORE_DIR = path.join(CONFIG_DIR, "claude-switch");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const SECRETS_FILE = path.join(STORE_DIR, "secrets.json"); // non-macOS snapshot store

function claudeJsonPath() {
  const inDir = path.join(CONFIG_DIR, ".claude.json");
  if (fs.existsSync(inDir)) return inDir;
  return path.join(os.homedir(), ".claude.json");
}
const CLAUDE_JSON = claudeJsonPath();

const isMac = process.platform === "darwin";
// Saved snapshots use the macOS Keychain by default; set CLAUDE_SWITCH_STORE=file
// to keep them in a 0600 file instead (also the default off macOS).
const storeUsesKeychain = isMac && process.env.CLAUDE_SWITCH_STORE !== "file";

// ---- macOS keychain -----------------------------------------------------
function security(args) {
  return new Promise((resolve, reject) => {
    execFile("security", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function keychainRead(service, account) {
  const args = ["find-generic-password", "-s", service, "-w"];
  if (account) args.splice(3, 0, "-a", account);
  return (await security(args)).replace(/\n$/, "");
}

async function keychainWrite(service, account, value) {
  await security(["add-generic-password", "-U", "-s", service, "-a", account || "claude", "-w", value]);
}

async function keychainDelete(service, account) {
  try {
    await security(["delete-generic-password", "-s", service, "-a", account]);
  } catch {
    /* not found is fine */
  }
}

async function keychainAcctAttr(service) {
  try {
    const out = await security(["find-generic-password", "-s", service]);
    const m = out.match(/"acct"<blob>="([^"]*)"/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// ---- live credentials (what Claude Code reads) --------------------------
function liveUsesFile() {
  return fs.existsSync(CRED_FILE) || !isMac;
}

async function readLiveCreds() {
  try {
    if (fs.existsSync(CRED_FILE)) return fs.readFileSync(CRED_FILE, "utf8");
    if (isMac) return await keychainRead(KEYCHAIN_SERVICE);
  } catch {
    /* not signed in */
  }
  return null;
}

async function readLiveAcctAttr() {
  if (isMac && !fs.existsSync(CRED_FILE)) return keychainAcctAttr(KEYCHAIN_SERVICE);
  return "";
}

async function writeLiveCreds(value, acctHint) {
  if (liveUsesFile()) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CRED_FILE, value, { mode: 0o600 });
    fs.chmodSync(CRED_FILE, 0o600);
  } else {
    await keychainWrite(KEYCHAIN_SERVICE, acctHint, value);
  }
}

// ---- account metadata (~/.claude.json oauthAccount) ---------------------
function readOauthAccount() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).oauthAccount || null;
  } catch {
    return null;
  }
}

function writeOauthAccount(oauthAccount) {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  } catch {
    /* create fresh */
  }
  j.oauthAccount = oauthAccount;
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2));
}

function acctKey(acct) {
  return acct && (acct.accountUuid || acct.emailAddress);
}

// ---- saved-account index (non-secret) -----------------------------------
function getIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return [];
  }
}

function setIndex(list) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
}

// ---- saved-account secrets ----------------------------------------------
function readSecretsFile() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSecretsFile(obj) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(obj), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

async function getSecret(uuid) {
  if (storeUsesKeychain) {
    try {
      return JSON.parse(await keychainRead(STORE_SERVICE, uuid));
    } catch {
      return null;
    }
  }
  return readSecretsFile()[uuid] || null;
}

async function setSecret(uuid, obj) {
  if (storeUsesKeychain) {
    await keychainWrite(STORE_SERVICE, uuid, JSON.stringify(obj));
  } else {
    const all = readSecretsFile();
    all[uuid] = obj;
    writeSecretsFile(all);
  }
}

async function delSecret(uuid) {
  if (storeUsesKeychain) {
    await keychainDelete(STORE_SERVICE, uuid);
  } else {
    const all = readSecretsFile();
    delete all[uuid];
    writeSecretsFile(all);
  }
}

// ---- high-level operations ----------------------------------------------
// Snapshot whatever account is live right now into the saved store.
async function captureCurrent() {
  const acct = readOauthAccount();
  const uuid = acctKey(acct);
  if (!acct || !uuid) return null;
  const creds = await readLiveCreds();
  if (!creds) return { uuid, acct, saved: false };

  const acctAttr = await readLiveAcctAttr();
  await setSecret(uuid, { credentials: creds, oauthAccount: acct, acctAttr });
  const list = getIndex().filter((p) => p.uuid !== uuid);
  list.push({
    uuid,
    email: acct.emailAddress || null,
    organizationName: acct.organizationName || null,
    displayName: acct.displayName || null,
    organizationType: acct.organizationType || null,
  });
  setIndex(list);
  return { uuid, acct, saved: true };
}

function listAccounts() {
  return getIndex();
}

function currentAccount() {
  return readOauthAccount();
}

// Resolve a uuid or email to a saved index entry.
function resolve(idOrEmail) {
  const list = getIndex();
  return (
    list.find((p) => p.uuid === idOrEmail) ||
    list.find((p) => p.email && p.email.toLowerCase() === String(idOrEmail).toLowerCase()) ||
    null
  );
}

async function switchTo(uuid) {
  const blob = await getSecret(uuid);
  if (!blob) return { ok: false, error: "No saved credentials for that account." };
  await writeLiveCreds(blob.credentials, blob.acctAttr || (blob.oauthAccount && blob.oauthAccount.emailAddress));
  if (blob.oauthAccount) writeOauthAccount(blob.oauthAccount);
  return { ok: true, acct: blob.oauthAccount || null };
}

async function removeAccount(uuid) {
  await delSecret(uuid);
  setIndex(getIndex().filter((p) => p.uuid !== uuid));
  fs.rmSync(path.join(ENVS_DIR, uuid), { recursive: true, force: true });
}

// Build an isolated config directory for one account, holding its credentials
// plus the user's settings. Point CLAUDE_CONFIG_DIR at it to run that account in
// its own process without touching the global login.
const ENVS_DIR = path.join(STORE_DIR, "envs");

async function materializeEnvDir(uuid) {
  const blob = await getSecret(uuid);
  if (!blob || !blob.credentials) throw new Error("No saved credentials for this account.");

  const dir = path.join(ENVS_DIR, uuid);
  fs.mkdirSync(dir, { recursive: true });

  const credPath = path.join(dir, ".credentials.json");
  fs.writeFileSync(credPath, blob.credentials, { mode: 0o600 });
  fs.chmodSync(credPath, 0o600); // re-apply on overwrite, when the mode option is ignored

  const meta = { hasCompletedOnboarding: true };
  if (blob.oauthAccount) meta.oauthAccount = blob.oauthAccount;
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(meta, null, 2));

  const globalSettings = path.join(CONFIG_DIR, "settings.json");
  if (fs.existsSync(globalSettings)) fs.copyFileSync(globalSettings, path.join(dir, "settings.json"));

  return dir;
}

module.exports = {
  paths: { CLAUDE_JSON, CRED_FILE, INDEX_FILE },
  acctKey,
  readOauthAccount,
  currentAccount,
  captureCurrent,
  listAccounts,
  resolve,
  getSecret,
  switchTo,
  removeAccount,
  materializeEnvDir,
};
