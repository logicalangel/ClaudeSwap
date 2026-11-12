const vscode = require("vscode");
const path = require("path");
const engine = require("./lib/credentials");

const ENV_VAR = "CLAUDE_CONFIG_DIR";

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

// Window focus, file watchers and the poll can all fire at once; run one
// capture at a time and coalesce the rest into a single follow-up.
let refreshing = null;
let refreshAgain = false;

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
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

function openClaudeTerminal() {
  const term = vscode.window.createTerminal({ name: "Claude" });
  term.show();
  term.sendText("claude", true);
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
    if (target && target.kind === "apiKey") {
      statusItem.text = `$(key) ${target.key.name} $(pinned)`;
      statusItem.color = colorFor(target.key);
      statusItem.tooltip =
        `This workspace uses the API key ${target.key.name} (${keyDetail(target.key)}).\n` +
        `Claude runs with this key here, isolated from other windows.\n` +
        (globalName ? `Global: ${globalName}\n` : "") +
        "Click to switch or manage";
    } else if (target) {
      const entry = target.account;
      statusItem.text = `$(claude) ${engine.label(entry)} $(pinned)`;
      statusItem.color = colorFor(entry);
      statusItem.tooltip =
        `This workspace uses ${entry.email || pin}${planName(entry) ? ` (${planName(entry)})` : ""}.\n` +
        `Claude runs as this account here, isolated from other windows.\n` +
        (globalName ? `Global: ${globalName}\n` : "") +
        "Click to switch or manage";
    } else {
      statusItem.text = `$(claude) ${pin} $(warning)`;
      statusItem.color = undefined;
      statusItem.tooltip = `This workspace is pinned to ${pin}, but no saved account or API key has that name.\nUse 'Add account' or 'Add API key' first.`;
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
async function applyWorkspacePin() {
  const col = ctx.environmentVariableCollection;
  col.description = "ClaudeSwap: Claude account for this workspace";

  const pin = pinnedAccount();
  if (!pin) {
    col.delete(ENV_VAR);
    updateStatusBar();
    return;
  }
  const target = engine.resolveAny(pin);
  if (!target) {
    col.delete(ENV_VAR);
    vscode.window.showWarningMessage(
      `This workspace is pinned to ${pin}, but no saved account or API key has that name. Use 'Add account' or 'Add API key' first.`
    );
    updateStatusBar();
    return;
  }

  try {
    const dir =
      target.kind === "apiKey"
        ? await engine.materializeKeyEnvDir(target.key.id)
        : await engine.materializeEnvDir(target.account.uuid);
    col.replace(ENV_VAR, dir);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not set up the workspace account: ${e.message}`);
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
    placeHolder: "Use which account or API key for this workspace?",
  });
  if (!chosen) return;

  await vscode.workspace
    .getConfiguration("claudeAccounts")
    .update("account", chosen.id, vscode.ConfigurationTarget.Workspace);
  await applyWorkspacePin();
  const open = await vscode.window.showInformationMessage(
    `This workspace will use ${chosen.id}. Open a new terminal to apply it; existing terminals need a relaunch.`,
    "Open Claude terminal"
  );
  if (open) openClaudeTerminal();
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
  vscode.window.showInformationMessage("Unpinned. New terminals use your global account again.");
}

// ---- global switch (whole machine) --------------------------------------
async function afterSwitch(what, overrides) {
  updateStatusBar();
  const note = pinnedAccount() ? " This workspace is pinned, so its terminals keep the pinned account." : "";
  const open = await vscode.window.showInformationMessage(
    `Claude Code now uses ${what}. Running 'claude' sessions keep the old one until restarted.${note}${overrideNote(overrides)}`,
    "Open Claude terminal"
  );
  if (open) openClaudeTerminal();
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
    placeHolder: "Switch Claude Code (whole machine) to which account or API key?",
  });
  if (!chosen) return;
  if (chosen.keyId) return applyKeySwitch(chosen.keyId);
  if (activeKey && chosen.uuid === engine.acctKey(current)) return applyBackToLogin();
  return applySwitch(chosen.uuid);
}

async function addAccount() {
  await refresh(); // save the current account before a new sign-in replaces it
  const term = vscode.window.createTerminal({ name: "Claude sign-in" });
  term.show();
  term.sendText("claude auth login", true);
  vscode.window.showInformationMessage(
    "Sign in with the other Claude account in the terminal. ClaudeSwap saves it automatically, then it appears in your accounts."
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
    entry = await engine.addApiKey(name, key);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  updateStatusBar();
  const use = await vscode.window.showInformationMessage(
    `Saved the API key ${entry.name} (…${entry.hint}).`,
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
  if (!chosen) return;
  const name = await vscode.window.showInputBox({
    prompt: chosen.key
      ? `New name for the API key ${chosen.key.name}`
      : `Name for ${chosen.entry.email || chosen.entry.uuid} (leave empty to show the email)`,
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
      description: [isCurrent && "current (global)", p.alias && p.email, detail(p)].filter(Boolean).join(" · "),
      uuid: p.uuid,
      action: isCurrent ? "noop" : isUnder ? "login" : "switch",
    });
  }
  if (global && !list.some((p) => p.uuid === globalUuid)) {
    items.unshift({
      label: `$(claude) ${global.emailAddress}`,
      description: activeKey ? "" : "current (global)",
      action: activeKey ? "login" : "noop",
    });
  }
  for (const k of keys) {
    const isCurrent = activeKey && activeKey.id === k.id;
    items.push({
      label: `$(key) ${k.name}`,
      description: [isCurrent && "current (global)", keyDetail(k)].filter(Boolean).join(" · "),
      keyId: k.id,
      action: isCurrent ? "noop" : "useKey",
    });
  }

  if (items.length) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  if (hasWorkspace()) {
    if (pin) items.push({ label: `$(pinned) Unpin this workspace (uses ${pin})`, action: "unpin" });
    else items.push({ label: "$(pin) Use an account or key for this workspace…", action: "pin" });
  }
  items.push({ label: "$(add) Add account…", action: "add" });
  items.push({ label: "$(key) Add API key…", action: "addKey" });
  items.push({ label: "$(edit) Rename…", action: "rename" });
  items.push({ label: "$(trash) Forget a saved account or key…", action: "delete" });
  items.push({ label: "$(refresh) Refresh now", action: "refresh" });

  const globalName = activeKey ? `API key ${activeKey.name}` : global ? global.emailAddress : "none";
  const placeHolder = pin
    ? `Workspace uses ${pin}. Global: ${globalName}.`
    : activeKey
    ? `Using the API key ${activeKey.name}. Pick an account or key to switch.`
    : global
    ? `Signed in as ${global.emailAddress}. Pick an account or key to switch the global login.`
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
  if (pick.action === "rename") return renameAccount();
  if (pick.action === "delete") return deleteProfile();
  if (pick.action === "refresh") return refresh();
}

function activate(context) {
  ctx = context;

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

  // Capture the current account, then apply this workspace's account binding.
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
