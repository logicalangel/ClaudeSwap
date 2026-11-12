const vscode = require("vscode");
const path = require("path");
const { execFile } = require("child_process");
const engine = require("./lib/credentials");

const ENV_VAR = "CLAUDE_CONFIG_DIR";
// This window's own value before any pin changed it (each window has its own
// extension host process, so a pin set here affects only this window).
const ORIGINAL_CONFIG_DIR = process.env[ENV_VAR];
const STATUSLINE_SOURCE = path.join(__dirname, "claude-plugin", "statusline", "claude-account.js");

let ctx;
let statusItem;
let pollTimer;

function describe(acct) {
  if (!acct) return "not logged in";
  const email = acct.emailAddress || "unknown";
  const org = acct.organizationName;
  return org && org !== email ? `${email} (${org})` : email;
}

function planName(entry) {
  const plan = entry && entry.plan;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "";
}

// "Max · Acme Inc" style detail for menus.
function detail(entry) {
  return [planName(entry), entry.organizationName !== entry.email && entry.organizationName]
    .filter(Boolean)
    .join(" · ");
}

function keyDetail(key) {
  return ["API key", key.hint && `…${key.hint}`].filter(Boolean).join(" · ");
}

function entryFor(acct) {
  const key = engine.acctKey(acct);
  return key ? engine.listAccounts().find((p) => p.uuid === key) || null : null;
}

// Optional per-account status bar colour from claudeAccounts.accountColors,
// keyed by email, alias or API key name.
function colorFor(entry) {
  if (!entry) return undefined;
  const colors = vscode.workspace.getConfiguration("claudeAccounts").get("accountColors", {});
  return colors[entry.email] || (entry.alias && colors[entry.alias]) || (entry.name && colors[entry.name]) || undefined;
}

function hasWorkspace() {
  return !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
}

function pinnedAccount() {
  return vscode.workspace.getConfiguration("claudeAccounts").get("account", "").trim();
}

function overrideNote(overrides) {
  return overrides && overrides.length
    ? ` Note: ${overrides.join(", ")} is set, and Claude Code puts that ahead of saved keys and accounts.`
    : "";
}

function reloadWindow() {
  vscode.commands.executeCommand("workbench.action.reloadWindow");
}

// Window focus, file watchers and the poll can all fire at once; run one
// capture at a time and coalesce the rest into a single follow-up.
let refreshing = null;
let refreshAgain = false;
let knownAccounts = null; // uuids this window has already seen

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      try {
        await engine.captureCurrent();
      } catch {
        /* not signed in */
      }
    } while (refreshAgain);
    updateStatusBar();
    // Say so when a sign-in added an account. Only the focused window speaks,
    // so several open windows do not all announce the same account.
    const list = engine.listAccounts();
    if (knownAccounts && vscode.window.state.focused) {
      for (const p of list) if (!knownAccounts.has(p.uuid)) announceNewAccount(p);
    }
    knownAccounts = new Set(list.map((p) => p.uuid));
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

async function announceNewAccount(entry) {
  const pick = await vscode.window.showInformationMessage(
    `ClaudeSwap saved ${entry.email || entry.uuid}. It is in your accounts now.`,
    "Give it a name"
  );
  if (pick) await renameEntry({ entry });
}

function openClaudeTerminal(command = "claude") {
  const term = vscode.window.createTerminal({ name: "Claude" });
  term.show();
  term.sendText(command, true);
}

