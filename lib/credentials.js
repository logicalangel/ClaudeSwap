// Shared account engine used by both the VS Code extension and the Claude Code
// plugin CLI. No VS Code dependencies. Stores saved accounts in the OS keychain
// on macOS, or a 0600 file on Linux/Windows (the same approach Claude Code uses
// for its own credentials), so both surfaces see the same accounts.
const { execFile } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const CUSTOM_CONFIG_DIR = !!process.env.CLAUDE_CONFIG_DIR;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CRED_FILE = path.join(CONFIG_DIR, ".credentials.json");
const STORE_SERVICE = "claude-switch"; // our saved snapshots (macOS keychain)
const STORE_DIR = path.join(CONFIG_DIR, "claude-switch");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const SECRETS_FILE = path.join(STORE_DIR, "secrets.json"); // non-macOS snapshot store
const ENVS_DIR = path.join(STORE_DIR, "envs");

// Entries of the global config dir that per-workspace env dirs share by link,
// so later changes to settings, commands, agents or plugins reach them too.
const SHARED_ENTRIES = ["settings.json", "CLAUDE.md", "commands", "agents", "skills", "plugins", "output-styles"];

// How long the live login must stay unchanged before it is saved. Guards
// against pairing one account's metadata with another's token mid-login.
const STABLE_MS = Number(process.env.CLAUDE_SWITCH_STABLE_MS || 300);

function claudeJsonPath() {
  const inDir = path.join(CONFIG_DIR, ".claude.json");
  if (fs.existsSync(inDir)) return inDir;
  return path.join(os.homedir(), ".claude.json");
}
const CLAUDE_JSON = claudeJsonPath();

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// Saved snapshots use the macOS Keychain by default; set CLAUDE_SWITCH_STORE=file
// to keep them in a 0600 file instead (also the default off macOS).
const storeUsesKeychain = isMac && process.env.CLAUDE_SWITCH_STORE !== "file";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- file helpers --------------------------------------------------------
// On Windows a 0600 mode does not restrict access; strip inherited ACLs and
// grant only the current user instead. Best effort.
function harden(file) {
  if (!isWin || !process.env.USERNAME) return;
  execFile("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], () => {});
}

// Write via a temp file and rename, so readers never see a half-written file
// and a crash cannot truncate it. Follows symlinks to write the real file.
function writeFileAtomic(file, data, mode) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    /* does not exist yet */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let m = mode;
  if (m === undefined) {
    try {
      m = fs.statSync(target).mode & 0o777;
    } catch {
      m = 0o644;
    }
  }
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: m });
  fs.chmodSync(tmp, m);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Windows refuses to replace a file another process holds open.
    fs.rmSync(tmp, { force: true });
    if (e.code !== "EPERM" && e.code !== "EBUSY") throw e;
    fs.writeFileSync(target, data, { mode: m });
  }
  if (m === 0o600) harden(target);
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ---- credential blobs ----------------------------------------------------
function parseOauth(raw) {
  try {
    return JSON.parse(raw).claudeAiOauth || null;
  } catch {
    return null;
  }
}

function credsExpiry(raw) {
  const o = raw && parseOauth(raw);
  return (o && Number(o.expiresAt)) || 0;
}

function credsPlan(raw) {
  const o = raw && parseOauth(raw);
  return (o && o.subscriptionType) || null;
}

function credsRefreshToken(raw) {
  const o = raw && parseOauth(raw);
  return (o && o.refreshToken) || null;
}

