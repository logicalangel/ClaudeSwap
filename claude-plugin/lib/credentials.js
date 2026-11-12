// Shared account engine used by both the VS Code extension and the Claude Code
// plugin CLI. No VS Code dependencies. Stores saved accounts and API keys in the
// OS keychain on macOS, or 0600 files on Linux/Windows (the same approach Claude
// Code uses for its own credentials), so both surfaces see the same accounts.
const { execFile } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".claude");
const RUN_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || DEFAULT_CONFIG_DIR;

// Inside a pinned workspace CLAUDE_CONFIG_DIR is <config>/claude-switch/envs/<id>.
// The saved accounts and the global login belong to <config>, so work there.
const ENV_DIR_RE = /^(.*)[\\/]claude-switch[\\/]envs[\\/]([^\\/]+)[\\/]?$/;
const envMatch = RUN_CONFIG_DIR.match(ENV_DIR_RE);
const CONFIG_DIR = envMatch ? envMatch[1] : RUN_CONFIG_DIR;
const CUSTOM_CONFIG_DIR = envMatch
  ? path.resolve(CONFIG_DIR) !== path.resolve(DEFAULT_CONFIG_DIR)
  : !!process.env.CLAUDE_CONFIG_DIR;
const PINNED_ENV_ID = envMatch ? envMatch[2] : null;

const CRED_FILE = path.join(CONFIG_DIR, ".credentials.json");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
const STORE_SERVICE = "claude-switch"; // our saved account snapshots (macOS keychain)
const KEY_SERVICE = "claude-switch-apikey"; // our saved API keys (macOS keychain)
const STORE_DIR = path.join(CONFIG_DIR, "claude-switch");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const KEYS_FILE = path.join(STORE_DIR, "apikeys.json"); // API key names, no secrets
const KEYS_DIR = path.join(STORE_DIR, "keys"); // API key secrets off the keychain
const SECRETS_FILE = path.join(STORE_DIR, "secrets.json"); // non-macOS snapshot store
const ENVS_DIR = path.join(STORE_DIR, "envs");
const KEY_ENV_PREFIX = "key-";
// Used when a workspace's pinned account cannot be set up: no login at all, so
// Claude asks to sign in instead of quietly running as the global account.
const UNAVAILABLE_ENV = "_unavailable";
const STATUSLINE_FILE = path.join(STORE_DIR, "statusline.js");

// Entries of the global config dir that per-workspace env dirs share by link,
// so later changes to settings, commands, agents or plugins reach them too.
// settings.json is handled by ensureEnvSettings, because an active API key must
// not leak into a workspace pinned to an account.
const SHARED_ENTRIES = ["CLAUDE.md", "commands", "agents", "skills", "plugins", "output-styles"];

// How long the live login must stay unchanged before it is saved. Guards
// against pairing one account's metadata with another's token mid-login.
const STABLE_MS = Number(process.env.CLAUDE_SWITCH_STABLE_MS || 300);