function updateStatusBar() {
  if (!statusItem) return;
  if (!vscode.workspace.getConfiguration("claudeAccounts").get("statusBar.show", true)) {
    statusItem.hide();
    return;
  }

  const global = engine.currentAccount();
  const activeKey = engine.activeApiKey();
  const globalName = activeKey ? `API key ${activeKey.name}` : global ? global.emailAddress : "";
  const pin = pinnedAccount();

  if (pin) {
    const target = engine.resolveAny(pin);
    const scope = "Claude runs with it in this window only: the Claude panel and the terminals.";
    if (target && target.kind === "apiKey") {
      statusItem.text = `$(key) ${target.key.name} $(pinned)`;
      statusItem.color = colorFor(target.key);
      statusItem.tooltip =
        `This workspace uses the API key ${target.key.name} (${keyDetail(target.key)}).\n${scope}\n` +
        (globalName ? `Other windows: ${globalName}\n` : "") +
        "Click to switch or manage";
    } else if (target) {
      const entry = target.account;
      statusItem.text = `$(claude) ${engine.label(entry)} $(pinned)`;
      statusItem.color = colorFor(entry);
      statusItem.tooltip =
        `This workspace uses ${entry.email || pin}${planName(entry) ? ` (${planName(entry)})` : ""}.\n${scope}\n` +
        (globalName ? `Other windows: ${globalName}\n` : "") +
        "Click to switch or manage";
    } else {
      statusItem.text = `$(claude) ${pin} $(error)`;
      statusItem.color = new vscode.ThemeColor("errorForeground");
      statusItem.tooltip =
        `This workspace is pinned to ${pin}, but no saved account or API key has that name.\n` +
        "Claude stays signed out here (it does not fall back to another account).\n" +
        "Add that account or key, or unpin the workspace.";
    }
    statusItem.show();
    return;
  }

  const others = engine.listAccounts().length + engine.listApiKeys().length - 1;

  if (activeKey) {
    statusItem.text = `$(key) ${activeKey.name}${others > 0 ? " $(chevron-down)" : ""}`;
    statusItem.color = colorFor(activeKey);
    statusItem.tooltip =
      `Claude Code uses the API key ${activeKey.name}${activeKey.hint ? ` (…${activeKey.hint})` : ""}.\n` +
      (global ? `Your claude.ai login (${global.emailAddress}) is kept; pick it to go back.\n` : "") +
      "Click to switch or manage";
    statusItem.show();
    return;
  }

  const entry = entryFor(global);
  const name = entry ? engine.label(entry) : global ? global.emailAddress || "unknown" : "not logged in";
  statusItem.text = `$(claude) ${name}${others > 0 ? " $(chevron-down)" : ""}`;
  statusItem.color = colorFor(entry);
  statusItem.tooltip = global
    ? `Claude account: ${describe(global)}${planName(entry) ? ` · ${planName(entry)} plan` : ""}\n` +
      `${Math.max(others, 0)} other saved account(s) and key(s)\nClick to switch or manage`
    : "No Claude account detected. Click to manage.";
  statusItem.show();
}

// ---- per-workspace account (isolated, parallel-safe) --------------------
// Point this window at a config dir: the terminals through the environment
// collection, and the Claude Code panel through this extension host's own
// environment, which it copies each time it starts a Claude session.
function setWindowConfigDir(dir) {
  const col = ctx.environmentVariableCollection;
  col.description = "ClaudeSwap: Claude account for this workspace";
  if (dir) {
    col.replace(ENV_VAR, dir);
    process.env[ENV_VAR] = dir;
    return;
  }
  col.delete(ENV_VAR);
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = ORIGINAL_CONFIG_DIR;
}

// Synchronous first step, run before anything else at startup so a Claude
// panel session restored with the window already starts with the pin.
function pointWindowAtPin() {
  const pin = pinnedAccount();
  if (!pin) {
    setWindowConfigDir(null);
    return null;
  }
  const target = engine.resolveAny(pin);
  setWindowConfigDir(target ? engine.envDirFor(target) : engine.unavailableEnvDir());
  return target;
}

async function applyWorkspacePin() {
  const pin = pinnedAccount();
  const target = pointWindowAtPin();
  if (pin && !target) {
    vscode.window.showErrorMessage(
      `This workspace is pinned to ${pin}, but no saved account or API key has that name. Claude stays signed out here until you add it or unpin the workspace.`
    );
  } else if (target) {
    try {
      if (target.kind === "apiKey") await engine.materializeKeyEnvDir(target.key.id);
      else await engine.materializeEnvDir(target.account.uuid);
    } catch (e) {
      setWindowConfigDir(engine.unavailableEnvDir());
      vscode.window.showErrorMessage(
        `Could not set up ${pin} for this workspace: ${e.message} Claude stays signed out here until this is fixed.`
      );
    }
  }
  updateStatusBar();
}

