import { App, FuzzySuggestModal, Modal, Notice, SuggestModal, prepareFuzzySearch, setIcon } from "obsidian";
import type PulsePlugin from "../main";
import type { PluginMeta } from "../types";
import { fetchPluginList } from "../data/sources";
import { similarPlugins } from "../analysis";
import { t } from "../i18n";
import { fmt } from "./util";

/** Search the whole community directory. With no query, the most downloaded come first. */
export class PluginSearchModal extends SuggestModal<PluginMeta> {
  private list: PluginMeta[] | null = null;
  private failed = false;

  constructor(app: App, private plugin: PulsePlugin, private exclude: Set<string>, private onPick: (p: PluginMeta) => void) {
    super(app);
    this.setPlaceholder(t().searchPlaceholder);
    this.emptyStateText = t().loadingDir;
    this.limit = 60;
    void Promise.all([fetchPluginList(), this.plugin.engine.ensureLatest()])
      .then(([list]) => { this.list = list; this.emptyStateText = ""; this.inputEl.dispatchEvent(new Event("input")); })
      .catch(() => { this.failed = true; this.emptyStateText = t().dirFailed; this.inputEl.dispatchEvent(new Event("input")); });
  }

  getSuggestions(query: string): PluginMeta[] {
    if (!this.list) return [];
    const dl = (id: string) => this.plugin.engine.downloadsOf(id) ?? 0;
    const pool = this.list.filter((p) => !this.exclude.has(p.id));
    const q = query.trim();
    if (!q) return [...pool].sort((a, b) => dl(b.id) - dl(a.id)).slice(0, this.limit);
    const match = prepareFuzzySearch(q);
    return pool
      .map((p) => ({ p, m: match(`${p.name} ${p.id} ${p.author}`) }))
      .filter((x) => x.m)
      .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0) || dl(b.p.id) - dl(a.p.id))
      .slice(0, this.limit)
      .map((x) => x.p);
  }

  renderSuggestion(p: PluginMeta, el: HTMLElement): void {
    el.addClass("pp-suggest");
    const top = el.createDiv({ cls: "pp-suggest-top" });
    top.createSpan({ cls: "pp-suggest-name", text: p.name });
    top.createSpan({ cls: "pp-suggest-meta", text: `${p.author} · ${t().downloadsN(fmt(this.plugin.engine.downloadsOf(p.id)))}` });
    el.createDiv({ cls: "pp-suggest-desc", text: p.description });
  }

  onChooseSuggestion(p: PluginMeta): void { this.onPick(p); }
}

/** Pick one of your plugins (for "Add a competitor" from the command palette). */
export class PickMineModal extends FuzzySuggestModal<string> {
  constructor(app: App, private plugin: PulsePlugin, private onPick: (id: string) => void) {
    super(app);
    this.setPlaceholder(t().pickMine);
  }
  getItems(): string[] { return this.plugin.settings.mine; }
  getItemText(id: string): string { return this.plugin.settings.meta[id]?.name ?? id; }
  onChooseItem(id: string): void { this.onPick(id); }
}

/**
 * Finds every plugin listed under an author name or GitHub username, with a checkbox each.
 * Used inline on the empty dashboard and in its own modal from the settings.
 */
export function authorSearch(parent: HTMLElement, plugin: PulsePlugin, onDone: () => void): void {
  const box = parent.createDiv({ cls: "pp-author" });
  const form = box.createEl("form", { cls: "pp-author-form" });
  const input = form.createEl("input", { type: "text", attr: { placeholder: t().authorPlaceholder, "aria-label": t().obAuthor, spellcheck: "false" } });
  form.createEl("button", { cls: "mod-cta", text: t().find, attr: { type: "submit" } });
  const out = box.createDiv({ cls: "pp-author-out" });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    out.empty();
    out.createDiv({ cls: "pp-muted", text: t().loadingDir });
    fetchPluginList().then((list) => {
      out.empty();
      const found = list.filter((p) => p.author.toLowerCase() === q || p.repo.split("/")[0].toLowerCase() === q || p.author.toLowerCase().includes(q));
      if (!found.length) { out.createDiv({ cls: "pp-muted", text: t().noneByAuthor }); return; }
      out.createDiv({ cls: "pp-muted", text: t().foundN(found.length) });
      const picked = new Set(found.filter((p) => !plugin.settings.mine.includes(p.id)).map((p) => p.id));
      const ul = out.createDiv({ cls: "pp-author-list" });
      for (const p of found) {
        const row = ul.createEl("label", { cls: "pp-author-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = picked.has(p.id) || plugin.settings.mine.includes(p.id);
        cb.disabled = plugin.settings.mine.includes(p.id);
        cb.addEventListener("change", () => { if (cb.checked) picked.add(p.id); else picked.delete(p.id); go.setText(t().followN(picked.size)); go.disabled = !picked.size; });
        const txt = row.createDiv();
        txt.createDiv({ cls: "pp-suggest-name", text: p.name });
        txt.createDiv({ cls: "pp-suggest-desc", text: p.description });
      }
      const go = out.createEl("button", { cls: "mod-cta", text: t().followN(picked.size), attr: { type: "button" } });
      go.disabled = !picked.size;
      go.addEventListener("click", () => {
        void plugin.follow(found.filter((p) => picked.has(p.id))).then(onDone);
      });
    }).catch(() => { out.empty(); out.createDiv({ cls: "pp-muted", text: t().dirFailed }); });
  });
  window.setTimeout(() => input.focus(), 50);
}