// Where Claude Code keeps its global config: a legacy <config>/.config.json if
// present, else .claude.json in CLAUDE_CONFIG_DIR when that is set, else in the
// home directory. A stray ~/.claude/.claude.json is not read by Claude Code.
function claudeJsonPath() {
  const legacy = path.join(CONFIG_DIR, ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  return path.join(CUSTOM_CONFIG_DIR ? CONFIG_DIR : os.homedir(), ".claude.json");
}
const CLAUDE_JSON = claudeJsonPath();

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// Saved snapshots use the macOS Keychain by default; set CLAUDE_SWITCH_STORE=file
// to keep them in a 0600 file instead (also the default off macOS).
const storeUsesKeychain = isMac && process.env.CLAUDE_SWITCH_STORE !== "file";
// CLAUDE_SWITCH_KEYCHAIN=off keeps every keychain call away (used by the tests).
const keychainOff = process.env.CLAUDE_SWITCH_KEYCHAIN === "off";

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

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
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
function security(args, input) {
  if (keychainOff) return Promise.reject(new Error("keychain disabled"));
  return new Promise((resolve, reject) => {
    const child = execFile("security", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// `security -w` prints a password that is not printable ASCII (for example a
// saved account whose name has non-Latin letters) as hex. Decode it back.
function decodeKeychainOutput(out) {
  const s = out.replace(/\n$/, "");
  if (!/^(?:[0-9a-f]{2})+$/.test(s)) return s;
  const buf = Buffer.from(s, "hex");
  if (!buf.some((b) => b < 0x20 || b > 0x7e)) return s; // printable data is never shown as hex
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : s;
}

async function keychainRead(service, account) {
  const args = ["find-generic-password", "-s", service, "-w"];
  if (account) args.splice(3, 0, "-a", account);
  return decodeKeychainOutput(await security(args));
}

// `security -i` reads the command from stdin, so the secret never appears in
// the process list. Its line buffer is about 4 KB; longer values go on the
// command line, as Claude Code itself does.
const SECURITY_STDIN_LIMIT = 4032;

async function keychainWrite(service, account, value) {
  const acct = account || "claude";
  const hex = Buffer.from(value, "utf8").toString("hex");
  const line = `add-generic-password -U -a "${acct}" -s "${service}" -X "${hex}"\n`;
  if (line.length <= SECURITY_STDIN_LIMIT && !/["\\\n]/.test(acct + service)) {
    await security(["-i"], line);
  } else {
    await security(["add-generic-password", "-U", "-a", acct, "-s", service, "-X", hex]);
  }
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

// Claude Code's keychain entry names: "Claude Code-credentials" for the login
// and "Claude Code" for the API key a Console login creates. With
// CLAUDE_CONFIG_DIR set, both get a suffix of the first 8 hex chars of the
// directory's sha256 (checked against Claude Code 2.1.322).
function keychainServiceFor(dir, custom, kind = "-credentials") {
  const base = `Claude Code${kind}`;
  if (!custom) return base;
  return `${base}-${crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

// The global login's entry: the directory-keyed one when CLAUDE_CONFIG_DIR is
// set and that entry exists, else the plain name used before.
async function liveKeychainService(kind = "-credentials") {
  const base = keychainServiceFor(CONFIG_DIR, false, kind);
  if (!CUSTOM_CONFIG_DIR) return base;
  const keyed = keychainServiceFor(CONFIG_DIR, true, kind);
  try {
    await security(["find-generic-password", "-s", keyed]);
    return keyed;
  } catch {
    return base;
  }
}

// The keychain account name Claude Code uses for its own entries.
function keychainUser() {
  let u;
  try {
    u = process.env.USER || os.userInfo().username;
  } catch {
    u = "";
  }
  return /^[a-zA-Z0-9._-]+$/.test(u || "") ? u : "claude-code-user";
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

// ---- global config (~/.claude.json) -------------------------------------
function readClaudeJson() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  } catch {
    return null;
  }
}

function readOauthAccount() {
  const j = readClaudeJson();
  return (j && j.oauthAccount) || null;
}

function updateClaudeJson(mutate) {
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
  const before = JSON.stringify(j);
  mutate(j);
  if (raw && JSON.stringify(j) === before) return;
  writeFileAtomic(CLAUDE_JSON, JSON.stringify(j, null, 2));
}

function writeOauthAccount(oauthAccount) {
  updateClaudeJson((j) => {
    j.oauthAccount = oauthAccount;
  });
}

function acctKey(acct) {
  return acct && (acct.accountUuid || acct.emailAddress);
}

// ---- Console login API key (Claude Code's "/login managed key") ----------
// A Console login keeps an API key next to the OAuth token: in the keychain on
// macOS, else as primaryApiKey in ~/.claude.json. Saved with the account so a
// switch brings it back, and cleared when switching to a claude.ai account,
// the same way Claude Code's own /login clears it.
async function readManagedKey() {
  if (isMac) {
    try {
      const k = await keychainRead(await liveKeychainService(""), keychainUser());
      if (k) return k;
    } catch {
      /* none in the keychain */
    }
  }
  const j = readClaudeJson();
  return (j && j.primaryApiKey) || null;
}

async function writeManagedKey(key) {
  const live = await readManagedKey();
  if (key && live === key) return;
  if (isMac) {
    const service = await liveKeychainService("");
    if (key) {
      try {
        await keychainWrite(service, keychainUser(), key);
        updateClaudeJson((j) => delete j.primaryApiKey);
        return;
      } catch {
        /* keychain not writable: fall back to the config file, like Claude Code */
      }
    } else {
      await keychainDelete(service, keychainUser());
    }
  }
  updateClaudeJson((j) => {
    if (key) j.primaryApiKey = key;
    else delete j.primaryApiKey;
  });
}

// ---- saved-account index (non-secret) -----------------------------------
function readJsonList(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeJsonList(file, list) {
  const data = JSON.stringify(list, null, 2);
  if (readFileOrNull(file) === data) return;
  writeFileAtomic(file, data, 0o600);
}

function getIndex() {
  return readJsonList(INDEX_FILE);
}

function setIndex(list) {
  writeJsonList(INDEX_FILE, list);
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

// ---- saved API keys ------------------------------------------------------
// The list (id, name, last four characters) is a plain file; the keys sit in
// the keychain on macOS, else in one 0600 file each.
function listApiKeys() {
  return readJsonList(KEYS_FILE);
}

function setApiKeys(list) {
  writeJsonList(KEYS_FILE, list);
}

function findApiKey(idOrName) {
  const q = String(idOrName).toLowerCase();
  const list = listApiKeys();
  return list.find((k) => k.id === idOrName) || list.find((k) => k.name.toLowerCase() === q) || null;
}

function keyFile(id) {
  return path.join(KEYS_DIR, id);
}

// Claude Code accepts only a printable-ASCII token from apiKeyHelper.
function checkApiKey(key) {
  const k = String(key || "").trim();
  if (k.length < 20 || !/^[\x21-\x7e]+$/.test(k)) {
    throw new Error("That does not look like an API key (expected one line of printable characters, like sk-ant-...).");
  }
  return k;
}

// A name must not collide with another saved key or with an account's email
// or name, so `use <name>` always means one thing.
function nameTaken(name, except) {
  const q = name.toLowerCase();
  const key = listApiKeys().find((k) => k.name.toLowerCase() === q);
  if (key && key.id !== except) return true;
  return getIndex().some(
    (p) => p.uuid !== except && ((p.email && p.email.toLowerCase() === q) || (p.alias && p.alias.toLowerCase() === q))
  );
}

function settingsEnv() {
  try {
    return readSettings(SETTINGS_FILE).json.env || {};
  } catch {
    return {};
  }
}

// Ask the API whether it accepts the key, with one request that costs nothing
// (listing models). Goes to ANTHROPIC_BASE_URL when set, like Claude Code.
// "rejected" only for a 401; anything else that is not a success is reported
// as unverified, so an unusual gateway or a network hiccup never blocks saving.
async function verifyApiKey(key) {
  const base = (process.env.ANTHROPIC_BASE_URL || settingsEnv().ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base}/v1/models?limit=1`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: ctrl.signal,
    });
    if (res.ok) return { status: "ok" };
    if (res.status === 401) return { status: "rejected" };
    return { status: "unverified", reason: `the API answered ${res.status}` };
  } catch (e) {
    return { status: "unverified", reason: e.name === "AbortError" ? "no answer within 10 seconds" : "could not reach the API" };
  } finally {
    clearTimeout(timer);
  }
}

// Returns the saved entry plus `check` ("ok" or "unverified") and `checkNote`.
async function addApiKey(name, key, { verify = true } = {}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Give the API key a name, for example Work.");
  if (nameTaken(n)) throw new Error(`An account or API key is already called "${n}".`);
  const k = checkApiKey(key);
  const check = verify ? await verifyApiKey(k) : { status: "unverified", reason: "not checked" };
  if (check.status === "rejected") {
    throw new Error("Anthropic rejected this key (it is wrong, revoked or expired). Nothing was saved.");
  }
  const id = crypto.randomBytes(6).toString("hex");
  if (storeUsesKeychain) await keychainWrite(KEY_SERVICE, id, k);
  else writeFileAtomic(keyFile(id), k, 0o600);
  const entry = { id, name: n, hint: k.slice(-4), addedAt: new Date().toISOString() };
  setApiKeys([...listApiKeys(), entry]);
  return { ...entry, check: check.status, checkNote: check.reason || null };
}

async function getApiKey(id) {
  if (storeUsesKeychain) {
    try {
      return (await keychainRead(KEY_SERVICE, id)) || null;
    } catch {
      return null;
    }
  }
  const k = readFileOrNull(keyFile(id));
  return k ? k.trim() : null;
}

function renameApiKey(id, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("A saved API key needs a name.");
  if (nameTaken(n, id)) throw new Error(`An account or API key is already called "${n}".`);
  const list = listApiKeys();
  const entry = list.find((k) => k.id === id);
  if (!entry) return false;
  entry.name = n;
  setApiKeys(list);
  return true;
}

async function removeApiKey(id) {
  const active = activeApiKey();
  if (active && active.id === id) await clearApiKey();
  if (storeUsesKeychain) await keychainDelete(KEY_SERVICE, id);
  else fs.rmSync(keyFile(id), { force: true });
  setApiKeys(listApiKeys().filter((k) => k.id !== id));
  fs.rmSync(path.join(ENVS_DIR, KEY_ENV_PREFIX + id), { recursive: true, force: true });
}

// ---- apiKeyHelper (how Claude Code is pointed at a saved key) -------------
// The helper only prints the key from where ClaudeSwap keeps it, so the key
// itself never lands in settings.json.
function shellQuote(s) {
  return isWin ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

function helperCommand(id) {
  if (storeUsesKeychain) return `/usr/bin/security find-generic-password -s ${KEY_SERVICE} -a ${id} -w`;
  return `${isWin ? "type" : "cat"} ${shellQuote(keyFile(id))}`;
}

// The saved key id an apiKeyHelper command reads, or null if it is not ours.
function helperKeyId(cmd) {
  if (typeof cmd !== "string") return null;
  const m =
    cmd.match(new RegExp(`-s ${KEY_SERVICE} -a ([0-9a-f]{12}) -w`)) ||
    cmd.match(/claude-switch[\\/]keys[\\/]([0-9a-f]{12})\b/);
  return m ? m[1] : null;
}

// settings.json as { raw, json }; raw is null when the file does not exist.
// Throws on a file that is not valid JSON, so it is never replaced.
function readSettings(file) {
  const raw = readFileOrNull(file);
  if (raw === null || !raw.trim()) return { raw, json: {} };
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === "object" && !Array.isArray(json)) return { raw, json };
  } catch {
    /* fall through */
  }
  throw new Error(`${file} is not valid JSON; not changing it.`);
}

function writeSettings(file, { raw, json }) {
  const indent = (raw && (raw.match(/^\{\r?\n([ \t]+)"/) || [])[1]) || 2;
  const data = JSON.stringify(json, null, indent) + (raw && !raw.endsWith("\n") ? "" : "\n");
  if (data !== raw) writeFileAtomic(file, data);
}

// The saved key Claude Code uses globally right now, or null.
function activeApiKey() {
  let json;
  try {
    json = readSettings(SETTINGS_FILE).json;
  } catch {
    return null;
  }
  const id = helperKeyId(json.apiKeyHelper);
  if (!id) return null;
  return findApiKey(id) || { id, name: "removed key", hint: "", missing: true };
}

// Things that win over apiKeyHelper (and over a claude.ai login) in Claude
// Code's order: cloud providers, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY. Set
// in this process's environment or in settings.json "env".
function authOverrides() {
  const fromSettings = settingsEnv();
  return [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ].filter((name) => {
    const v = process.env[name] || fromSettings[name];
    return v && v !== "0" && v !== "false";
  });
}

// Point Claude Code at a saved API key for the whole machine. The claude.ai
// login stays in place underneath and comes back on switching to an account.
async function useApiKey(id) {
  const entry = findApiKey(id);
  if (!entry) return { ok: false, error: "No saved API key by that name." };
  if (!(await getApiKey(entry.id))) return { ok: false, error: `The key for "${entry.name}" is missing; add it again.` };
  const s = readSettings(SETTINGS_FILE);
  if (s.json.apiKeyHelper && !helperKeyId(s.json.apiKeyHelper)) {
    return {
      ok: false,
      error: `${SETTINGS_FILE} already has its own apiKeyHelper. ClaudeSwap will not replace it; remove it first to switch API keys here.`,
    };
  }
  s.json.apiKeyHelper = helperCommand(entry.id);
  writeSettings(SETTINGS_FILE, s);
  await syncEnvDirs();
  return { ok: true, key: entry, overrides: authOverrides() };
}

// Remove ClaudeSwap's apiKeyHelper (never one the user wrote themselves).
async function clearApiKey() {
  let s;
  try {
    s = readSettings(SETTINGS_FILE);
  } catch {
    return false;
  }
  if (!helperKeyId(s.json.apiKeyHelper)) return false;
  delete s.json.apiKeyHelper;
  writeSettings(SETTINGS_FILE, s);
  await syncEnvDirs();
  return true;
}

// ---- status line --------------------------------------------------------
// The status line script is copied to a fixed place in the store, so the
// command in settings.json survives extension updates (whose folder changes).
function isOurStatusLine(statusLine) {
  return !!(statusLine && typeof statusLine.command === "string" && statusLine.command.includes(STATUSLINE_FILE));
}

function statusLineState() {
  let json;
  try {
    json = readSettings(SETTINGS_FILE).json;
  } catch {
    return "unreadable";
  }
  if (!json.statusLine) return "none";
  return isOurStatusLine(json.statusLine) ? "ours" : "other";
}

function copyStatusLineScript(source) {
  const data = fs.readFileSync(source, "utf8");
  if (readFileOrNull(STATUSLINE_FILE) !== data) writeFileAtomic(STATUSLINE_FILE, data, 0o644);
}

// Point Claude Code's status line at the script. Replaces a status line the
// user set up themselves only with replace: true.
async function installStatusLine(source, nodePath, { replace = false } = {}) {
  const s = readSettings(SETTINGS_FILE);
  if (s.json.statusLine && !isOurStatusLine(s.json.statusLine) && !replace) return { ok: false, existing: true };
  copyStatusLineScript(source);
  s.json.statusLine = { type: "command", command: `${shellQuote(nodePath)} ${shellQuote(STATUSLINE_FILE)}` };
  writeSettings(SETTINGS_FILE, s);
  await syncEnvDirs();
  return { ok: true };
}

// Keep the copied script current after an update, if it is in use.
function refreshStatusLineScript(source) {
  if (fs.existsSync(STATUSLINE_FILE)) copyStatusLineScript(source);
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

// settings.json of an env dir. Normally a link to the user's settings. It is a
// generated copy instead when the global settings carry ClaudeSwap's
// apiKeyHelper (left out, so a workspace pinned to an account keeps that
// account) or when the workspace is pinned to an API key (its helper added).
function ensureEnvSettings(dir, keyId) {
  const link = path.join(dir, "settings.json");
  let global = null;
  try {
    global = readSettings(SETTINGS_FILE);
  } catch {
    /* unparseable: treated as having no helper of ours */
  }
  const globalHelperIsOurs = !!(global && helperKeyId(global.json.apiKeyHelper));
  if (!keyId && !globalHelperIsOurs) {
    if (fs.existsSync(SETTINGS_FILE)) linkShared(SETTINGS_FILE, link);
    else if (isSymlink(link)) fs.rmSync(link, { force: true });
    return;
  }
  const json = { ...((global && global.json) || {}) };
  if (globalHelperIsOurs) delete json.apiKeyHelper;
  if (keyId) json.apiKeyHelper = helperCommand(keyId);
  const data = JSON.stringify(json, null, 2) + "\n";
  // Drop a link first: writing through it would change the user's own file.
  if (isSymlink(link)) fs.rmSync(link, { force: true });
  if (readFileOrNull(link) !== data) writeFileAtomic(link, data, 0o600);
}

function linkSharedEntries(dir) {
  for (const name of SHARED_ENTRIES) {
    const target = path.join(CONFIG_DIR, name);
    if (fs.existsSync(target)) linkShared(target, path.join(dir, name));
  }
}

// ---- high-level operations ----------------------------------------------
// Copy tokens refreshed inside env dirs back into the saved store, so the
// store always holds the newest working copy of each account, and keep each
// env dir's settings in step with the global ones.
async function syncEnvDirs() {
  let entries = [];
  try {
    entries = fs.readdirSync(ENVS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue; // e.g. .DS_Store
    const name = ent.name;
    const dir = envDir(name);
    if (name.startsWith(KEY_ENV_PREFIX)) {
      const id = name.slice(KEY_ENV_PREFIX.length);
      if (findApiKey(id)) ensureEnvSettings(dir, id);
      continue;
    }
    ensureEnvSettings(dir, null);
    if (name === UNAVAILABLE_ENV) continue;
    // Someone signed into another account inside this pinned dir: never save
    // that token under the pinned account.
    if (!envBelongsTo(dir, name)) continue;
    const envCreds = await readEnvCreds(dir);
    if (!envCreds) continue;
    const blob = await getSecret(name);
    if (!blob || newest(blob.credentials, envCreds) === blob.credentials) continue;
    await setSecret(name, { ...blob, credentials: envCreds });
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

function snapshot(credentials, oauthAccount, acctAttr, managedApiKey) {
  const blob = { credentials, oauthAccount, acctAttr };
  if (managedApiKey) blob.managedApiKey = managedApiKey;
  return blob;
}

// Snapshot whatever account is live right now into the saved store.
async function captureCurrent() {
  await syncEnvDirs();

  const acct = readOauthAccount();
  const uuid = acctKey(acct);
  if (!acct || !uuid) return null;
  const creds = await readLiveCreds();
  if (!creds) return { uuid, acct, saved: false };
  const managed = await readManagedKey();

  const stored = await getSecret(uuid);
  if (stored && stored.credentials === creds && (stored.managedApiKey || null) === managed) {
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

  await setSecret(uuid, snapshot(best, acct, acctAttr, managed));
  upsertIndex(uuid, acct, best);
  return { uuid, acct, saved: true };
}

function listAccounts() {
  return getIndex();
}

function currentAccount() {
  return readOauthAccount();
}

// Resolve a uuid, email or alias to a saved account index entry.
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

// Resolve a name to a saved account or API key.
function resolveAny(q) {
  const account = resolve(q);
  if (account) return { kind: "account", account };
  const key = findApiKey(q);
  if (key) return { kind: "apiKey", key };
  return null;
}

function setAlias(uuid, alias) {
  const list = getIndex();
  const entry = list.find((p) => p.uuid === uuid);
  if (!entry) return false;
  if (alias && nameTaken(alias, uuid)) throw new Error(`An account or API key is already called "${alias}".`);
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
  // Fail before touching the token if the metadata cannot be updated with it.
  updateClaudeJson(() => {});

  // Keep the Console API key of the account being left, before clearing it.
  const leaving = acctKey(readOauthAccount());
  const liveManaged = await readManagedKey();
  if (liveManaged && leaving && leaving !== uuid) {
    const prev = await getSecret(leaving);
    if (prev && prev.managedApiKey !== liveManaged) await setSecret(leaving, { ...prev, managedApiKey: liveManaged });
  }

  await writeLiveCreds(blob.credentials, blob.acctAttr || (blob.oauthAccount && blob.oauthAccount.emailAddress));
  if (blob.oauthAccount) writeOauthAccount(blob.oauthAccount);
  if ((blob.managedApiKey || null) !== liveManaged) await writeManagedKey(blob.managedApiKey || null);
  await clearApiKey();
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Never overwrite a token Claude refreshed here with an older saved one,
  // but drop a token from another account signed in here by mistake.
  const existing = envBelongsTo(dir, uuid) ? await readEnvCreds(dir) : null;
  const best = newest(blob.credentials, existing);
  if (best !== blob.credentials) await setSecret(uuid, { ...blob, credentials: best });
  await writeEnvCreds(dir, best, blob.acctAttr);

  writeEnvMeta(dir, (meta) => {
    if (blob.oauthAccount) meta.oauthAccount = blob.oauthAccount;
  });
  linkSharedEntries(dir);
  ensureEnvSettings(dir, null);
  return dir;
}

// Same for a saved API key: no OAuth login, and an apiKeyHelper for the key.
async function materializeKeyEnvDir(id) {
  const entry = findApiKey(id);
  if (!entry) throw new Error("No saved API key by that name.");
  if (!(await getApiKey(entry.id))) throw new Error(`The key for "${entry.name}" is missing; add it again.`);

  const dir = envDir(KEY_ENV_PREFIX + entry.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeEnvMeta(dir, (meta) => {
    delete meta.oauthAccount;
  });
  linkSharedEntries(dir);
  ensureEnvSettings(dir, entry.id);
  return dir;
}

// Whether the login Claude Code holds in an env dir is the account the dir is
// for. Claude Code writes oauthAccount there on sign-in; no record counts as yes.
function envBelongsTo(dir, uuid) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
    const owner = acctKey(meta.oauthAccount);
    return !owner || owner === uuid;
  } catch {
    return true;
  }
}

// The env dir a pin uses, known without touching the keychain, so a window can
// point Claude at it before anything else starts.
function envDirFor(target) {
  if (!target) return null;
  return target.kind === "apiKey" ? envDir(KEY_ENV_PREFIX + target.key.id) : envDir(target.account.uuid);
}

function unavailableEnvDir() {
  const dir = envDir(UNAVAILABLE_ENV);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeEnvMeta(dir, (meta) => {
    delete meta.oauthAccount;
  });
  return dir;
}

function writeEnvMeta(dir, mutate) {
  const metaPath = path.join(dir, ".claude.json");
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    /* create fresh */
  }
  meta.hasCompletedOnboarding = true;
  mutate(meta);
  const metaData = JSON.stringify(meta, null, 2);
  if (readFileOrNull(metaPath) !== metaData) writeFileAtomic(metaPath, metaData);
}

module.exports = {
  paths: { CLAUDE_JSON, CRED_FILE, INDEX_FILE, ENVS_DIR, SETTINGS_FILE, KEYS_FILE, STATUSLINE_FILE },
  pinnedEnvId: PINNED_ENV_ID,
  envDirFor,
  unavailableEnvDir,
  statusLineState,
  installStatusLine,
  refreshStatusLineScript,
  verifyApiKey,
  acctKey,
  readOauthAccount,
  currentAccount,
  captureCurrent,
  listAccounts,
  resolve,
  resolveAny,
  label,
  setAlias,
  getSecret,
  switchTo,
  removeAccount,
  materializeEnvDir,
  materializeKeyEnvDir,
  syncEnvDirs,
  newest,
  credsPlan,
  keychainServiceFor,
  decodeKeychainOutput,
  // API keys
  listApiKeys,
  findApiKey,
  addApiKey,
  getApiKey,
  renameApiKey,
  removeApiKey,
  useApiKey,
  clearApiKey,
  activeApiKey,
  authOverrides,
  helperCommand,
  helperKeyId,
};
