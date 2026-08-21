/* Runs inside the renderer. Returns a report object to the main process. */
(async () => {
  const failures = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let ran = 0;
  const check = (name, cond, extra) => {
    ran++;
    if (!cond) failures.push(name + (extra ? " — " + extra : ""));
  };
  const $ = s => document.querySelector(s);

  // give boot() a moment to finish its awaits
  await new Promise(r => setTimeout(r, 2600));  // mermaid loads its chunks lazily

  const mod = await import("./js/editor.js");
  const md  = await import("./js/markdown.js");
  const { state } = mod;

  check("bridge exposed", !!window.inkwell && window.inkwell.isDesktop);
  check("dropped-file paths readable in sandbox", window.inkwell.canReadDroppedPaths === true);
  check("no node in renderer", typeof require === "undefined" && typeof process === "undefined");
  check("document loaded", state.blocks.length > 1, "blocks=" + state.blocks.length);
  check("paper rendered", $("#paper").children.length > 1);
  check("status filled", $("#st-words").textContent !== "0");
  check("outline built", document.querySelectorAll(".toc-item").length > 0);
  /* render a fixture rather than assuming which document the session restored */
  const probe = document.createElement("div");
  probe.innerHTML = md.renderDoc([
    "# Fixture", "", "Inline $e^{i\\pi}+1=0$ math.", "",
    "- [x] done", "- [ ] todo", "",
    "```mermaid", "graph TD", "  A[One] --> B[Two]", "```", "",
    "| a | b |", "| --- | --- |", "| 1 | 2 |"
  ].join("\n"));
  /* maths is KaTeX on the desktop and MathML in the single-file build */
  check("math rendered", probe.querySelectorAll("math, .katex").length > 0);
  /* diagrams are hosts that hydrate asynchronously, so bake them to check */
  const Rich = await import("./js/rich.js");
  const baked = await Rich.bake(probe.innerHTML);
  check("diagram rendered", baked.includes("<svg"), baked.includes("diagram-error") ? "mermaid reported a syntax error" : "no svg produced");
  check("real mermaid in use", Rich.diagramsReady());
  check("real katex in use", Rich.mathReady());
  check("tasks rendered", probe.querySelectorAll("li.task").length > 0);
  check("tables rendered", probe.querySelectorAll("table th").length === 2);
  check("dialog mounted", !!$("#modal"));
  check("tabs present", !!$("#tabs"));
  check("theme applied", !!document.documentElement.dataset.theme);

  // editing still works end to end
  mod.loadText("alpha beta\n\n- one", "Smoke.md");
  mod.activate(state.blocks[0].id, 5);
  const ta = document.querySelector(".block.active .src");
  check("block opened its source", !!ta && ta.value === "alpha beta",
        ta ? JSON.stringify(ta.value) : "no active textarea");
  {
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    check("Enter split the block", state.blocks.length === 3, "blocks=" + state.blocks.length);
    const t2 = document.querySelector(".block.active .src");
    t2.dispatchEvent(new KeyboardEvent("keydown", { key: "(", bubbles: true, cancelable: true }));
    check("auto-pair fired", t2.value.includes("()"), JSON.stringify(t2.value));
  }
  mod.commit();

  // main-process round trip through the bridge
  let settings = null;
  try { settings = await window.inkwell.settings.get(); } catch (e) {}
  check("IPC round trip", !!settings && typeof settings.theme === "string");

  let css = "";
  try { css = await window.inkwell.assets.css(); } catch (e) {}
  check("export stylesheet readable", css.length > 1000, "len=" + css.length);

  /* ---- rich text mode: the default view, and its three menus ---- */
  const R = await import("./js/rich-editor.js");

  check("boots into styled mode", !document.body.classList.contains("mode-rich")
        && !document.body.classList.contains("mode-split")
        && !document.body.classList.contains("mode-source"), document.body.className);
  check("the styled button reads as active", document.querySelector("#btn-styled").classList.contains("on"));
  check("booting does not dirty the document", state.dirty === false, "dirty=" + state.dirty);

  /* switch to rich text the way a person would, then wait for the bundle */
  document.querySelector("#btn-rich").click();
  for (let i = 0; i < 40 && !R.isReady(); i++) await wait(100);
  check("the rich text button opens the editor", R.isReady(), "rich editor not running");
  check("body carries the rich mode class", document.body.classList.contains("mode-rich"));
  check("only the rich button is active", document.querySelector("#btn-rich").classList.contains("on")
        && !document.querySelector("#btn-styled").classList.contains("on"));
  check("formatting lives in the menus, not the toolbar",
        !document.querySelector("#btn-bold") && !document.querySelector("#btn-italic") && !document.querySelector("#btn-link"));

  check("rich editor is available to test", R.isReady());
  {
    const tt = R.instance();
    tt.chain().focus().setTextSelection(tt.state.doc.content.size - 1).splitBlock().run();
    /* poll rather than guess: a cold packaged start is slower than the dev one,
       and a fixed wait made this check flaky */
    for (let i = 0; i < 25 && !R.floatingMenuVisible(); i++) await wait(60);
    check("floating menu shows on an empty line", R.floatingMenuVisible());

    tt.chain().focus().insertContent("/tab").run();
    for (let i = 0; i < 25 && !R.slashMenuVisible(); i++) await wait(60);
    check("slash menu opens and filters", R.slashMenuVisible()
      && document.querySelectorAll("#rich-slash .si").length === 1,
      document.querySelectorAll("#rich-slash .si").length + " items");

    const view = tt.view;
    const consumed = view.someProp("handleKeyDown", f =>
      f(view, new KeyboardEvent("keydown", { key: "Escape" })));
    check("slash menu owns its keys", consumed === true);
    await wait(160);

    /* the round trip is the promise that matters: markdown in, markdown out */
    R.setMarkdown("## Round trip\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    await wait(320);
    const back = R.getMarkdown() || "";
    check("round trip keeps headings, tasks and tables",
      /^## Round trip$/m.test(back) && /^- \[x\] done$/m.test(back) && back.includes("| A | B |"),
      JSON.stringify(back.slice(0, 90)));
  }

  /* ---- the vault bar ----------------------------------------------------- */
  const Vault = await import("./js/vault.js");
  const bar = $("#vault-bar"), ctx = $("#ctx");
  check("the sidebar leads with a vault bar", !!bar);
  check("the vault bar sits above the panes and the tree",
    !!bar && !!(bar.compareDocumentPosition($("#tree")) & Node.DOCUMENT_POSITION_FOLLOWING));
  check("with no vault it invites you to open one",
    $("#vault-name").textContent === "No vault" && /open a folder/i.test($("#vault-sub").textContent));

  const fixture = globalThis.__smokeVault;
  check("fixture vault was built", !!fixture);
  /* a throw in here used to abort the whole run and report nothing, so the
     block records its own failure and lets the rest of the suite finish */
  if (fixture) try {
    const name = fixture.split("/").pop();
    await Vault.restoreVault(fixture);
    check("the bar names the open vault", $("#vault-name").textContent === name,
      JSON.stringify($("#vault-name").textContent));
    check("the bar counts what is in it", /2 notes/.test($("#vault-sub").textContent),
      JSON.stringify($("#vault-sub").textContent));
    check("the tree drew the vault", document.querySelectorAll(".tree-item").length >= 2);

    Vault.vaultMenu(bar);
    check("the bar opens a menu", ctx.classList.contains("on") && ctx.classList.contains("anchored"));
    const labels = Array.from(ctx.querySelectorAll("button")).map(b => b.textContent);
    check("the menu carries the vault actions",
      labels.some(l => /^Rename vault/.test(l)) && labels.some(l => /^Close vault$/.test(l))
      && labels.some(l => /different vault/.test(l)) && labels.some(l => /^Copy path$/.test(l)),
      JSON.stringify(labels));
    /* long paths are trimmed from the left, so compare against that, and check
       the trimming separately rather than letting it hide a wrong path */
    const caption = ctx.querySelector(".ctx-head small");
    check("the menu shows which vault it acts on",
      !!caption && caption.textContent === Vault.shortPath(fixture),
      caption && JSON.stringify(caption.textContent));
    check("a trimmed path keeps its tail and marks the cut",
      Vault.shortPath("/Users/someone/Documents/Notes/A Vault With A Long Name")
        === "\u2026/Documents/Notes/A Vault With A Long Name",
      JSON.stringify(Vault.shortPath("/Users/someone/Documents/Notes/A Vault With A Long Name")));
    check("a short path is left alone", Vault.shortPath("/tmp/v") === "/tmp/v");
    check("the open menu marks the bar", bar.classList.contains("open")
      && bar.getAttribute("aria-expanded") === "true");
    Vault.vaultMenu(bar);
    check("clicking the bar again closes the menu",
      !ctx.classList.contains("on") && !bar.classList.contains("open"));

    /* rename through the real IPC, then put it back so the run repeats */
    const renamed = await window.inkwell.vault.rename(fixture, "Smoke Renamed");
    check("renaming moves the folder itself",
      renamed.root.endsWith("Smoke Renamed") && renamed.from === fixture, JSON.stringify(renamed.root));
    check("the notes come with it", renamed.tree.length === 2, "tree=" + renamed.tree.length);
    const readBack = await window.inkwell.file.read(renamed.root + "/Alpha.md");
    check("a note inside is readable at its new path", readBack.text.includes("# Alpha"));
    const back = await window.inkwell.vault.rename(renamed.root, name);
    check("renaming back restores the path", back.root === fixture);

    await window.inkwell.vault.close();
    check("closing a vault leaves the files alone",
      (await window.inkwell.file.read(fixture + "/Alpha.md")).text.includes("# Alpha"));
  } catch (err) {
    check("the vault checks ran without throwing", false, err.message);
  }

  /* ---- the update notice -------------------------------------------------
     Only under INKWELL_FAKE_UPDATE, which stands in for a newer release so the
     whole flow is exercisable without publishing one. */
  const fake = globalThis.__fakeUpdate;
  check("update flow is exercisable", typeof fake !== "undefined");
  if (fake) try {
    const card = $("#updater"), chip = $("#st-update");
    /* nothing below clicked anything: the card is expected to have shown itself
       during boot, which is the whole point */
    check("the update card shows itself on open", !card.hidden);
    check("the card names the new version", $("#up-title").textContent.includes(fake),
      JSON.stringify($("#up-title").textContent));
    check("no marker while the card is up", chip.hidden);

    $("#up-close").click();
    check("dismissing puts the card away", card.hidden);
    check("dismissing leaves a marker instead of forgetting",
      !chip.hidden && chip.textContent === "Update to " + fake, JSON.stringify(chip.textContent));

    chip.click();
    check("the marker brings the card back", !card.hidden && chip.hidden);
    $("#up-close").click();
  } catch (err) {
    check("the update checks ran without throwing", false, err.message);
  }

  return {
    failures,
    checks: ran - failures.length,
    ran,
    blocks: state.blocks.length,
    theme: document.documentElement.dataset.theme,
    platform: window.inkwell.platform
  };
})()