function accountItems() {
  return engine.listAccounts().map((p) => ({
    label: `$(claude) ${engine.label(p)}`,
    description: [p.alias && p.email, detail(p)].filter(Boolean).join(" · "),
    id: p.email || p.uuid,
  }));
}

function keyItems() {
  return engine.listApiKeys().map((k) => ({ label: `$(key) ${k.name}`, description: keyDetail(k), id: k.name }));
}

async function offerReload(message) {
  const pick = await vscode.window.showInformationMessage(message, "Reload window", "Open Claude terminal");
  if (pick === "Reload window") reloadWindow();
  if (pick === "Open Claude terminal") openClaudeTerminal();
}

async function pinAccount() {
  if (!hasWorkspace()) {
    vscode.window.showWarningMessage("Open a folder or workspace before pinning an account to it.");
    return;
  }
  const items = [...accountItems(), ...keyItems()];
  if (items.length === 0) {
    vscode.window.showInformationMessage("Nothing saved yet. Use 'Add account' or 'Add API key' first.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: "Pin which account or API key to this workspace?",
  });
  if (!chosen) return;

  await vscode.workspace
    .getConfiguration("claudeAccounts")
    .update("account", chosen.id, vscode.ConfigurationTarget.Workspace);
  await applyWorkspacePin();
  await offerReload(
    `This workspace now uses ${chosen.id}, in the Claude panel and the terminals of this window. New sessions use it right away; reload the window so Claude sessions that are already open switch too.`
  );
}

async function unpinAccount() {
  if (!pinnedAccount()) {
    vscode.window.showInformationMessage("This workspace is not pinned to an account.");
    return;
  }
  await vscode.workspace
    .getConfiguration("claudeAccounts")
    .update("account", undefined, vscode.ConfigurationTarget.Workspace);
  await applyWorkspacePin();
  await offerReload(
    "Unpinned. New Claude sessions in this window use your global account; reload the window so open ones switch too."
  );
}

// ---- global switch (whole machine) --------------------------------------
async function afterSwitch(what, overrides) {
  updateStatusBar();
  const pin = pinnedAccount();
  if (pin) {
    vscode.window.showInformationMessage(
      `Claude Code now uses ${what} in your other windows. This workspace is pinned to ${pin} and keeps it.${overrideNote(overrides)}`
    );
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Claude Code now uses ${what}. Open Claude sessions still use the previous one: reload the window and the Claude panel continues your conversation with ${what}, or continue the last conversation in a terminal.${overrideNote(overrides)}`,
    "Reload window",
    "Continue in terminal"
  );
  if (pick === "Reload window") reloadWindow();
  if (pick === "Continue in terminal") openClaudeTerminal("claude --continue");
}

async function applySwitch(uuid) {
  let res;
  try {
    res = await engine.switchTo(uuid);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res.ok) {
    vscode.window.showErrorMessage(res.error || "Switch failed.");
    return;
  }
  await afterSwitch(res.acct ? res.acct.emailAddress : uuid, engine.authOverrides());
}

async function applyKeySwitch(id) {
  let res;
  try {
    res = await engine.useApiKey(id);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res.ok) {
    vscode.window.showErrorMessage(res.error || "Switch failed.");
    return;
  }
  await afterSwitch(`the API key ${res.key.name}`, res.overrides);
}

// Back to the claude.ai login that is still in place under an API key.
async function applyBackToLogin() {
  try {
    await engine.clearApiKey();
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  const acct = engine.currentAccount();
  await afterSwitch(acct ? acct.emailAddress : "your claude.ai login", engine.authOverrides());
}

async function chooseAndSwitch() {
  const current = engine.currentAccount();
  const activeKey = engine.activeApiKey();
  const items = [];
  for (const p of engine.listAccounts()) {
    if (!activeKey && p.uuid === engine.acctKey(current)) continue;
    items.push({ label: `$(claude) ${engine.label(p)}`, description: detail(p), uuid: p.uuid });
  }
  for (const k of engine.listApiKeys()) {
    if (activeKey && activeKey.id === k.id) continue;
    items.push({ label: `$(key) ${k.name}`, description: keyDetail(k), keyId: k.id });
  }
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      "Nothing else saved yet. Use 'Add account' to sign into another account, or 'Add API key'."
    );
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: "Switch Claude Code (all windows that are not pinned) to which account or API key?",
  });
  if (!chosen) return;
  if (chosen.keyId) return applyKeySwitch(chosen.keyId);
  if (activeKey && chosen.uuid === engine.acctKey(current)) return applyBackToLogin();
  return applySwitch(chosen.uuid);
}

// `claude auth login` for the global login, also from a pinned window, whose
// terminals would otherwise sign in inside the pinned account's folder.
function globalLoginCommand() {
  const base = "claude auth login";
  if (!pinnedAccount()) return base;
  const orig = ORIGINAL_CONFIG_DIR;
  const shell = String(vscode.env.shell || "").toLowerCase();
  if (/pwsh|powershell/.test(shell)) {
    return orig ? `$env:${ENV_VAR}='${orig}'; ${base}` : `Remove-Item Env:${ENV_VAR} -ErrorAction SilentlyContinue; ${base}`;
  }
  if (/cmd(\.exe)?$/.test(shell)) return `set "${ENV_VAR}=${orig || ""}" && ${base}`;
  return orig ? `env ${ENV_VAR}='${orig.replace(/'/g, "'\\''")}' ${base}` : `env -u ${ENV_VAR} ${base}`;
}

