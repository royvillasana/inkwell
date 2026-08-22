/* ===========================================================================
   Connections: the interface for the sources of notes that are not this disk.

   Two surfaces, kept apart on purpose:

     * a Connections list, reached from Preferences, where a connection is
       added, signed in to, given permissions, or taken away;
     * a file browser, which takes over the Files pane in the sidebar while you
       are looking at a connection, and hands back when you leave.

   The renderer never sees a token, never makes a request, and never decides
   whether a tool may be used. It asks the main process, which asks the
   allowlist, which was filled in here — deliberately, by a person.
   =========================================================================== */
import { $, $$ } from "./editor.js";
import { dialog, say, closeModal } from "./dialogs.js";

const api = window.inkju;

let enabled = false;
let list = [];
let presets = [];
let openRemote = () => {};
let toast = () => {};

export function setRemoteOpener(fn){ openRemote = fn; }
export function setToast(fn){ toast = fn; }

/* The connection whose files the sidebar is currently showing, or null when
   the sidebar is back to the vault. */
let browsing = null;
export const browsingId = () => (browsing ? browsing.id : null);

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const STATUS_TEXT = {
  "disconnected": "not connected",
  "connecting": "connecting…",
  "connected": "connected",
  "needs-authorization": "needs you to sign in",
  "failed": "could not connect"
};

/* --------------------------------------------------------------- loading */

export async function init(){
  try { enabled = await api.connections.enabled(); }
  catch (err) { enabled = false; }
  if (!enabled) return false;
  await refresh();
  try { presets = await api.connections.presets(); } catch (err) { presets = []; }

  /* Status is pushed, so a connection that drops updates the interface without
     anything having to poll for it. */
  api.on.connectionStatus(e => {
    const c = list.find(x => x.id === e.id);
    if (c) { c.status = e.status; c.detail = e.detail; }
    if (browsing && browsing.id === e.id) { browsing.status = e.status; renderBrowser(); }
    paintList();
  });
  api.on.connectionsChanged(() => refresh().then(paintList));
  api.on.connectionToolsAppeared(e => {
    const c = list.find(x => x.id === e.id);
    toast((c ? c.label : "A connection") + " added " + e.tools.length +
      (e.tools.length === 1 ? " new tool" : " new tools") + ". It is switched off until you allow it.");
  });
  return true;
}

export const isEnabled = () => enabled;

async function refresh(){
  try { list = await api.connections.list(); }
  catch (err) { list = []; }
  return list;
}

/* ------------------------------------------------------- the list dialog */

let listBody = null;

function paintList(){
  /* No document.contains() check: the first paint happens while the node is
     still detached, on its way into the dialog. Requiring it to be mounted
     meant the list was only ever painted by a later status event — which, for
     someone with no connections yet, never came. */
  if (!listBody) return;
  listBody.textContent = "";

  if (!list.length) {
    const empty = el("div", "side-empty",
      "No connections yet. Add one to open notes that live somewhere other than this Mac.");
    listBody.appendChild(empty);
  }

  for (const c of list) {
    const row = el("div", "conn-row" + (c.enabled ? "" : " off"));

    const head = el("div", "conn-head");
    head.appendChild(el("span", "conn-name", c.label));
    const dot = el("span", "conn-dot " + c.status);
    dot.title = STATUS_TEXT[c.status] || c.status;
    head.appendChild(dot);
    head.appendChild(el("small", "conn-status", STATUS_TEXT[c.status] || c.status));
    row.appendChild(head);

    const what = c.transport === "http" ? c.config.url
      : c.transport === "stdio" ? c.config.command + " " + (c.config.args || []).join(" ")
      : c.config.root;
    row.appendChild(el("small", "conn-what", what));
    if (c.detail) row.appendChild(el("small", "conn-detail", c.detail));

    const allowed = c.allow.length;
    const total = c.tools.length;
    if (total) {
      row.appendChild(el("small", "conn-tools",
        allowed + " of " + total + " tool" + (total === 1 ? "" : "s") + " allowed"));
    }

    const acts = el("div", "conn-acts");
    const act = (label, fn, cls) => {
      const b = el("button", "ghost " + (cls || ""), label);
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    };

    if (c.status === "connected") {
      act("Browse", () => { closeModal(null); startBrowsing(c.id); });
      act("Permissions…", () => allowlistDialog(c.id));
      act("Disconnect", async () => { await api.connections.disconnect(c.id); await refresh(); paintList(); });
    } else if (c.status === "needs-authorization") {
      act("Sign in…", () => runConnect(c, true));
    } else {
      act("Connect", () => runConnect(c, false));
    }
    act(c.enabled ? "Turn off" : "Turn on", async () => {
      await api.connections.update(c.id, { enabled: !c.enabled });
      if (c.enabled) await api.connections.disconnect(c.id);
      await refresh(); paintList();
    });
    act("Remove", () => removeConnection(c), "danger");
    row.appendChild(acts);
    listBody.appendChild(row);
  }

  /* iCloud Drive sits in the same list because that is where a user will look
     for it — and is described as what it is. Apple publishes no API for a
     person's iCloud Drive documents, so there is no account to connect and
     nothing here speaks MCP. It is a folder that syncs. */
  if (icloud && icloud.root) {
    const row = el("div", "conn-row");
    const head = el("div", "conn-head");
    head.appendChild(el("span", "conn-name", "iCloud Drive"));
    if (icloud.vaultIsInside) head.appendChild(el("small", "conn-status", "your vault is in here"));
    row.appendChild(head);
    row.appendChild(el("small", "conn-what",
      "A folder on this Mac that syncs through iCloud. Not an account connection — Apple offers no way for other apps to reach your iCloud Drive, so Inkju opens the folder macOS keeps here."));
    const acts = el("div", "conn-acts");
    const b = el("button", "ghost", "Open a vault in iCloud Drive…");
    b.onclick = async () => {
      try {
        const r = await api.icloud.openVault();
        if (r) { closeModal(null); toast("Opened " + r.root.split("/").pop() + " from iCloud Drive."); location.reload(); }
      } catch (err) { say(err.message, "Could not open that folder"); }
    };
    acts.appendChild(b);
    row.appendChild(acts);
    listBody.appendChild(row);
  }
}

