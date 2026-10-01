// A small stand-in for the `obsidian` module, just enough to run Download Pulse in a browser page.
// Used by the harness (npm run harness) for development and screenshots — never shipped.

// ---------- DOM helpers Obsidian adds to every node ----------
function applyOpts(el, o) {
  if (o == null) return;
  if (typeof o === "string") { el.className = o; return; }
  if (o.cls) el.classList.add(...[].concat(o.cls).flatMap((c) => c.split(/\s+/)).filter(Boolean));
  if (o.text != null) el.textContent = typeof o.text === "string" ? o.text : "";
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  for (const k of ["type", "placeholder", "value", "title", "href"]) if (o[k] != null) el[k] = o[k];
}
const P = Node.prototype;
P.createEl = function (tag, o, cb) { const el = document.createElement(tag); applyOpts(el, o); this.appendChild(el); cb?.(el); return el; };
P.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
P.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
P.createSvg = function (tag, o, cb) { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); applyOpts(el, o); this.appendChild(el); cb?.(el); return el; };
P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
P.setText = function (t) { this.textContent = t; };
P.appendText = function (t) { this.appendChild(document.createTextNode(t)); };
const E = Element.prototype;
E.addClass = function (...c) { this.classList.add(...c); };
E.removeClass = function (...c) { this.classList.remove(...c); };
E.toggleClass = function (c, v) { [].concat(c).forEach((x) => this.classList.toggle(x, v)); };
E.hasClass = function (c) { return this.classList.contains(c); };
E.setAttr = function (k, v) { if (v == null) this.removeAttribute(k); else this.setAttribute(k, String(v)); };
E.setCssProps = function (p) { for (const [k, v] of Object.entries(p)) this.style.setProperty(k, v); };
E.setCssStyles = function (p) { Object.assign(this.style, p); };
E.show = function () { this.style.display = ""; };
E.hide = function () { this.style.display = "none"; };
Object.defineProperty(Node.prototype, "win", { get() { return window; } });
Object.defineProperty(Node.prototype, "doc", { get() { return document; } });
window.activeDocument = document;
window.activeWindow = window;
window.createSvg = (tag, o, cb) => { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); applyOpts(el, o); cb?.(el); return el; };
window.createEl = (tag, o, cb) => { const el = document.createElement(tag); applyOpts(el, o); cb?.(el); return el; };
window.createDiv = (o, cb) => { const el = document.createElement("div"); applyOpts(el, o); cb?.(el); return el; };

// ---------- icons ----------
const ICONS = {
  "refresh-cw": "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  sparkles: "M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  plus: "M12 5v14M5 12h14", x: "M18 6 6 18M6 6l12 12", trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  "arrow-up": "M12 19V5M5 12l7-7 7 7", activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  "layout-dashboard": "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
};
export function setIcon(el, name) {
  el.empty();
  const svg = el.createSvg("svg", { attr: { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } });
  svg.createSvg("path", { attr: { d: ICONS[name] ?? "M4 12h16" } });
}