async function addAccount() {
  await refresh(); // save the current account before a new sign-in replaces it
  const term = vscode.window.createTerminal({ name: "Claude sign-in" });
  term.show();
  term.sendText(globalLoginCommand(), true);
  vscode.window.showInformationMessage(
    "Sign in with the other account in the terminal. Claude Code then uses that account; the one you had stays saved, so you can switch back from the ClaudeSwap menu."
  );
}

async function addApiKey() {
  const name = await vscode.window.showInputBox({
    title: "Add API key (1/2)",
    prompt: "A name for this key, for example Work API",
    validateInput: (v) => (v.trim() ? null : "Enter a name"),
  });
  if (name === undefined) return;
  const key = await vscode.window.showInputBox({
    title: "Add API key (2/2)",
    prompt: `Paste the Anthropic API key for ${name.trim()}. It is stored in your ${
      process.platform === "darwin" ? "Keychain" : "private ClaudeSwap folder"
    }, never in settings.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "Paste the key"),
  });
  if (key === undefined) return;
  let entry;
  try {
    entry = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking the key with Anthropic…" },
      () => engine.addApiKey(name, key)
    );
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  updateStatusBar();
  const checked =
    entry.check === "ok"
      ? "Anthropic accepted it."
      : `It could not be checked (${entry.checkNote}); it was saved anyway.`;
  const use = await vscode.window.showInformationMessage(
    `Saved the API key ${entry.name} (…${entry.hint}). ${checked}`,
    "Use it now"
  );
  if (use) await applyKeySwitch(entry.id);
}

async function deleteProfile() {
  const items = [
    ...engine.listAccounts().map((p) => ({ label: engine.label(p), description: detail(p), uuid: p.uuid })),
    ...engine.listApiKeys().map((k) => ({ label: k.name, description: keyDetail(k), keyId: k.id })),
  ];
  if (items.length === 0) {
    vscode.window.showInformationMessage("No saved accounts or API keys to remove.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: "Forget which saved account or API key? (does not log you out)",
  });
  if (!chosen) return;
  if (chosen.keyId) await engine.removeApiKey(chosen.keyId);
  else await engine.removeAccount(chosen.uuid);
  updateStatusBar();
  vscode.window.showInformationMessage(`Forgot "${chosen.label}".`);
}

async function renameEntry(chosen) {
  const name = await vscode.window.showInputBox({
    prompt: chosen.key
      ? `New name for the API key ${chosen.key.name}`
      : `Name for ${chosen.entry.email || chosen.entry.uuid}, for example Work or Personal (leave empty to show the email)`,
    value: chosen.key ? chosen.key.name : chosen.entry.alias || "",
  });
  if (name === undefined) return;
  try {
    if (chosen.key) engine.renameApiKey(chosen.key.id, name);
    else engine.setAlias(chosen.entry.uuid, name.trim());
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  updateStatusBar();
}

async function renameAccount() {
  const items = [
    ...engine
      .listAccounts()
      .map((p) => ({ label: engine.label(p), description: p.alias ? p.email : detail(p), entry: p })),
    ...engine.listApiKeys().map((k) => ({ label: k.name, description: keyDetail(k), key: k })),
  ];
  if (items.length === 0) {
    vscode.window.showInformationMessage("No saved accounts or API keys to rename.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, { placeHolder: "Rename which one?" });
  if (chosen) await renameEntry(chosen);
}

// ---- Claude Code status line --------------------------------------------
function findNode() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("where", ["node"], (err, out) => resolve((!err && out.split(/\r?\n/)[0].trim()) || null));
      return;
    }
    // An interactive login shell, so version managers such as nvm are loaded.
    execFile(process.env.SHELL || "/bin/sh", ["-ilc", "command -v node"], { timeout: 15000 }, (err, out) => {
      const line = String(out || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/"))
        .pop();
      resolve(line || null);
    });
  });
}

async function setupStatusLine() {
  const node = await findNode();
  if (!node) {
    vscode.window.showErrorMessage("The status line script needs Node.js, and none was found on your PATH.");
    return;
  }
  let res;
  try {
    res = await engine.installStatusLine(STATUSLINE_SOURCE, node);
    if (!res.ok && res.existing) {
      const pick = await vscode.window.showWarningMessage(
        "Claude Code already has a status line of yours. Replace it with the ClaudeSwap account?",
        { modal: true },
        "Replace"
      );
      if (pick !== "Replace") return;
      res = await engine.installStatusLine(STATUSLINE_SOURCE, node, { replace: true });
    }
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  vscode.window.showInformationMessage(
    "Claude Code in the terminal now shows the account or key in its status line (✻ name, 🔑 for a key, 📌 when pinned). It appears from the next session on."
  );
}

// ---- menu ---------------------------------------------------------------
async function showManageMenu() {
  const statusLine = engine.statusLineState();
  const items = [
    { label: "$(edit) Rename an account or key…", action: "rename" },
    { label: "$(trash) Forget a saved account or key…", action: "delete" },
    {
      label: "$(terminal) Show the account in Claude Code's status line",
      description: statusLine === "ours" ? "on" : "",
      action: "statusLine",
    },
    { label: "$(refresh) Refresh now", action: "refresh" },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Manage ClaudeSwap" });
  if (!pick) return;
  if (pick.action === "rename") return renameAccount();
  if (pick.action === "delete") return deleteProfile();
  if (pick.action === "statusLine") return setupStatusLine();
  if (pick.action === "refresh") return refresh();
}

async function showMenu() {
  const global = engine.currentAccount();
  const globalUuid = engine.acctKey(global);
  const activeKey = engine.activeApiKey();
  const list = engine.listAccounts();
  const keys = engine.listApiKeys();
  const pin = pinnedAccount();
  const items = [];

  for (const p of list) {
    const isCurrent = !activeKey && p.uuid === globalUuid;
    const isUnder = activeKey && p.uuid === globalUuid;
    items.push({
      label: `$(claude) ${engine.label(p)}`,
      description: [
        isCurrent && "current",
        isUnder && "claude.ai login, kept under the key",
        p.alias && p.email,
        detail(p),
      ]
        .filter(Boolean)
        .join(" · "),
      uuid: p.uuid,
      action: isCurrent ? "noop" : isUnder ? "login" : "switch",
    });
  }
  if (global && !list.some((p) => p.uuid === globalUuid)) {
    items.unshift({
      label: `$(claude) ${global.emailAddress}`,
      description: activeKey ? "claude.ai login, kept under the key" : "current",
      action: activeKey ? "login" : "noop",
    });
  }
  for (const k of keys) {
    const isCurrent = activeKey && activeKey.id === k.id;
    items.push({
      label: `$(key) ${k.name}`,
      description: [isCurrent && "current", keyDetail(k)].filter(Boolean).join(" · "),
      keyId: k.id,
      action: isCurrent ? "noop" : "useKey",
    });
  }

  if (items.length) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  if (hasWorkspace()) {
    if (pin) items.push({ label: `$(pinned) Unpin this workspace (uses ${pin})`, action: "unpin" });
    else items.push({ label: "$(pin) Pin an account or key to this workspace…", action: "pin" });
  }
  items.push({ label: "$(add) Add account…", action: "add" });
  items.push({ label: "$(key) Add API key…", action: "addKey" });
  items.push({ label: "$(gear) Manage…", action: "manage" });

  const globalName = activeKey ? `the API key ${activeKey.name}` : global ? global.emailAddress : "nothing";
  const placeHolder = pin
    ? `This workspace is pinned to ${pin}. Picking below switches your other windows (now on ${globalName}).`
    : activeKey
    ? `Using the API key ${activeKey.name}. Pick an account or key to switch.`
    : global
    ? `Signed in as ${global.emailAddress}. Pick an account or key to switch.`
    : "No Claude account detected";

  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  if (!pick) return;
  if (pick.action === "switch") return applySwitch(pick.uuid);
  if (pick.action === "login") return applyBackToLogin();
  if (pick.action === "useKey") return applyKeySwitch(pick.keyId);
  if (pick.action === "pin") return pinAccount();
  if (pick.action === "unpin") return unpinAccount();
  if (pick.action === "add") return addAccount();
  if (pick.action === "addKey") return addApiKey();
  if (pick.action === "manage") return showManageMenu();
}

function activate(context) {
  ctx = context;
  knownAccounts = new Set(engine.listAccounts().map((p) => p.uuid));

  // Before anything else, so Claude sessions restored with the window start
  // with this workspace's pinned account.
  try {
    pointWindowAtPin();
  } catch {
    /* applyWorkspacePin below reports it */
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "claudeAccounts.menu";
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeAccounts.menu", showMenu),
    vscode.commands.registerCommand("claudeAccounts.switch", chooseAndSwitch),
    vscode.commands.registerCommand("claudeAccounts.addAccount", addAccount),
    vscode.commands.registerCommand("claudeAccounts.addApiKey", addApiKey),
    vscode.commands.registerCommand("claudeAccounts.deleteProfile", deleteProfile),
    vscode.commands.registerCommand("claudeAccounts.refresh", refresh),
    vscode.commands.registerCommand("claudeAccounts.pin", pinAccount),
    vscode.commands.registerCommand("claudeAccounts.unpin", unpinAccount),
    vscode.commands.registerCommand("claudeAccounts.rename", renameAccount),
    vscode.commands.registerCommand("claudeAccounts.setupStatusLine", setupStatusLine),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeAccounts.account")) applyWorkspacePin();
      else if (e.affectsConfiguration("claudeAccounts")) updateStatusBar();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refresh();
    })
  );

  // Sync with the CLI: react to the files Claude Code (or claude-switch in
  // another window) rewrites on sign-in/out and key switches.
  const debounced = debounce(refresh, 400);
  for (const f of [engine.paths.CLAUDE_JSON, engine.paths.CRED_FILE, engine.paths.SETTINGS_FILE]) {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(f), path.basename(f))
    );
    w.onDidChange(debounced);
    w.onDidCreate(debounced);
    w.onDidDelete(debounced);
    context.subscriptions.push(w);
  }

  pollTimer = setInterval(refresh, 20000); // backstop for macOS Keychain
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  try {
    engine.refreshStatusLineScript(STATUSLINE_SOURCE);
  } catch {
    /* not set up */
  }

  // Capture the current account, then set up this workspace's account binding.
  refresh().then(applyWorkspacePin);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