export class AuthorModal extends Modal {
  constructor(app: App, private plugin: PulsePlugin, private onDone: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t().sByAuthor);
    this.contentEl.addClass("pp-modal");
    this.contentEl.createEl("p", { cls: "pp-muted", text: t().sByAuthorDesc });
    authorSearch(this.contentEl, this.plugin, () => { this.close(); this.onDone(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Edit one plugin's competitors: the current list, similar plugins to add in one click, and full search. */
export class CompetitorsModal extends Modal {
  private changed = false;

  constructor(app: App, private plugin: PulsePlugin, private me: string, private onDone: () => void) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t().rivalsFor(this.plugin.settings.meta[this.me]?.name ?? this.me));
    this.contentEl.addClass("pp-modal");
    void this.plugin.engine.ensureLatest().then(() => this.draw()).catch(() => this.draw());
    this.draw();
  }

  private get list(): string[] { return (this.plugin.settings.competitors[this.me] ??= []); }

  private draw() {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { cls: "pp-muted", text: t().rivalsHelp });
    const dl = (id: string) => t().downloadsN(fmt(this.plugin.engine.downloadsOf(id)));

    el.createEl("h4", { text: t().current });
    const cur = el.createDiv({ cls: "pp-rival-list" });
    if (!this.list.length) cur.createDiv({ cls: "pp-muted", text: t().noneYet2 });
    for (const id of this.list) {
      const row = cur.createDiv({ cls: "pp-rival-row" });
      const txt = row.createDiv({ cls: "pp-rival-text" });
      txt.createSpan({ cls: "pp-suggest-name", text: this.plugin.settings.meta[id]?.name ?? id });
      txt.createSpan({ cls: "pp-suggest-meta", text: dl(id) });
      const rm = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t().remove, type: "button" } });
      setIcon(rm, "x");
      rm.addEventListener("click", () => { this.list.splice(this.list.indexOf(id), 1); this.changed = true; this.draw(); });
    }

    const search = el.createEl("button", { text: t().searchAny, attr: { type: "button" } });
    search.addEventListener("click", () => {
      new PluginSearchModal(this.app, this.plugin, new Set([this.me, ...this.list]), (p) => this.add(p)).open();
    });

    el.createEl("h4", { text: t().suggested });
    const sug = el.createDiv({ cls: "pp-rival-list" });
    sug.createDiv({ cls: "pp-muted", text: t().loadingDir });
    fetchPluginList().then((all) => {
      sug.empty();
      const target = all.find((p) => p.id === this.me) ?? this.plugin.settings.meta[this.me];
      if (!target) return;
      const skip = new Set([this.me, ...this.list, ...this.plugin.settings.mine]);
      for (const p of similarPlugins(target, all.filter((x) => !skip.has(x.id)), 8)) {
        const row = sug.createDiv({ cls: "pp-rival-row" });
        const txt = row.createDiv({ cls: "pp-rival-text" });
        txt.createSpan({ cls: "pp-suggest-name", text: p.name });
        txt.createSpan({ cls: "pp-suggest-meta", text: `${p.author} · ${dl(p.id)}` });
        txt.createDiv({ cls: "pp-suggest-desc", text: p.description });
        const add = row.createEl("button", { text: t().add, attr: { type: "button" } });
        add.addEventListener("click", () => this.add(p));
      }
    }).catch(() => { sug.empty(); sug.createDiv({ cls: "pp-muted", text: t().dirFailed }); });

    const foot = el.createDiv({ cls: "modal-button-container" });
    foot.createEl("button", { cls: "mod-cta", text: t().done, attr: { type: "button" } }).addEventListener("click", () => this.close());
  }

  private add(p: PluginMeta) {
    if (!this.list.includes(p.id)) this.list.push(p.id);
    this.plugin.settings.meta[p.id] = p;
    this.changed = true;
    this.draw();
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.changed) {
      void this.plugin.trackedChanged().then(() => this.onDone());
    }
  }
}

export function notice(msg: string): void { new Notice(msg); }