// Refresh tokens are single use, so whichever copy was refreshed last is the
// only one that still works. Prefer it; on a tie keep the first.
function newest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return credsExpiry(b) > credsExpiry(a) ? b : a;
}

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
  const args = ["delete-generic-password", "-s", service];
  if (account) args.push("-a", account);
  try {
    await security(args);
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

// Claude Code's keychain entry name. With CLAUDE_CONFIG_DIR set it keys the
// entry to that directory; the suffix scheme here (first 8 hex chars of the
// directory's sha256) is not documented, so callers treat a miss as "no entry".
function keychainServiceFor(dir, custom) {
  const base = "Claude Code-credentials";
  if (!custom) return base;
  return `${base}-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

// The global login's entry: the directory-keyed one when CLAUDE_CONFIG_DIR is
// set and that entry exists, else the plain name used before.
async function liveKeychainService() {
  const base = keychainServiceFor(CONFIG_DIR, false);
  if (!CUSTOM_CONFIG_DIR) return base;
  const keyed = keychainServiceFor(CONFIG_DIR, true);
  try {
    await security(["find-generic-password", "-s", keyed]);
    return keyed;
  } catch {
    return base;
  }
}

// ---- live credentials (what Claude Code reads) --------------------------
function liveUsesFile() {
  return fs.existsSync(CRED_FILE) || !isMac;
}

async function readLiveCreds() {
  try {
    if (fs.existsSync(CRED_FILE)) return fs.readFileSync(CRED_FILE, "utf8");
    if (isMac) return await keychainRead(await liveKeychainService());
  } catch {
    /* not signed in */
  }
  return null;
}

async function readLiveAcctAttr() {
  if (isMac && !fs.existsSync(CRED_FILE)) return keychainAcctAttr(await liveKeychainService());
  return "";
}

async function writeLiveCreds(value, acctHint) {
  if (liveUsesFile()) writeFileAtomic(CRED_FILE, value, 0o600);
  else await keychainWrite(await liveKeychainService(), acctHint, value);
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
  const raw = readFileOrNull(CLAUDE_JSON);
  if (raw) {
    try {
      j = JSON.parse(raw);
    } catch {
      // Never replace a file we cannot parse; it holds the user's history.
      throw new Error(`${CLAUDE_JSON} is not valid JSON; not changing it.`);
    }
  }
  j.oauthAccount = oauthAccount;
  writeFileAtomic(CLAUDE_JSON, JSON.stringify(j, null, 2));
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
  const data = JSON.stringify(list, null, 2);
  if (readFileOrNull(INDEX_FILE) === data) return;
  writeFileAtomic(INDEX_FILE, data);
}

// ---- saved-account secrets ----------------------------------------------
// Last value written or read per account, so unchanged snapshots are not
// rewritten on every poll (each keychain write spawns `security`).
const secretCache = new Map();

function readSecretsFile() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSecretsFile(obj) {
  writeFileAtomic(SECRETS_FILE, JSON.stringify(obj), 0o600);
}

async function getSecret(uuid) {
  let blob = null;
  if (storeUsesKeychain) {
    try {
      blob = JSON.parse(await keychainRead(STORE_SERVICE, uuid));
    } catch {
      blob = null;
    }
  } else {
    blob = readSecretsFile()[uuid] || null;
  }
  if (blob) secretCache.set(uuid, JSON.stringify(blob));
  else secretCache.delete(uuid);
  return blob;
}

async function setSecret(uuid, obj) {
  const data = JSON.stringify(obj);
  if (secretCache.get(uuid) === data) return false;
  if (storeUsesKeychain) {
    await keychainWrite(STORE_SERVICE, uuid, data);
  } else {
    const all = readSecretsFile();
    all[uuid] = obj;
    writeSecretsFile(all);
  }
  secretCache.set(uuid, data);
  return true;
}

async function delSecret(uuid) {
  secretCache.delete(uuid);
  if (storeUsesKeychain) {
    await keychainDelete(STORE_SERVICE, uuid);
  } else {
    const all = readSecretsFile();
    delete all[uuid];
    writeSecretsFile(all);
  }
}

// ---- per-account env dirs -----------------------------------------------
function envDir(uuid) {
  return path.join(ENVS_DIR, uuid);
}

// Newest credentials Claude Code holds for an env dir (keychain on macOS,
// with the plaintext file as fallback, like Claude Code itself).
async function readEnvCreds(dir) {
  let creds = readFileOrNull(path.join(dir, ".credentials.json"));
  if (isMac) {
    try {
      creds = newest(creds, await keychainRead(keychainServiceFor(dir, true)));
    } catch {
      /* no keychain entry */
    }
  }
  return creds;
}

async function writeEnvCreds(dir, creds, acctAttr) {
  const credPath = path.join(dir, ".credentials.json");
  if (readFileOrNull(credPath) !== creds) writeFileAtomic(credPath, creds, 0o600);
  if (isMac) {
    // Only update an entry Claude Code already created, so a wrong guess at
    // its name never leaves stray items in the user's keychain.
    const service = keychainServiceFor(dir, true);
    let current = null;
    try {
      current = await keychainRead(service);
    } catch {
      return;
    }
    if (current !== creds) {
      await keychainWrite(service, (await keychainAcctAttr(service)) || acctAttr || os.userInfo().username, creds);
    }
  }
}

// Point `link` at `target`. Falls back to a copy where links are not allowed
// (file symlinks on Windows without developer mode).
function linkShared(target, link) {
  try {
    if (fs.readlinkSync(link) === target) return;
  } catch {
    /* not a link */
  }
  fs.rmSync(link, { recursive: true, force: true });
  const isDir = fs.statSync(target).isDirectory();
  try {
    fs.symlinkSync(target, link, isDir ? "junction" : "file");
  } catch {
    if (isDir) fs.cpSync(target, link, { recursive: true });
    else fs.copyFileSync(target, link);
  }
}

// ---- high-level operations ----------------------------------------------
// Copy tokens refreshed inside env dirs back into the saved store, so the
// store always holds the newest working copy of each account.
async function syncEnvDirs() {
  let ids = [];
  try {
    ids = fs.readdirSync(ENVS_DIR);
  } catch {
    return;
  }
  for (const uuid of ids) {
    const envCreds = await readEnvCreds(envDir(uuid));
    if (!envCreds) continue;
    const blob = await getSecret(uuid);
    if (!blob || newest(blob.credentials, envCreds) === blob.credentials) continue;
    await setSecret(uuid, { ...blob, credentials: envCreds });
  }
}

function upsertIndex(uuid, acct, creds) {
  const list = getIndex();
  const prev = list.find((p) => p.uuid === uuid) || {};
  const entry = {
    ...prev,
    uuid,
    email: acct.emailAddress || null,
    organizationName: acct.organizationName || null,
    displayName: acct.displayName || null,
    organizationType: acct.organizationType || null,
    plan: credsPlan(creds) || prev.plan || null,
  };
  setIndex([...list.filter((p) => p.uuid !== uuid), entry]);
}

// Snapshot whatever account is live right now into the saved store.
async function captureCurrent() {
  await syncEnvDirs();

  const acct = readOauthAccount();
  const uuid = acctKey(acct);
  if (!acct || !uuid) return null;
  const creds = await readLiveCreds();
  if (!creds) return { uuid, acct, saved: false };

  const stored = await getSecret(uuid);
  if (stored && stored.credentials === creds) {
    upsertIndex(uuid, acct, creds);
    return { uuid, acct, saved: true };
  }

  // The live login changed. Make sure it has settled before pairing them.
  await sleep(STABLE_MS);
  if (acctKey(readOauthAccount()) !== uuid || (await readLiveCreds()) !== creds) {
    return { uuid, acct, saved: false };
  }
  // A token already saved under another account means the metadata and the
  // token are from different logins; wait for the next change.
  const rt = credsRefreshToken(creds);
  if (rt) {
    for (const p of getIndex()) {
      if (p.uuid === uuid) continue;
      const other = await getSecret(p.uuid);
      if (other && credsRefreshToken(other.credentials) === rt) return { uuid, acct, saved: false };
    }
  }

  // An env dir may have refreshed this account more recently than the global
  // login did; then the global token is dead, so hand it the newer one.
  const best = newest(creds, stored && stored.credentials);
  const acctAttr = (await readLiveAcctAttr()) || (stored && stored.acctAttr) || "";
  if (best !== creds) await writeLiveCreds(best, acctAttr || acct.emailAddress);

  await setSecret(uuid, { credentials: best, oauthAccount: acct, acctAttr });
  upsertIndex(uuid, acct, best);
  return { uuid, acct, saved: true };
}

function listAccounts() {
  return getIndex();
}

function currentAccount() {
  return readOauthAccount();
}

// Resolve a uuid, email or alias to a saved index entry.
function resolve(idOrEmail) {
  const list = getIndex();
  const q = String(idOrEmail).toLowerCase();
  return (
    list.find((p) => p.uuid === idOrEmail) ||
    list.find((p) => p.email && p.email.toLowerCase() === q) ||
    list.find((p) => p.alias && p.alias.toLowerCase() === q) ||
    null
  );
}

function setAlias(uuid, alias) {
  const list = getIndex();
  const entry = list.find((p) => p.uuid === uuid);
  if (!entry) return false;
  if (alias) entry.alias = alias;
  else delete entry.alias;
  setIndex(list);
  return true;
}

// Name to show for an account: its alias, else its email.
function label(entry) {
  return (entry && (entry.alias || entry.email || entry.displayName || entry.uuid)) || "";
}

async function switchTo(uuid) {
  await syncEnvDirs();
  const blob = await getSecret(uuid);
  if (!blob) return { ok: false, error: "No saved credentials for that account." };
  await writeLiveCreds(blob.credentials, blob.acctAttr || (blob.oauthAccount && blob.oauthAccount.emailAddress));
  if (blob.oauthAccount) writeOauthAccount(blob.oauthAccount);
  return { ok: true, acct: blob.oauthAccount || null };
}

async function removeAccount(uuid) {
  await delSecret(uuid);
  setIndex(getIndex().filter((p) => p.uuid !== uuid));
  const dir = envDir(uuid);
  if (isMac) await keychainDelete(keychainServiceFor(dir, true));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Build an isolated config directory for one account, holding its credentials
// plus links to the user's settings. Point CLAUDE_CONFIG_DIR at it to run that
// account in its own process without touching the global login.
async function materializeEnvDir(uuid) {
  const blob = await getSecret(uuid);
  if (!blob || !blob.credentials) throw new Error("No saved credentials for this account.");

  const dir = envDir(uuid);
  fs.mkdirSync(dir, { recursive: true });

  // Never overwrite a token Claude refreshed here with an older saved one.
  const existing = await readEnvCreds(dir);
  const best = newest(blob.credentials, existing);
  if (best !== blob.credentials) await setSecret(uuid, { ...blob, credentials: best });
  await writeEnvCreds(dir, best, blob.acctAttr);

  const metaPath = path.join(dir, ".claude.json");
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    /* create fresh */
  }
  meta.hasCompletedOnboarding = true;
  if (blob.oauthAccount) meta.oauthAccount = blob.oauthAccount;
  const metaData = JSON.stringify(meta, null, 2);
  if (readFileOrNull(metaPath) !== metaData) writeFileAtomic(metaPath, metaData);

  for (const name of SHARED_ENTRIES) {
    const target = path.join(CONFIG_DIR, name);
    if (fs.existsSync(target)) linkShared(target, path.join(dir, name));
  }

  return dir;
}

module.exports = {
  paths: { CLAUDE_JSON, CRED_FILE, INDEX_FILE, ENVS_DIR },
  acctKey,
  readOauthAccount,
  currentAccount,
  captureCurrent,
  listAccounts,
  resolve,
  label,
  setAlias,
  getSecret,
  switchTo,
  removeAccount,
  materializeEnvDir,
  syncEnvDirs,
  newest,
  credsPlan,
  keychainServiceFor,
};
