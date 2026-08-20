/* Runs inside the renderer. Returns a report object to the main process. */
(async () => {
  const failures = [];
  const check = (name, cond, extra) => { if (!cond) failures.push(name + (extra ? " — " + extra : "")); };
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
  check("block opened its source", !!ta && ta.value === "alpha beta");
  if (ta) {
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

  return {
    failures,
    checks: 21 - failures.length,
    blocks: state.blocks.length,
    theme: document.documentElement.dataset.theme,
    platform: window.inkwell.platform
  };
})()
