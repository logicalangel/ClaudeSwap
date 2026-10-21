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

function entryFor(acct) {
  const key = engine.acctKey(acct);
  return key ? engine.listAccounts().find((p) => p.uuid === key) || null : null;
}

// Optional per-account status bar colour from claudeAccounts.accountColors,
// keyed by email or alias.
function colorFor(entry) {
  if (!entry) return undefined;
  const colors = vscode.workspace.getConfiguration("claudeAccounts").get("accountColors", {});
  return colors[entry.email] || (entry.alias && colors[entry.alias]) || undefined;
}

function hasWorkspace() {
  return !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
}

function pinnedAccount() {
  return vscode.workspace.getConfiguration("claudeAccounts").get("account", "").trim();
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
  const pin = pinnedAccount();

  if (pin) {
    const entry = engine.resolve(pin);
    if (entry) {
      statusItem.text = `$(claude) ${engine.label(entry)} $(pinned)`;
      statusItem.color = colorFor(entry);
      statusItem.tooltip =
        `This workspace uses ${entry.email || pin}${planName(entry) ? ` (${planName(entry)})` : ""}.\n` +
        `Claude runs as this account here, isolated from other windows.\n` +
        (global ? `Global account: ${global.emailAddress}\n` : "") +
        "Click to switch or manage";
    } else {
      statusItem.text = `$(claude) ${pin} $(warning)`;
      statusItem.color = undefined;
      statusItem.tooltip = `This workspace is pinned to ${pin}, but it is not saved yet.\nUse 'Add account' to sign into it once.`;
    }
    statusItem.show();
    return;
  }

  const entry = entryFor(global);
  const name = entry ? engine.label(entry) : global ? global.emailAddress || "unknown" : "not logged in";
  const others = engine.listAccounts().filter((p) => p.uuid !== engine.acctKey(global)).length;
  statusItem.text = `$(claude) ${name}${others ? " $(chevron-down)" : ""}`;
  statusItem.color = colorFor(entry);
  statusItem.tooltip = global
    ? `Claude account: ${describe(global)}${planName(entry) ? ` · ${planName(entry)} plan` : ""}\n` +
      `${others} other saved account(s)\nClick to switch or manage`
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
  const entry = engine.resolve(pin);
  if (!entry) {
    col.delete(ENV_VAR);
    vscode.window.showWarningMessage(
      `This workspace is pinned to ${pin}, but that account is not saved yet. Use 'Add account' to sign into it once.`
    );
    updateStatusBar();
    return;
  }

  try {
    const dir = await engine.materializeEnvDir(entry.uuid);
    col.replace(ENV_VAR, dir);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not set up the workspace account: ${e.message}`);
  }
  updateStatusBar();
}

async function pinAccount() {
  if (!hasWorkspace()) {
    vscode.window.showWarningMessage("Open a folder or workspace before pinning an account to it.");
    return;
  }
  const list = engine.listAccounts();
  if (list.length === 0) {
    vscode.window.showInformationMessage("No saved accounts yet. Use 'Add account' to sign into one first.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((p) => ({
      label: `$(claude) ${engine.label(p)}`,
      description: [p.alias && p.email, detail(p)].filter(Boolean).join(" · "),
      id: p.email || p.uuid,
    })),
    { placeHolder: "Use which account for this workspace?" }
  );
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

// ---- global account switch (whole machine) ------------------------------
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
  updateStatusBar();
  const note = pinnedAccount() ? " This workspace is pinned, so its terminals keep the pinned account." : "";
  const open = await vscode.window.showInformationMessage(
    `Switched Claude Code to ${res.acct ? res.acct.emailAddress : uuid}. Running 'claude' sessions keep the old account until restarted.${note}`,
    "Open Claude terminal"
  );
  if (open) openClaudeTerminal();
}

async function chooseAndSwitch() {
  const current = engine.currentAccount();
  const list = engine.listAccounts().filter((p) => p.uuid !== engine.acctKey(current));
  if (list.length === 0) {
    vscode.window.showInformationMessage(
      "No other Claude accounts saved yet. Use 'Add account' to sign into another one."
    );
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((p) => ({ label: `$(claude) ${engine.label(p)}`, description: detail(p), uuid: p.uuid })),
    { placeHolder: "Switch the global Claude account to which one?" }
  );
  if (chosen) await applySwitch(chosen.uuid);
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

async function deleteProfile() {
  const list = engine.listAccounts();
  if (list.length === 0) {
    vscode.window.showInformationMessage("No saved accounts to remove.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((p) => ({ label: engine.label(p), description: detail(p), uuid: p.uuid })),
    { placeHolder: "Forget which saved account? (does not log you out)" }
  );
  if (!chosen) return;
  await engine.removeAccount(chosen.uuid);
  updateStatusBar();
  vscode.window.showInformationMessage(`Forgot account "${chosen.label}".`);
}

async function renameAccount() {
  const list = engine.listAccounts();
  if (list.length === 0) {
    vscode.window.showInformationMessage("No saved accounts to rename.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((p) => ({ label: engine.label(p), description: p.alias ? p.email : detail(p), entry: p })),
    { placeHolder: "Rename which account?" }
  );
  if (!chosen) return;
  const alias = await vscode.window.showInputBox({
    prompt: `Name for ${chosen.entry.email || chosen.entry.uuid} (leave empty to show the email)`,
    value: chosen.entry.alias || "",
  });
  if (alias === undefined) return;
  engine.setAlias(chosen.entry.uuid, alias.trim());
  updateStatusBar();
}

async function showMenu() {
  const global = engine.currentAccount();
  const globalUuid = engine.acctKey(global);
  const list = engine.listAccounts();
  const pin = pinnedAccount();
  const items = [];

  for (const p of list) {
    const isCurrent = p.uuid === globalUuid;
    items.push({
      label: `$(claude) ${engine.label(p)}`,
      description: [isCurrent && "current (global)", p.alias && p.email, detail(p)].filter(Boolean).join(" · "),
      uuid: p.uuid,
      action: isCurrent ? "noop" : "switch",
    });
  }
  if (global && !list.some((p) => p.uuid === globalUuid)) {
    items.unshift({ label: `$(claude) ${global.emailAddress}`, description: "current (global)", action: "noop" });
  }

  if (items.length) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  if (hasWorkspace()) {
    if (pin) items.push({ label: `$(pinned) Unpin this workspace (uses ${pin})`, action: "unpin" });
    else items.push({ label: "$(pin) Use an account for this workspace…", action: "pin" });
  }
  items.push({ label: "$(add) Add account…", action: "add" });
  items.push({ label: "$(edit) Rename an account…", action: "rename" });
  items.push({ label: "$(trash) Forget a saved account…", action: "delete" });
  items.push({ label: "$(refresh) Refresh now", action: "refresh" });

  const placeHolder = pin
    ? `Workspace uses ${pin}. Global: ${global ? global.emailAddress : "none"}.`
    : global
    ? `Signed in as ${global.emailAddress}. Pick an account to switch the global login.`
    : "No Claude account detected";

  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  if (!pick) return;
  if (pick.action === "switch") return applySwitch(pick.uuid);
  if (pick.action === "pin") return pinAccount();
  if (pick.action === "unpin") return unpinAccount();
  if (pick.action === "add") return addAccount();
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

  // Sync with the CLI: react to the files Claude Code rewrites on sign-in/out.
  const debounced = debounce(refresh, 400);
  for (const f of [engine.paths.CLAUDE_JSON, engine.paths.CRED_FILE]) {
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
