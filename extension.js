const vscode = require("vscode");
const path = require("path");
const engine = require("./lib/credentials");

let statusItem;
let pollTimer;

function describe(acct) {
  if (!acct) return "not logged in";
  const email = acct.emailAddress || "unknown";
  const org = acct.organizationName;
  return org && org !== email ? `${email} (${org})` : email;
}

async function refresh() {
  try {
    await engine.captureCurrent();
  } catch {
    /* ignore capture errors (e.g. not signed in) */
  }
  updateStatusBar();
}

function updateStatusBar() {
  if (!statusItem) return;
  if (!vscode.workspace.getConfiguration("claudeAccounts").get("statusBar.show", true)) {
    statusItem.hide();
    return;
  }
  const acct = engine.currentAccount();
  const email = acct ? acct.emailAddress || "unknown" : "not logged in";
  const others = engine.listAccounts().filter((p) => p.uuid !== engine.acctKey(acct)).length;
  statusItem.text = `$(claude) ${email}${others ? " $(chevron-down)" : ""}`;
  statusItem.tooltip = acct
    ? `Claude account: ${describe(acct)}\n${others} other saved account(s)\nClick to switch or manage`
    : "No Claude account detected. Click to manage.";
  statusItem.show();
}

async function applySwitch(uuid) {
  const res = await engine.switchTo(uuid);
  if (!res.ok) {
    vscode.window.showErrorMessage(res.error || "Switch failed.");
    return;
  }
  updateStatusBar();
  vscode.window.showInformationMessage(
    `Switched Claude Code to ${res.acct ? res.acct.emailAddress : uuid}. Restart any running 'claude' session to pick it up.`
  );
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
    list.map((p) => ({ label: `$(claude) ${p.email || p.uuid}`, description: p.organizationName || "", uuid: p.uuid })),
    { placeHolder: "Switch Claude Code to which account?" }
  );
  if (chosen) await applySwitch(chosen.uuid);
}

async function addAccount() {
  await refresh(); // save the current account before a new sign-in replaces it
  const term = vscode.window.createTerminal({ name: "Claude sign-in" });
  term.show();
  term.sendText("claude auth login", true);
  vscode.window.showInformationMessage(
    "Sign in with the other Claude account in the terminal. Claude Switch saves it automatically, then it appears under your accounts."
  );
}

async function deleteProfile() {
  const list = engine.listAccounts();
  if (list.length === 0) {
    vscode.window.showInformationMessage("No saved accounts to remove.");
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((p) => ({ label: p.email || p.uuid, description: p.organizationName || "", uuid: p.uuid })),
    { placeHolder: "Forget which saved account? (does not log you out)" }
  );
  if (!chosen) return;
  await engine.removeAccount(chosen.uuid);
  updateStatusBar();
  vscode.window.showInformationMessage(`Forgot account "${chosen.label}".`);
}

async function showMenu() {
  const acct = engine.currentAccount();
  const curUuid = engine.acctKey(acct);
  const list = engine.listAccounts();
  const items = [];

  // List accounts directly so a switch is one click.
  for (const p of list) {
    const isCurrent = p.uuid === curUuid;
    items.push({
      label: `$(claude) ${p.email || p.displayName || p.uuid}`,
      description: isCurrent ? "current" : p.organizationName || "",
      uuid: p.uuid,
      action: isCurrent ? "noop" : "switch",
    });
  }
  if (acct && !list.some((p) => p.uuid === curUuid)) {
    items.unshift({ label: `$(claude) ${acct.emailAddress}`, description: "current", action: "noop" });
  }

  if (items.length) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(add) Add account…", action: "add" });
  items.push({ label: "$(trash) Forget a saved account…", action: "delete" });
  items.push({ label: "$(refresh) Refresh now", action: "refresh" });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: acct ? `Signed in as ${acct.emailAddress}. Pick an account to switch to.` : "No Claude account detected",
  });
  if (!pick) return;
  if (pick.action === "switch") return applySwitch(pick.uuid);
  if (pick.action === "add") return addAccount();
  if (pick.action === "delete") return deleteProfile();
  if (pick.action === "refresh") return refresh();
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "claudeAccounts.menu";
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeAccounts.menu", showMenu),
    vscode.commands.registerCommand("claudeAccounts.switch", chooseAndSwitch),
    vscode.commands.registerCommand("claudeAccounts.addAccount", addAccount),
    vscode.commands.registerCommand("claudeAccounts.deleteProfile", deleteProfile),
    vscode.commands.registerCommand("claudeAccounts.refresh", refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeAccounts")) updateStatusBar();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refresh();
    })
  );

  // Sync with the CLI: react to the files Claude Code rewrites on sign-in/out.
  const debounced = debounce(refresh, 400);
  for (const f of [engine.paths.CLAUDE_JSON, engine.paths.CRED_FILE]) {
    try {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(f), path.basename(f))
      );
      w.onDidChange(debounced);
      w.onDidCreate(debounced);
      w.onDidDelete(debounced);
      context.subscriptions.push(w);
    } catch {
      /* ignore */
    }
  }

  pollTimer = setInterval(refresh, 20000); // backstop for macOS Keychain
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  refresh();
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