let icloud = null;

export async function connectionsDialog(){
  if (!enabled) {
    return say("Connections are not switched on in this build of Inkju.", "Not available");
  }
  await refresh();
  try { icloud = await api.icloud.info(); } catch (err) { icloud = null; }

  listBody = el("div", "conn-list");
  paintList();

  const add = el("button", "side-action", "Add a connection…");
  add.onclick = async () => { closeModal(null); await addConnectionFlow(); connectionsDialog(); };

  const note = el("small", "conn-foot",
    "With no connections, Inkju reaches the network only to check for updates. Each one you add is a place you have chosen to let it reach.");

  await dialog({
    title: "Connections",
    wide: true,
    fields: [{ type: "node", node: listBody }, { type: "node", node: add }, { type: "node", node: note }],
    buttons: [{ label: "Done", value: "ok", primary: true }]
  });
  listBody = null;
}

async function removeConnection(c){
  const r = await dialog({
    title: "Remove " + c.label + "?",
    message: "Inkju forgets the connection and deletes the credentials it stored for it. " +
      "Nothing in the connected account is touched, and any file you saved into your vault stays where it is.",
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Remove", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") return;
  await api.connections.remove(c.id);
  if (browsing && browsing.id === c.id) stopBrowsing();
  await refresh();
  paintList();
}

/* ------------------------------------------------------------ connecting */

async function runConnect(c, interactive){
  try {
    toast("Connecting to " + c.label + "…");
    const r = interactive ? await api.connections.authorize(c.id) : await api.connections.connect(c.id);
    await refresh();
    paintList();
    const fresh = list.find(x => x.id === c.id);
    /* A server nobody has given permissions to yet is connected and useless.
       Offer the permissions straight away rather than leaving an empty
       browser and no clue why. */
    if (fresh && !fresh.allow.length && fresh.tools.length) await allowlistDialog(c.id, true);
    else toast(c.label + " connected.");
    return r;
  } catch (err) {
    await refresh();
    paintList();
    say(err.message, "Could not connect to " + c.label);
    return null;
  }
}

/* ----------------------------------------------------------- permissions */

/* Deny by default, and visibly so. Read tools this connection needs to be
   useful are proposed ticked; everything that writes is proposed unticked and
   labelled, because a tick here is the difference between a browser and
   something that can change what is in the account. */
export async function allowlistDialog(id, firstTime){
  const c = list.find(x => x.id === id) || await api.connections.get(id);
  if (!c.tools.length) {
    return say("This connection has not told Inkju what it can do yet. Connect it first.", c.label);
  }
  const proposed = firstTime
    ? await api.connections.proposeAllow(id, ["search_files", "read_file_content", "get_file_metadata",
        "list_recent_files", "list_files", "search", "read_file", "read", "stat"])
    : c.allow;
  const ticked = new Set(proposed);

  const box = el("div", "conn-perms");
  box.appendChild(el("small", "conn-foot",
    "Inkju can use only what you tick here. Anything this connection adds later arrives switched off."));

  const known = new Set(c.allow);
  for (const t of c.tools) {
    const lab = el("label", "row conn-perm" + (t.write ? " write" : ""));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = ticked.has(t.name);
    input.dataset.tool = t.name;
    lab.appendChild(input);
    const txt = el("span");
    txt.appendChild(el("span", "perm-name", t.name));
    if (t.write) txt.appendChild(el("span", "perm-tag", "changes files"));
    if (!firstTime && !known.has(t.name) && c.tools.length) txt.appendChild(el("span", "perm-tag new", "new"));
    if (t.description) txt.appendChild(el("small", null, t.description));
    lab.appendChild(txt);
    box.appendChild(lab);
  }

  const r = await dialog({
    title: "What " + c.label + " may do",
    wide: true,
    fields: [
      { type: "node", node: box },
      { name: "confirmWrites", label: "Ask me before every change to this connection", type: "checkbox",
        value: c.confirmWrites }
    ],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Save", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") return;

  const allow = $$("input[data-tool]", box).filter(i => i.checked).map(i => i.dataset.tool);
  await api.connections.update(id, { allow, confirmWrites: r.confirmWrites });
  await refresh();
  paintList();
  toast(c.label + ": " + allow.length + " of " + c.tools.length + " tools allowed.");
}

/* ------------------------------------------------------------ adding one */

async function addConnectionFlow(){
  const choices = presets.map(p => ({
    value: "preset:" + p.id, label: p.label, detail: p.blurb, icon: "☁"
  })).concat([
    { value: "http", label: "Another MCP server", detail: "A server on the web that speaks MCP.", icon: "⚯" },
    { value: "stdio", label: "A program on this Mac", detail: "Run an MCP server locally and talk to it.", icon: "⌘" }
  ]);

  const r = await dialog({
    title: "Add a connection",
    message: "Inkju can open notes from anywhere that speaks MCP.",
    choices,
    buttons: [{ label: "Cancel", value: "cancel" }]
  });
  if (!r || r === "cancel" || r.action === "cancel") return;
  const pick = typeof r === "string" ? r : r.value;
  if (!pick) return;

  if (pick.startsWith("preset:")) return addPreset(presets.find(p => p.id === pick.slice(7)));
  if (pick === "http") return addHttp();
  if (pick === "stdio") return addStdio();
}

async function addPreset(preset){
  if (!preset) return;
  const setup = preset.setup || {};
  const intro = el("div", "conn-setup");
  intro.appendChild(el("strong", null, setup.heading || preset.label));
  if (setup.why) intro.appendChild(el("p", null, setup.why));
  if (setup.steps) {
    const ol = el("ol");
    setup.steps.forEach(step => ol.appendChild(el("li", null, step)));
    intro.appendChild(ol);
  }
  if (setup.link) {
    const a = el("a", "conn-link", setup.linkLabel || setup.link);
    a.href = "#";
    a.onclick = e => { e.preventDefault(); api.system.openExternal(setup.link); };
    intro.appendChild(a);
  }
  if (setup.caveat) intro.appendChild(el("small", "conn-caveat", setup.caveat));

  const r = await dialog({
    title: "Connect " + preset.label,
    wide: true,
    fields: [
      { type: "node", node: intro },
      { name: "label", label: "Name it", type: "text", value: preset.label },
      { name: "clientId", label: "OAuth client ID", type: "text", value: "" },
      { name: "clientSecret", label: "OAuth client secret", type: "password", value: "" }
    ],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Connect", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") return;

  /* Checked here rather than at the far end of an OAuth round trip that would
     fail with something from Google rather than something from us. */
  if (!String(r.clientId || "").trim()) {
    return say("Google needs the client ID from your own OAuth client. Follow the steps and paste it in.",
      "That connection needs a client ID");
  }

  let created;
  try {
    created = await api.connections.add({
      label: r.label || preset.label,
      transport: preset.transport,
      preset: preset.id,
      config: Object.assign({}, preset.config, { clientId: String(r.clientId).trim() })
    });
  } catch (err) { return say(err.message, "Could not add that connection"); }

  if (String(r.clientSecret || "").trim()) {
    const stored = await api.connections.setSecret(created.id, "client_secret", String(r.clientSecret).trim());
    if (stored.stored === "memory") {
      say("This system cannot store credentials securely, so the client secret is kept only until Inkju closes. You will need to enter it again next time.",
        "Stored for this session only");
    }
  }
  await refresh();
  const fresh = list.find(x => x.id === created.id);
  if (fresh) await runConnect(fresh, true);
}

async function addHttp(){
  const r = await dialog({
    title: "Add an MCP server",
    wide: true,
    fields: [
      { name: "label", label: "Name it", type: "text", value: "" },
      { name: "url", label: "Server address", type: "text", value: "https://",
        hint: "Must be https. Inkju will ask the server how to sign in." },
      { name: "clientId", label: "OAuth client ID (only if the server gave you one)", type: "text", value: "" },
      { name: "clientSecret", label: "OAuth client secret (optional)", type: "password", value: "" }
    ],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Add", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") return;
  let created;
  try {
    created = await api.connections.add({
      label: r.label || "MCP server",
      transport: "http",
      config: { url: String(r.url || "").trim(), clientId: String(r.clientId || "").trim() || null }
    });
  } catch (err) { return say(err.message, "Could not add that connection"); }
  if (String(r.clientSecret || "").trim()) {
    await api.connections.setSecret(created.id, "client_secret", String(r.clientSecret).trim());
  }
  await refresh();
  const fresh = list.find(x => x.id === created.id);
  if (fresh) await runConnect(fresh, false);
}

/* A local server is a program, with everything the user can do. The command is
   shown back verbatim before it runs, because agreeing to "add a connection"
   and agreeing to "run this on my Mac" are different things and only one of
   them is what is happening. Inkju installs nothing on anybody's behalf. */
async function addStdio(){
  const r = await dialog({
    title: "Run an MCP server on this Mac",
    wide: true,
    message: "Inkju will start this program and talk to it. It runs with everything you can do, so add one only if you know what it is.",
    fields: [
      { name: "label", label: "Name it", type: "text", value: "" },
      { name: "command", label: "Command", type: "text", value: "", hint: "The program to run, for example /usr/local/bin/node" },
      { name: "args", label: "Arguments", type: "text", value: "", hint: "Separated by spaces" }
    ],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Continue", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") return;

  const command = String(r.command || "").trim();
  const args = String(r.args || "").trim().split(/\s+/).filter(Boolean);
  if (!command) return say("A local connection needs a command to run.", "Nothing to run");

  /* The confirmation names the package rather than describing it, and it is a
     separate decision from filling the form in. */
  const shown = el("div", "conn-setup");
  shown.appendChild(el("p", null, "Inkju is about to run this every time the connection is switched on:"));
  shown.appendChild(el("pre", "conn-cmd", command + (args.length ? " " + args.join(" ") : "")));
  if (/^npx$/.test(command.split("/").pop()) && args.length) {
    const pkg = args.find(a => !a.startsWith("-"));
    shown.appendChild(el("small", "conn-caveat",
      "This downloads and runs the package “" + (pkg || "?") + "” from npm. Inkju does not check what is in it."));
  }
  const ok = await dialog({
    title: "Run this program?",
    wide: true,
    fields: [{ type: "node", node: shown }],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Run it", value: "ok", primary: true }]
  });
  if (!ok || ok.action !== "ok") return;

  let created;
  try {
    created = await api.connections.add({
      label: r.label || command.split("/").pop(),
      transport: "stdio",
      config: { command, args }
    });
  } catch (err) { return say(err.message, "Could not add that connection"); }
  await refresh();
  const fresh = list.find(x => x.id === created.id);
  if (fresh) await runConnect(fresh, false);
}

/* -------------------------------------------------------- the browser */

let browserRows = [];
let browserQuery = "";
let browserCaps = null;

export function startBrowsing(id){
  browsing = list.find(c => c.id === id) || null;
  if (!browsing) return;
  browserRows = [];
  browserQuery = "";
  document.body.classList.add("browsing-cloud");
  $$(".side-tabs button").forEach(b => b.classList.toggle("on", b.dataset.pane === "files"));
  $$(".side-pane").forEach(p => p.classList.toggle("on", p.id === "pane-files"));
  renderBrowser();
  loadBrowser();
}

export function stopBrowsing(){
  browsing = null;
  browserRows = [];
  browserCaps = null;
  document.body.classList.remove("browsing-cloud");
  const host = $("#cloud-browser");
  if (host) host.remove();
  $("#tree").hidden = false;
  $$("#pane-files .side-action").forEach(b => { b.hidden = false; });
}

function browserHost(){
  let host = $("#cloud-browser");
  if (!host) {
    host = el("div", null);
    host.id = "cloud-browser";
    $("#pane-files").insertBefore(host, $("#tree"));
  }
  $("#tree").hidden = true;
  $$("#pane-files .side-action").forEach(b => { b.hidden = true; });
  return host;
}

function renderBrowser(){
  if (!browsing) return;
  const host = browserHost();
  host.textContent = "";

  const head = el("div", "cloud-head");
  const back = el("button", "ghost", "‹ Vault");
  back.onclick = () => stopBrowsing();
  head.appendChild(back);
  head.appendChild(el("span", "cloud-name", browsing.label));
  host.appendChild(head);

  /* A connection that is not up shows why, and what to do, rather than an
     empty list that looks like an account with no files in it. */
  if (browsing.status !== "connected") {
    const box = el("div", "side-empty");
    box.appendChild(el("div", null, browsing.label + " is " + (STATUS_TEXT[browsing.status] || browsing.status) + "."));
    if (browsing.detail) box.appendChild(el("small", null, browsing.detail));
    const b = el("button", "side-action",
      browsing.status === "needs-authorization" ? "Sign in…" : "Connect");
    b.onclick = async () => {
      await runConnect(browsing, browsing.status === "needs-authorization");
      browsing = list.find(c => c.id === browsing.id) || browsing;
      renderBrowser();
      if (browsing.status === "connected") loadBrowser();
    };
    box.appendChild(b);
    host.appendChild(box);
    return;
  }

  const q = document.createElement("input");
  q.id = "cloud-q";
  q.placeholder = browserCaps && browserCaps.canSearch ? "Search " + browsing.label : "Filter these files";
  q.value = browserQuery;
  q.autocomplete = "off";
  q.spellcheck = false;
  let timer = null;
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { browserQuery = q.value; loadBrowser(); }, 220);
  };
  host.appendChild(q);

  const results = el("div", "cloud-results");
  host.appendChild(results);
  paintRows(results);
}

function paintRows(results){
  results.textContent = "";
  if (!browserRows.length) {
    results.appendChild(el("div", "side-empty",
      browserQuery ? "Nothing matched." : "No files here."));
    return;
  }
  for (const row of browserRows) {
    const b = el("button", "cloud-row" + (row.folder ? " folder" : ""));
    b.appendChild(el("span", "cloud-file", row.name));
    const meta = [];
    if (row.size) meta.push(fmtSize(row.size));
    if (row.modified) meta.push(fmtWhen(row.modified));
    if (meta.length) b.appendChild(el("small", null, meta.join(" · ")));
    b.onclick = () => (row.folder ? openFolder(row) : openRow(row));
    results.appendChild(b);
  }
}

function fmtSize(n){
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function fmtWhen(s){
  const d = new Date(s);
  if (isNaN(d)) return String(s).slice(0, 10);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

let folder = null;

async function loadBrowser(){
  if (!browsing || browsing.status !== "connected") return;
  const results = $(".cloud-results");
  if (results) results.textContent = "";
  try {
    browserCaps = await api.cloud.capabilities(browsing.id);
    if (!browserCaps.canList) {
      browserRows = [];
      if (results) {
        results.appendChild(el("div", "side-empty",
          "Inkju has not been allowed to list files on this connection."));
        const b = el("button", "side-action", "Permissions…");
        b.onclick = () => allowlistDialog(browsing.id);
        results.appendChild(b);
      }
      return;
    }
    browserRows = await api.cloud.list(browsing.id, { query: browserQuery, folder });
  } catch (err) {
    browserRows = [];
    if (results) results.appendChild(el("div", "side-empty", err.message));
    return;
  }
  if (results) paintRows(results);
  else renderBrowser();
}

function openFolder(row){
  folder = row.id;
  browserQuery = "";
  loadBrowser();
}

async function openRow(row){
  try {
    toast("Opening " + row.name + "…");
    const doc = await api.cloud.read(browsing.id, row.id, row);
    openRemote(Object.assign({}, doc, { label: browsing.label }));
  } catch (err) {
    /* Something we cannot put in the editor still has somewhere to go. */
    const r = await dialog({
      title: "Cannot open " + row.name,
      message: err.message,
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Save a copy to my vault", value: "import", primary: true }
      ]
    });
    if (r && r.action === "import") importRow(row);
  }
}

export async function importRow(row){
  try {
    const f = await api.cloud.import(browsing.id, row.id, row);
    toast("Saved " + f.name + " into your vault.");
    return f;
  } catch (err) { say(err.message, "Could not save that into your vault"); return null; }
}

/* The connection a remote document belongs to, for the tab's label. */
export function labelOf(id){
  const c = list.find(x => x.id === id);
  return c ? c.label : "a connection";
}
export function connectionOf(id){ return list.find(x => x.id === id) || null; }
