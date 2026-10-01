import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, emptyStore, type PluginData, type PluginMeta, type Settings, type Store, type UiState } from "./types";
import { Engine } from "./data/engine";
import { prune } from "./data/store";
import { setLanguage, t } from "./i18n";
import { PulseSettingTab } from "./settings";
import { DashboardView, DASHBOARD_VIEW } from "./ui/dashboard";
import { GlanceView, GLANCE_VIEW, PulseBlock } from "./ui/glance";
import { CompetitorsModal, PickMineModal, PluginSearchModal } from "./ui/modals";
import { Model } from "./analysis";
import { fmt, signed } from "./ui/util";

export default class PulsePlugin extends Plugin {
  settings!: Settings;
  store!: Store;
  engine!: Engine;
  private timer: number | null = null;
  private statusEl: HTMLElement | null = null;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  async onload(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data?.settings, ui: { ...DEFAULT_SETTINGS.ui, ...data?.settings?.ui } };
    this.store = { ...emptyStore(), ...data?.store };
    setLanguage(this.settings.language);

    this.engine = new Engine(this);

    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this));
    this.registerView(GLANCE_VIEW, (leaf) => new GlanceView(leaf, this));
    this.registerMarkdownCodeBlockProcessor("plugin-pulse", (source, el, ctx) => ctx.addChild(new PulseBlock(el, this, source)));
    this.addSettingTab(new PulseSettingTab(this.app, this));
    this.addRibbonIcon("activity", t().cmdOpen, () => void this.openDashboard());

    this.addCommand({ id: "open-dashboard", name: t().cmdOpen, callback: () => void this.openDashboard() });
    this.addCommand({ id: "open-glance", name: t().cmdGlance, callback: () => void this.openGlance() });
    this.addCommand({ id: "refresh", name: t().cmdRefresh, callback: () => void this.engine.refresh(true) });
    this.addCommand({ id: "follow-plugin", name: t().cmdAdd, callback: () => this.openFollow() });
    this.addCommand({
      id: "add-competitor", name: t().cmdRival,
      checkCallback: (checking) => {
        if (!this.settings.mine.length) return false;
        if (!checking) {
          const go = (id: string) => this.openCompetitors(id);
          if (this.settings.mine.length === 1) go(this.settings.mine[0]);
          else new PickMineModal(this.app, this, go).open();
        }
        return true;
      },
    });

    // obsidian://plugin-pulse?view=<plugin id|overview|compare>&mode=rivals&range=90 — link a note to a page of the dashboard.
    this.registerObsidianProtocolHandler("plugin-pulse", (p) => {
      const ui = this.settings.ui;
      if (p.range && ["7", "30", "90", "365", "all"].includes(p.range)) ui.range = p.range as UiState["range"];
      if (p.glance) void this.openGlance();
      void this.openDashboard(p.view || undefined, p.mode === "rivals" || p.mode === "self" ? p.mode : undefined);
    });

    this.registerEvent(this.engine.on("changed", () => this.updateStatusBar()));
    const onMotion = () => this.redraw();
    this.reducedMotion.addEventListener("change", onMotion);
    this.register(() => this.reducedMotion.removeEventListener("change", onMotion));

    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBar();
      this.schedule();
      if (this.settings.mine.length) void this.engine.refresh();
    });
  }

  onunload(): void {
    if (this.timer != null) window.clearInterval(this.timer);
  }

  // ---------- what the engine needs ----------
  save(): Promise<void> { return this.saveSettings(); }
  token(): string | undefined {
    return this.settings.githubSecret ? this.app.secretStorage.getSecret(this.settings.githubSecret) ?? undefined : undefined;
  }
  celebrate(id: string, milestone: number): void {
    new Notice(t().celebrate(this.settings.meta[id]?.name ?? id, fmt(milestone)), 8000);
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ settings: this.settings, store: this.store } satisfies PluginData);
  }

  motion(): boolean {
    return this.settings.motion === "auto" ? !this.reducedMotion.matches : this.settings.motion === "on";
  }

  schedule(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.settings.refreshMinutes > 0) {
      this.timer = window.setInterval(() => void this.engine.refresh(), this.settings.refreshMinutes * 60e3);
      this.registerInterval(this.timer);
    }
  }

  /** Re-renders open views, e.g. after the language or motion setting changed. */
  redraw(): void {
    this.engine.trigger("changed");
    for (const leaf of this.app.workspace.getLeavesOfType(GLANCE_VIEW)) (leaf.view as GlanceView).draw?.();
  }

  updateStatusBar(): void {
    if (!this.settings.statusBar || !this.settings.mine.length) { this.statusEl?.remove(); this.statusEl = null; return; }
    if (!this.statusEl) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("pp-status", "mod-clickable");
      this.statusEl.addEventListener("click", () => void this.openDashboard());
    }
    const m = new Model(this.store);
    const latest = this.settings.mine.map((id) => m.latest(id)?.date).filter(Boolean).sort().reverse()[0];
    const today = this.settings.mine.reduce((n, id) => {
      const p = m.series(id).find((x) => x.date === latest);
      return n + (p?.daily ?? 0);
    }, 0);
    this.statusEl.setText(t().statusBar(signed(today)));
    this.statusEl.setAttr("aria-label", t().statusBarTip);
  }

  /** Called whenever the followed plugins or their competitors change. */
  async trackedChanged(): Promise<void> {
    prune(this.store, new Set(this.engine.tracked()));
    this.engine.recordFromMemory(this.engine.tracked());
    await this.saveSettings();
    this.engine.trigger("changed");
    void this.engine.refresh();
  }

  async follow(list: PluginMeta[]): Promise<void> {
    const added = list.filter((p) => !this.settings.mine.includes(p.id));
    for (const p of list) this.settings.meta[p.id] = p;
    if (!added.length) { if (list[0]) new Notice(t().already(list[0].name)); return; }
    this.settings.mine.push(...added.map((p) => p.id));
    if (added.length === 1 && this.settings.mine.length > 1) this.settings.ui.view = added[0].id;
    new Notice(added.length === 1 ? t().followed(added[0].name) : t().followN(added.length));
    await this.trackedChanged();
  }

  openFollow(): void {
    new PluginSearchModal(this.app, this, new Set(this.settings.mine), (p) => void this.follow([p]).then(() => this.openDashboard(p.id))).open();
  }

  openCompetitors(id: string, onDone?: () => void): void {
    new CompetitorsModal(this.app, this, id, () => { onDone?.(); this.engine.trigger("changed"); }).open();
  }

  openSettings(): void {
    // The settings modal has no public API to open a given tab.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  async openDashboard(view?: string, mode?: UiState["mode"]): Promise<void> {
    if (view) { this.settings.ui.view = view; if (mode) this.settings.ui.mode = mode; }
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(DASHBOARD_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: DASHBOARD_VIEW, active: true, state: view ? { view, mode } : {} });
    } else if (view) {
      await leaf.setViewState({ type: DASHBOARD_VIEW, active: true, state: { view, mode } });
    }
    await workspace.revealLeaf(leaf);
  }

  async openGlance(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(GLANCE_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: GLANCE_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