// ---------- core ----------
export class Events {
  constructor() { this._ev = {}; }
  on(name, fn) { (this._ev[name] ??= []).push(fn); return { e: this, name, fn }; }
  off(name, fn) { this._ev[name] = (this._ev[name] ?? []).filter((f) => f !== fn); }
  offref(ref) { ref.e.off(ref.name, ref.fn); }
  trigger(name, ...a) { for (const f of [...(this._ev[name] ?? [])]) f(...a); }
}
export class Component {
  constructor() { this._cleanup = []; this._children = []; }
  load() { this.onload?.(); }
  unload() { this._children.forEach((c) => c.unload()); this._cleanup.forEach((f) => f()); this._cleanup = []; this.onunload?.(); }
  addChild(c) { this._children.push(c); c.load(); return c; }
  register(f) { this._cleanup.push(f); }
  registerEvent(ref) { this._cleanup.push(() => ref.e.offref(ref)); }
  registerInterval(id) { this._cleanup.push(() => clearInterval(id)); return id; }
  registerDomEvent(el, type, fn) { el.addEventListener(type, fn); this._cleanup.push(() => el.removeEventListener(type, fn)); }
}
export class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
export const Platform = { isMobile: false, isDesktop: true };
export const normalizePath = (p) => p;
export const requireApiVersion = () => true;
export const getLanguage = () => new URLSearchParams(location.search).get("lang") || "en";
export function prepareFuzzySearch(q) {
  const needle = q.toLowerCase();
  return (text) => {
    const h = text.toLowerCase(), i = h.indexOf(needle);
    if (i >= 0) return { score: -i / 100 + (i === 0 ? 1 : 0), matches: [] };
    let k = 0; for (const c of h) if (c === needle[k]) k++;
    return k === needle.length ? { score: -1, matches: [] } : null;
  };
}
export async function requestUrl(req) {
  const r = typeof req === "string" ? { url: req } : req;
  const res = await fetch(r.url, { headers: r.headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (r.throw !== false && !res.ok) throw new Error(String(res.status));
  return { status: res.status, text, json, headers: {} };
}

export class Notice {
  constructor(msg, timeout = 4000) {
    this.el = document.getElementById("notices").createDiv({ cls: "notice", text: msg });
    if (timeout) setTimeout(() => this.hide(), timeout);
  }
  setMessage(m) { this.el.setText(m); return this; }
  hide() { this.el.remove(); }
}

// ---------- workspace ----------
const views = {};
class WorkspaceLeaf {
  constructor(app, host) { this.app = app; this.host = host; this.view = null; }
  async setViewState({ type, state }) {
    if (this.view?.getViewType() === type) { await this.view.setState?.(state ?? {}, {}); return; }
    if (this.view) { await this.view.onClose(); this.view.unload(); }
    this.host.empty();
    this.view = views[type](this);
    this.host.appendChild(this.view.containerEl);
    this.view.containerEl.dataset.type = type;
    await this.view.onOpen();
    this.view.load();
    if (state) await this.view.setState?.(state, {});
  }
}
class Workspace extends Events {
  constructor(app) { super(); this.app = app; this.leaves = []; }
  leaf(host) { const l = new WorkspaceLeaf(this.app, host); this.leaves.push(l); return l; }
  getLeavesOfType(type) { return this.leaves.filter((l) => l.view?.getViewType() === type); }
  getLeaf() { return this.leaves.find((l) => l.host.id === "main") ?? this.leaf(document.getElementById("main")); }
  getRightLeaf() { return this.leaves.find((l) => l.host.id === "side") ?? this.leaf(document.getElementById("side")); }
  async revealLeaf() {}
  onLayoutReady(cb) { setTimeout(cb, 0); }
}
export class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf; this.app = leaf.app;
    this.containerEl = createDiv({ cls: "workspace-leaf-content" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
  async setState() {}
  getState() { return {}; }
  async onOpen() {}
  async onClose() {}
}

// ---------- modals ----------
export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = createDiv({ cls: "modal-container" });
    this.containerEl.createDiv({ cls: "modal-bg" }).addEventListener("click", () => this.close());
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open() { document.body.appendChild(this.containerEl); this.onOpen?.(); }
  close() { this.containerEl.remove(); this.onClose?.(); }
}
export class SuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.modalEl.addClass("prompt");
    this.inputEl = this.modalEl.createEl("input", { cls: "prompt-input", type: "text" });
    this.modalEl.insertBefore(this.inputEl, this.titleEl);
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    this.emptyStateText = "No results"; this.limit = 50;
    this.inputEl.addEventListener("input", () => this.update());
  }
  setPlaceholder(p) { this.inputEl.placeholder = p; }
  open() { super.open(); this.update(); this.inputEl.focus(); }
  async update() {
    const items = await this.getSuggestions(this.inputEl.value);
    this.resultContainerEl.empty();
    if (!items.length) this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
    for (const it of items.slice(0, this.limit)) {
      const el = this.resultContainerEl.createDiv({ cls: "suggestion-item" });
      this.renderSuggestion(it, el);
      el.addEventListener("click", () => { this.close(); this.onChooseSuggestion(it); });
    }
  }
}
export class FuzzySuggestModal extends SuggestModal {
  getSuggestions(q) { const m = prepareFuzzySearch(q); return this.getItems().filter((x) => !q || m(this.getItemText(x))).map((item) => ({ item })); }
  renderSuggestion(x, el) { el.setText(this.getItemText(x.item)); }
  onChooseSuggestion(x) { this.onChooseItem(x.item); }
}

