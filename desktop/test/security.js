"use strict";
/* Standing guarantees. Each of these is something that was true before this
   feature existed and has to stay true after it: the renderer is sandboxed, it
   never sees a credential, remote text is text, and a connection nobody turned
   on does nothing at all.

   They are deliberately structural — they read the source and the shapes rather
   than exercising a flow — because the point is to fail when someone loosens
   one of them by accident, in a change that has nothing to do with any of this.
*/
const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const src = f => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");

const connections = require("../src/main/connections");
const secrets = require("../src/main/secrets");
const mcp = require("../src/main/mcp-client");
const cloud = require("../src/main/cloud");

function fakeStore(){
  const state = { connections: [] };
  return { get: () => state, save: p => (Object.assign(state, p), state), _state: state };
}

/* Every credential-shaped thing this feature can hold. */
const LEAKS = [
  "ya29.aVeryRealAccessToken",
  "1//aVeryRealRefreshToken",
  "GOCSPX-aVeryRealClientSecret",
  "aVeryRealCodeVerifier",
  "aVeryRealAuthorizationCode"
];

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-sec-"));
  secrets.setBackend({
    isEncryptionAvailable: () => true,
    encrypt: async t => Buffer.from("v1:" + Buffer.from(t, "utf8").toString("hex")),
    decrypt: async b => Buffer.from(Buffer.from(b).toString("utf8").slice(3), "hex").toString("utf8")
  });
  secrets.setFile(path.join(dir, "secrets.json"));

  /* ------------------------------------------- the renderer's sandbox */

  await test("the renderer is still isolated and sandboxed", () => {
    const main = src("main/main.js");
    const window = main.slice(main.indexOf("function createWindow"), main.indexOf("win.loadFile"));
    assert.match(window, /contextIsolation:\s*true/, "contextIsolation was turned off");
    assert.match(window, /nodeIntegration:\s*false/, "nodeIntegration was turned on");
    assert.match(window, /sandbox:\s*true/, "the renderer sandbox was turned off");
  });

  await test("the renderer CSP was not relaxed for this feature", () => {
    const html = src("renderer/index.html");
    const m = /content="([^"]*)"/.exec(html.slice(html.indexOf("Content-Security-Policy")));
    const csp = m[1];
    assert.match(csp, /default-src 'none'/, "default-src is no longer 'none'");
    assert.match(csp, /script-src 'self'/, "script-src was widened");
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "inline script was allowed");
    assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), "eval was allowed");
    /* connect-src matters most here: the renderer must not be able to reach a
       connection itself. Everything outbound goes through the main process. */
    assert.match(csp, /connect-src 'self'/, "the renderer was given network access");
  });

  await test("the preload bridge exposes no way to read a credential", () => {
    const preload = src("preload/preload.js");
    const block = preload.slice(preload.indexOf("connections: {"), preload.indexOf("icloud: {"));
    for (const forbidden of ["token", "secretValue", "credential", "getSecret", "clientSecret"]) {
      assert.ok(!new RegExp("\\b" + forbidden + "\\b", "i").test(block),
        "the bridge exposes something credential-shaped: " + forbidden + "\n" + block);
    }
    /* setSecret is outward only — it takes a value, it does not return one */
    assert.match(block, /setSecret:\s*\(id, key, value\)/);
    assert.match(block, /secretKeys:\s*id\s*=>/, "the bridge should expose names, not values");
  });

  await test("the renderer never requires node, and the bridge is the only door", () => {
    const preload = src("preload/preload.js");
    assert.match(preload, /contextBridge\.exposeInMainWorld/);
    assert.ok(!/exposeInMainWorld\(\s*["']inkju["']\s*,\s*\{[\s\S]*ipcRenderer\s*[,}]/.test(preload),
      "ipcRenderer itself was exposed to the renderer");
  });

  /* ------------------------------------------------ credentials in IPC */

  await test("no connection payload carries a credential", async () => {
    connections.setStore(fakeStore());
    connections.resetLive();
    const c = connections.add({
      label: "Drive", transport: "http",
      config: {
        url: "https://drivemcp.googleapis.com/mcp/v1",
        clientId: "123.apps.googleusercontent.com",
        clientSecret: LEAKS[2], accessToken: LEAKS[0], refreshToken: LEAKS[1]
      }
    });
    await secrets.set(c.id, "access_token", LEAKS[0]);
    await secrets.set(c.id, "refresh_token", LEAKS[1]);
    await secrets.set(c.id, "client_secret", LEAKS[2]);
    await secrets.set(c.id, "code_verifier", LEAKS[3]);

    /* every shape the renderer can ask for */
    const payloads = [
      JSON.stringify(connections.list()),
      JSON.stringify(connections.get(c.id)),
      JSON.stringify(await secrets.keys(c.id)),
      JSON.stringify(connections.toolsOf(c.id)),
      JSON.stringify(connections.proposeAllow(c.id, ["search_files"]))
    ].join("\n");

    for (const leak of LEAKS) {
      assert.ok(!payloads.includes(leak), "a credential reached the renderer: " + leak);
    }
  });

  await test("error text is scrubbed of anything credential-shaped", () => {
    const dirty = [
      'POST /token failed: code_verifier=' + LEAKS[3],
      'header Authorization: Bearer ' + LEAKS[0],
      '{"access_token":"' + LEAKS[0] + '","refresh_token":"' + LEAKS[1] + '"}',
      'client_secret: ' + LEAKS[2]
    ].join(" | ");
    const clean = mcp.scrub(dirty);
    for (const leak of LEAKS.slice(0, 4)) {
      assert.ok(!clean.includes(leak), "scrub left a credential behind: " + leak + "\n" + clean);
    }
  });

  await test("secrets are never written where settings are", () => {
    /* the shape, not the prose: a comment may mention credentials, a settings
       key may not, and nothing may assign one into the settings store */
    /* store.js reaches for Electron on require, so the shape is read from the
       source rather than from the module */
    const text = src("main/store.js");
    const defaults = text.slice(text.indexOf("const DEFAULTS"), text.indexOf("let cache"));
    for (const key of (defaults.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm) || [])) {
      assert.ok(!/secret|token|password|credential|client_?id/i.test(key),
        "settings.json has grown a credential-shaped key: " + key.trim());
    }
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/(secret|token|password|credential)/i.test(code),
      "store.js handles something credential-shaped; that belongs in secrets.js");
    const secretsCode = src("main/secrets.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/settings\.json/.test(secretsCode), "secrets.js points at the settings file");
  });

  await test("only credentials Inkju recognises can be stored at all", () => {
    /* the IPC handler is an allowlist, so the renderer cannot invent a key and
       use the credential store as a general-purpose place to put things */
    const main = src("main/main.js");
    const handler = main.slice(main.indexOf('handle("connections:setSecret"'),
                               main.indexOf("async function secretsFor"));
    assert.match(handler, /allowed\s*=\s*\["client_id",\s*"client_secret"\]/);
    assert.match(handler, /\^env:/, "environment secrets should be name-checked");
  });

  /* -------------------------------------------------- remote content */

  await test("remote markdown with a script in it renders as text", () => {
    /* the same pipeline as a local note, which escapes rather than executes */
    const md = require("../src/renderer/js/markdown.js");
    const attacks = [
      "<script>window.stolen = 1</script>",
      "<img src=x onerror=\"window.stolen=1\">",
      "<div onclick='window.stolen=1'>click</div>",
      "<iframe src=\"https://evil.example\"></iframe>",
      "<svg><animate onbegin=window.stolen=1>"
    ];
    for (const attack of attacks) {
      /* renderUntrusted is the mode a remote document is shown in. Markdown
         passes raw HTML through on purpose, which is right for a note the user
         wrote and wrong for one that arrived from someone else's store. */
      const html = md.renderUntrusted([attack]);
      /* the whole point is that nothing became an element. Once the paragraph
         wrapper is taken off, an angle bracket left standing means a tag got
         through — checking for "onerror=" would not do, because the escaped
         text legitimately still contains those characters as text. */
      const inner = html.replace(/^<p>/, "").replace(/<\/p>$/, "");
      assert.ok(!inner.includes("<"), "raw html survived: " + attack + "\n" + html);
      assert.ok(inner.includes("&lt;"), "the markup was dropped rather than shown: " + attack + "\n" + html);
    }
    /* a note the user wrote themselves keeps its HTML: this is a markdown
       feature, and remote documents are the exception rather than the rule */
    assert.match(md.renderDoc(["<div class=\"mine\">hello</div>"]), /<div class="mine">/);
  });

  await test("trust is a property of the document, not of the call site", () => {
    /* The regression this exists for: renderUntrusted() was written, exported
       and tested, and never called by the app. Remote documents went through
       the ordinary renderer and the raw HTML in them reached the DOM, while a
       test asserting the helper in isolation passed and made it look covered.

       So: assert the *sinks* honour the flag, and that the flag is set where
       documents are loaded — not that a helper nobody calls behaves. */
    const md = require("../src/renderer/js/markdown.js");
    const nasty = "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">";

    md.setUntrusted(true);
    try {
      /* every renderer, not just the one someone remembered */
      for (const render of [
        () => md.renderBlock(nasty),
        () => md.renderDoc([nasty]),
        () => md.renderUntrusted([nasty])
      ]) {
        const html = render();
        assert.ok(!/<meta/i.test(html), "a sink ignored the document's trust: " + html);
      }
    } finally { md.setUntrusted(false); }

    /* and a note of the user's own keeps its HTML */
    assert.match(md.renderBlock("<div class=\"mine\">hello</div>"), /<div class="mine">/);
  });

  await test("loading a document is what decides its trust", () => {
    /* Structural: the one place every document passes through on its way to
       being the open one has to be the place trust is set. If this moves,
       a renderer added later inherits the hole. */
    const editor = src("renderer/js/editor.js");
    const load = editor.slice(editor.indexOf("export function loadText"),
                              editor.indexOf("export function loadText") + 1200);
    assert.match(load, /setUntrusted\(!!state\.remote\)/,
      "loadText no longer decides trust; remote documents will render as trusted");
    assert.match(editor, /import \{[^}]*setUntrusted/, "editor.js does not import setUntrusted");
  });

  await test("the untrusted flag cannot leak into the next render", () => {
    const md = require("../src/renderer/js/markdown.js");
    md.renderUntrusted(["<div>remote</div>"]);
    assert.match(md.renderDoc(["<div>local</div>"]), /<div>local<\/div>/,
      "a remote render left every later document escaped");
    /* and it survives a render that throws */
    try { md.renderUntrusted(null); } catch (err) { /* whatever it does */ }
    assert.match(md.renderDoc(["<div>local</div>"]), /<div>local<\/div>/,
      "a failed remote render left the flag set");
  });

  await test("a link scheme that would run code is neutralised", () => {
    const md = require("../src/renderer/js/markdown.js");
    const attacks = [
      "[x](javascript:window.stolen=1)",
      "[x](JaVaScRiPt:window.stolen=1)",
      "[x](vbscript:msgbox)",
      "[x](data:text/html;base64,PHNjcmlwdD4=)",
      "![i](data:text/html;base64,PHNjcmlwdD4=)",
      "![i](javascript:window.stolen=1)"
    ];
    for (const attack of attacks) {
      const html = md.renderDoc([attack]);
      assert.ok(!/(href|src)\s*=\s*["'](\s|&#\d+;)*(javascript|vbscript|data:text)/i.test(html),
        "a scripting URL survived: " + attack + "\n" + html);
    }
    /* and the ordinary cases still work */
    assert.match(md.renderDoc(["[x](https://example.com)"]), /href="https:\/\/example\.com"/);
    assert.match(md.renderDoc(["[x](./notes/a.md)"]), /href="\.\/notes\/a\.md"/);
    assert.match(md.renderDoc(["![i](data:image/png;base64,AAAA)"]), /src="data:image\/png;base64,AAAA"/);
  });

  await test("a note cannot make the app open an arbitrary scheme", () => {
    /* will-navigate used to hand anything that was not file:// to the OS. With
       notes arriving from someone else's store, that is a note choosing which
       application to launch. */
    const main = src("main/main.js");
    const nav = main.slice(main.indexOf('on("will-navigate"'), main.indexOf('on("will-navigate"') + 700);
    assert.match(nav, /https\?:/, "will-navigate no longer restricts the scheme");
    assert.ok(!/if \(!url\.startsWith\("file:\/\/"\)\) \{ e\.preventDefault\(\); shell\.openExternal\(url\); \}/.test(main),
      "will-navigate opens any scheme externally again");
    const open = main.slice(main.indexOf('handle("shell:open"'), main.indexOf('handle("shell:open"') + 300);
    assert.match(open, /\^https\?:/, "shell:open no longer restricts the scheme");
  });

  await test("a remote reply too large to be a note is refused", () => {
    const huge = { content: [{ type: "text", text: "x".repeat(mcp.MAX_RESULT_BYTES + 1024) }] };
    assert.throws(() => mcp.checkSize(huge), /larger than Inkju will accept/i);
    assert.strictEqual(cloud.MAX_REMOTE_BYTES <= mcp.MAX_RESULT_BYTES, true,
      "the editor's remote limit should sit inside the transport's");
  });

  await test("nothing hands remote content to a shell or a model", () => {
    for (const file of ["main/cloud.js", "main/mcp-client.js"]) {
      const text = src(file);
      assert.ok(!/\beval\s*\(/.test(text), file + " calls eval");
      assert.ok(!/new Function\s*\(/.test(text), file + " builds a function from text");
      assert.ok(!/(?<![.\w])exec\s*\(/.test(text), file + " runs a shell");
      assert.ok(!/openExternal/.test(text), file + " can open a URL from a connection");
    }
  });

  await test("the download that fetches an iCloud file never goes through a shell", () => {
    const text = src("main/icloud.js");
    /* RegExp.prototype.exec is not a shell; child_process.exec is */
    assert.ok(!/(?<![.\w])exec\s*\(/.test(text), "icloud.js uses exec; a filename would be shell input");
    assert.match(text, /execFile\(/, "expected execFile with an argument list");
  });

  /* ------------------------------------------------------ path safety */

  await test("a remote filename cannot escape the folder it is imported into", () => {
    const attacks = [
      "../../.ssh/authorized_keys",
      "../../../etc/passwd",
      "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
      "/etc/passwd",
      "....//....//etc/shadow",
      ".ssh/config",
      "~/.bashrc"
    ];
    for (const attack of attacks) {
      const safe = cloud.safeName(attack);
      assert.ok(!safe.includes("/") && !safe.includes("\\"), attack + " -> " + safe);
      assert.ok(!safe.includes(".."), attack + " -> " + safe);
      assert.ok(!safe.startsWith("."), attack + " -> " + safe);
      assert.strictEqual(path.basename(safe), safe, attack + " -> " + safe);
    }
  });

  /* ------------------------------------------------ opt-in networking */

  await test("a disabled connection can do nothing at all", async () => {
    connections.setStore(fakeStore());
    connections.resetLive();
    const c = connections.add({ label: "x", transport: "http", config: { url: "https://mcp.example.com/mcp" } });
    connections.setTools(c.id, [{ name: "search_files" }, { name: "read_file_content" }]);
    connections.update(c.id, { allow: ["search_files", "read_file_content"] });
    connections.update(c.id, { enabled: false });

    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false);
    assert.strictEqual(connections.isAllowed(c.id, "read_file_content"), false);
    await assert.rejects(() => mcp.connect(c.id), /turned off/i);
    await assert.rejects(() => mcp.callTool(c.id, "search_files", {}), /not allowed/i);
  });

  await test("every connection surface is behind the flag", () => {
    const main = src("main/main.js");
    const block = main.slice(main.indexOf("/* ------------------------------------------------------------ connections */"),
                             main.indexOf('handle("theme:system"'));
    const handlers = block.match(/handle\("connections:[^"]+"/g) || [];
    assert.ok(handlers.length >= 10, "expected the connection handlers, found " + handlers.length);
    /* every one either requires the flag or reads it */
    const bodies = block.split(/handle\("connections:/).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf('"'));
      if (name === "enabled") continue;                    // the flag itself
      const head = body.slice(0, 400);
      assert.ok(/requireConnections\(\)|connectionsEnabled/.test(head),
        "connections:" + name + " is not gated on the flag");
    }
  });

  await test("nothing outbound happens without a connection record", () => {
    /* connect() is reached only through a record, and a record only exists
       because someone added one. There is no default, no bundled server and no
       list of servers to try. */
    connections.setStore(fakeStore());
    connections.resetLive();
    assert.deepStrictEqual(connections.list(), []);
    const main = src("main/main.js");
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      main.slice(main.indexOf("/* ------------------------------------------------------------ connections */"),
                 main.indexOf('handle("theme:system"'))),
      "a server address is hard-coded into the connection handlers");
  });

  await fsp.rm(dir, { recursive: true, force: true });
};
