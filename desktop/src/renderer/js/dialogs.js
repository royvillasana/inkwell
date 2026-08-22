/* ===========================================================================
   In-app dialogs. Nothing in Inkju calls window.confirm, alert or prompt.
   dialog() resolves with the chosen button value, or the field values when
   the dialog has fields.
   =========================================================================== */
import { esc } from "./markdown.js";

/* ===========================================================================
   4. IN-APP DIALOGS  (no window.confirm / alert / prompt anywhere)
   =========================================================================== */
const modal = {
  root: null,
  sheet: null, title: null, content: null, actions: null,
  resolve: null,
  lastFocus: null
};

export function closeModal(value){
  if (!modal.resolve) return;
  const done = modal.resolve;
  modal.resolve = null;
  modal.root.classList.remove("on");
  modal.content.textContent = "";
  modal.actions.textContent = "";
  if (modal.lastFocus && document.contains(modal.lastFocus)) {
    try { modal.lastFocus.focus(); } catch (e) {}
  }
  done(value);
}

/* dialog({title, message, fields, buttons, choices, wide, cancelValue}) -> Promise */
export function dialog(opt){
  if (modal.resolve) closeModal(opt.cancelValue === undefined ? null : opt.cancelValue);
  modal.lastFocus = document.activeElement;
  modal.sheet.classList.toggle("wide", !!opt.wide);
  modal.title.textContent = opt.title || "";
  modal.title.style.display = opt.title ? "" : "none";
  modal.content.textContent = "";
  modal.actions.textContent = "";

  if (opt.message) {
    const p = document.createElement("div");
    p.className = "msg";
    p.textContent = opt.message;
    modal.content.appendChild(p);
  }

  const inputs = {};

  if (opt.choices) {
    const wrap = document.createElement("div");
    wrap.className = "choices list-scroll";
    opt.choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "choice" + (i === 0 ? " sel" : "");
      b.innerHTML = '<span class="ico">' + (c.icon || "•") + "</span>";
      const t = document.createElement("span");
      t.className = "txt";
      t.appendChild(Object.assign(document.createElement("span"), { textContent: c.label }));
      if (c.detail) t.appendChild(Object.assign(document.createElement("small"), { textContent: c.detail }));
      b.appendChild(t);
      b.onclick = () => closeModal(c.value);
      wrap.appendChild(b);
    });
    modal.content.appendChild(wrap);
  }

  if (opt.fields) {
    const wrap = document.createElement("div");
    wrap.className = "fields";
    for (const f of opt.fields) {
      const lab = document.createElement("label");
      if (f.type === "checkbox" || f.type === "range") lab.className = "row";
      const span = document.createElement("span");
      span.textContent = f.label;
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        (f.options || []).forEach(o => {
          const op = document.createElement("option");
          op.value = o.value; op.textContent = o.label;
          if (String(o.value) === String(f.value)) op.selected = true;
          input.appendChild(op);
        });
      } else if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.value = f.value || "";
        input.spellcheck = false;
      } else {
        input = document.createElement("input");
        input.type = f.type || "text";
        if (f.type === "checkbox") input.checked = !!f.value;
        else input.value = f.value == null ? "" : f.value;
        if (f.min != null) input.min = f.min;
        if (f.max != null) input.max = f.max;
        if (f.step != null) input.step = f.step;
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      inputs[f.name] = input;
      if (f.type === "checkbox") { lab.appendChild(input); lab.appendChild(span); }
      else if (f.type === "range") {
        const out = document.createElement("span");
        out.className = "hint";
        out.textContent = f.value + (f.unit || "");
        input.oninput = () => { out.textContent = input.value + (f.unit || ""); if (f.live) f.live(input.value); };
        lab.appendChild(span); lab.appendChild(input); lab.appendChild(out);
      } else { lab.appendChild(span); lab.appendChild(input); }
      if (f.hint) {
        const h = document.createElement("span");
        h.className = "hint"; h.textContent = f.hint;
        lab.appendChild(h);
      }
      wrap.appendChild(lab);
    }
    modal.content.appendChild(wrap);
  }

  const readValues = () => {
    const v = {};
    for (const k in inputs) v[k] = inputs[k].type === "checkbox" ? inputs[k].checked : inputs[k].value;
    return v;
  };

  (opt.buttons || []).forEach(b => {
    if (b.spacer) { modal.actions.appendChild(Object.assign(document.createElement("span"), { className: "spacer" })); return; }
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.primary) el.className = "primary";
    if (b.danger) el.className = "danger";
    el.onclick = () => closeModal(opt.fields && b.value !== "cancel" && b.value != null
      ? Object.assign({ action: b.value }, readValues())
      : b.value);
    modal.actions.appendChild(el);
  });

  modal.root.classList.add("on");
  const first = Object.values(inputs)[0] || modal.actions.querySelector(".primary") || modal.content.querySelector(".choice");
  if (first) { first.focus(); if (first.select) first.select(); }

  return new Promise(res => { modal.resolve = res; });
}

export function mountDialogs(){
  modal.root = document.getElementById("modal");
  modal.sheet = document.querySelector("#modal .sheet");
  modal.title = document.getElementById("modal-title");
  modal.content = document.getElementById("modal-content");
  modal.actions = document.getElementById("modal-actions");

modal.root.addEventListener("mousedown", e => {
  if (e.target === modal.root) closeModal(null);
});
modal.root.addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(null); return; }
  if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
    const p = modal.actions.querySelector(".primary");
    if (p) { e.preventDefault(); p.click(); }
  }
  if (modal.content.querySelector(".choice") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const list = Array.from(modal.content.querySelectorAll(".choice"));
    let i = list.findIndex(x => x.classList.contains("sel"));
    i = Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    list.forEach(x => x.classList.remove("sel"));
    list[i].classList.add("sel");
    list[i].focus();
  }
});
}

/* --- the three replacements for the browser primitives ------------------- */
export const say = (message, title) => dialog({
  title: title || "Inkju", message,
  buttons: [{ label: "OK", value: true, primary: true }]
});

export const ask = (message, opt = {}) => dialog({
  title: opt.title || "Are you sure?", message,
  buttons: [
    { label: opt.cancel || "Cancel", value: false },
    { label: opt.ok || "Continue", value: true, primary: !opt.danger, danger: opt.danger }
  ]
}).then(v => v === true);

export const askText = (message, value, opt = {}) => dialog({
  title: opt.title || "Inkju", message,
  fields: [{ name: "value", label: opt.label || "", value: value || "", placeholder: opt.placeholder }],
  buttons: [{ label: "Cancel", value: "cancel" }, { label: opt.ok || "OK", value: "ok", primary: true }]
}).then(r => (r && r.action === "ok" ? r.value : null));