// ---------- settings ----------
class Btn {
  constructor(el, extra) { this.buttonEl = el.createEl(extra ? "div" : "button", { cls: extra ? "clickable-icon extra-setting-button" : "" }); }
  setButtonText(t) { this.buttonEl.setText(t); return this; }
  setCta() { this.buttonEl.addClass("mod-cta"); return this; }
  setWarning() { this.buttonEl.addClass("mod-warning"); return this; }
  setDestructive() { this.buttonEl.addClass("mod-warning"); return this; }
  setIcon(i) { setIcon(this.buttonEl, i); return this; }
  setTooltip(t) { this.buttonEl.setAttr("aria-label", t); return this; }
  setDisabled(d) { this.buttonEl.toggleClass("is-disabled", d); this.buttonEl.disabled = d; return this; }
  onClick(f) { this.buttonEl.addEventListener("click", f); return this; }
}
class Toggle {
  constructor(el) { this.el = el.createDiv({ cls: "checkbox-container" }); this.v = false; this.el.addEventListener("click", () => { this.setValue(!this.v); this.cb?.(this.v); }); }
  setValue(v) { this.v = v; this.el.toggleClass("is-enabled", v); return this; }
  onChange(f) { this.cb = f; return this; }
}
class Dropdown {
  constructor(el) { this.selectEl = el.createEl("select", { cls: "dropdown" }); }
  addOption(v, t) { this.selectEl.createEl("option", { value: v, text: t }); return this; }
  setValue(v) { this.selectEl.value = v; return this; }
  onChange(f) { this.selectEl.addEventListener("change", () => f(this.selectEl.value)); return this; }
}
export class SecretComponent {
  constructor(app, el) { this.inputEl = el.createEl("input", { type: "text", placeholder: "secret name" }); }
  setValue(v) { this.inputEl.value = v; return this; }
  onChange(f) { this.inputEl.addEventListener("change", () => f(this.inputEl.value)); return this; }
}
export class Setting {
  constructor(el) {
    this.settingEl = el.createDiv({ cls: "setting-item" });
    const info = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = info.createDiv({ cls: "setting-item-name" });
    this.descEl = info.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(n) { this.nameEl.setText(n); return this; }
  setDesc(d) { this.descEl.setText(d); return this; }
  setHeading() { this.settingEl.addClass("setting-item-heading"); return this; }
  addButton(cb) { cb(new Btn(this.controlEl)); return this; }
  addExtraButton(cb) { cb(new Btn(this.controlEl, true)); return this; }
  addToggle(cb) { cb(new Toggle(this.controlEl)); return this; }
  addDropdown(cb) { cb(new Dropdown(this.controlEl)); return this; }
  addComponent(cb) { cb(this.controlEl); return this; }
}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = createDiv({ cls: "vertical-tab-content" }); }
  /** What Obsidian 1.13 does with getSettingDefinitions(): a heading per group, a Setting per row. */
  update() {
    const el = this.containerEl;
    el.empty();
    for (const g of this.getSettingDefinitions()) {
      if (g.heading) new Setting(el).setName(g.heading).setHeading();
      for (const item of g.items ?? []) {
        const row = new Setting(el).setName(item.name);
        if (item.desc) row.setDesc(item.desc);
        item.render?.(row, g);
      }
    }
  }
}

// ---------- plugin ----------
export class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; }
  async loadData() { try { return JSON.parse(localStorage.getItem("pp-data") || "null"); } catch { return null; } }
  async saveData(d) { localStorage.setItem("pp-data", JSON.stringify(d)); }
  registerView(type, fn) { views[type] = fn; }
  registerMarkdownCodeBlockProcessor(lang, fn) { this.app.codeBlocks[lang] = fn; }
  addSettingTab(tab) { this.app.settingTab = tab; }
  addRibbonIcon(icon, title, cb) { const b = document.getElementById("ribbon").createEl("button", { cls: "clickable-icon", attr: { "aria-label": title } }); setIcon(b, icon); b.addEventListener("click", cb); return b; }
  addCommand(c) { this.app.commands.push(c); return c; }
  addStatusBarItem() { return document.getElementById("statusbar").createDiv({ cls: "status-bar-item" }); }
}

export class App {
  constructor() {
    this.workspace = new Workspace(this);
    this.codeBlocks = {}; this.commands = [];
    this.secretStorage = { getSecret: () => null };
    this.vault = { getFileByPath: () => null, create: async (p, body) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body])); a.download = p; a.click(); }, modify: async () => {} };
    this.setting = {
      open: () => {
        const m = new Modal(this); m.modalEl.addClass("mod-settings");
        m.onOpen = () => { m.contentEl.appendChild(this.settingTab.containerEl); this.settingTab.update(); };
        this.settingModal = m; m.open();
      },
      openTabById: () => {},
    };
  }
  isDarkMode() { return document.body.classList.contains("theme-dark"); }
}
