import { ItemView, MarkdownRenderChild, setIcon, type WorkspaceLeaf } from "obsidian";
import type PulsePlugin from "../main";
import { Model } from "../analysis";
import { addDays } from "../data/store";
import { t } from "../i18n";
import { readPalette } from "./charts";
import { delta, fmt, rich, signed, sharedMax, sparkBars, swatch } from "./util";

export const GLANCE_VIEW = "plugin-pulse-glance";

interface ListOpts { days: number; rivalsOf?: string; onOpen?: (id: string) => void }

/**
 * The compact form shared by the sidebar and the code block: one row per plugin with its total,
 * latest day, rank and the last days as bars on a shared scale.
 */
export function renderList(el: HTMLElement, plugin: PulsePlugin, ids: string[], o: ListOpts): void {
  const m = new Model(plugin.store), P = readPalette(el);
  const S = P.series, mine = plugin.settings.mine;
  const color = (id: string, i: number) => mine.includes(id) && !o.rivalsOf ? S[mine.indexOf(id) % S.length] : S[i % S.length];
  const shown = ids.filter((id) => m.series(id).length);
  const lastDate = shown.map((id) => m.latest(id)?.date as string).sort().reverse()[0];
  const days = lastDate ? Array.from({ length: o.days }, (_, i) => addDays(lastDate, i - o.days + 1)) : [];
  const dailyOf = (id: string) => { const mp = new Map(m.series(id).map((x) => [x.date, x.daily])); return days.map((d) => mp.get(d) ?? null); };
  const barMax = sharedMax(shown.map((id) => dailyOf(id))) ?? undefined;

  if (shown.length > 1 && !o.rivalsOf) {
    const total = m.totalSeries(shown);
    const A = m.analyze(total.map((x) => ({ date: x.date, total: x.total, daily: x.daily, rank: null, gap: x.gap })));
    if (A) {
      const sum = el.createDiv({ cls: "pp-g-sum" });
      sum.createDiv({ cls: "pp-g-big", text: fmt(A.total) });
      rich(sum.createDiv({ cls: "pp-g-line" }), `${t().latestShort} **${signed(A.last?.daily)}** · ${t().days7} **${signed(A.sum7)}** ${delta(A.momentum)}`);
    }
  }

  ids.forEach((id, i) => {
    const row = el.createDiv({ cls: "pp-g-row" + (o.onOpen ? " is-link" : "") + (id === o.rivalsOf ? " is-me" : "") });
    if (o.onOpen) { row.tabIndex = 0; row.addEventListener("click", () => o.onOpen?.(id)); row.addEventListener("keydown", (e) => { if (e.key === "Enter") o.onOpen?.(id); }); }
    const head = row.createDiv({ cls: "pp-g-head" });
    const name = head.createDiv({ cls: "pp-g-name" });
    swatch(name, color(id, i));
    name.appendText(plugin.settings.meta[id]?.name ?? id);
    const full = m.series(id), a = m.analyze(full);
    head.createDiv({ cls: "pp-g-total", text: a ? fmt(a.total) : "–" });
    if (!a) { row.createDiv({ cls: "pp-g-sub", text: t().pendingTitle }); return; }
    const st = m.standing(id);
    rich(row.createDiv({ cls: "pp-g-sub" }), `${t().latestShort} **${signed(a.last?.daily)}** · ${t().days7} ${signed(a.sum7)} ${delta(a.momentum)}` + (st ? ` · ${t().rankChip(fmt(st.rank))}` : ""));
    sparkBars(row, dailyOf(id), color(id, i), barMax);

    // One line on how it stands against its competitors.
    const rivals = !o.rivalsOf ? (plugin.settings.competitors[id] ?? []).filter((x) => m.series(x).length) : [];
    if (rivals.length) {
      const group = [id, ...rivals].sort((x, y) => (m.latest(y)?.downloads ?? 0) - (m.latest(x)?.downloads ?? 0));
      const above = group.slice(0, group.indexOf(id)).reverse()[0];
      const race = above ? m.race(id, above) : null;
      row.createDiv({ cls: "pp-g-rival", text: t().inGroup(group.indexOf(id) + 1, group.length) + (above && race?.days != null ? " · " + t().nextPass(plugin.settings.meta[above]?.name ?? above, race.days) : "") });
    }
  });
}

/** Sidebar widget: the short version, always in view. Clicking a row opens that plugin in the dashboard. */
export class GlanceView extends ItemView {
  private body!: HTMLElement;
  private dot!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: PulsePlugin) { super(leaf); }
  getViewType(): string { return GLANCE_VIEW; }
  getDisplayText(): string { return t().appName; }
  getIcon(): string { return "activity"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("pp-root", "pp-glance");
    const head = root.createDiv({ cls: "pp-g-top" });
    head.createDiv({ cls: "pp-g-title", text: t().glanceTitle });
    this.dot = head.createSpan({ cls: "pp-live-dot" });
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, type: "button" } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
    };
    btn("refresh-cw", t().refresh, () => void this.plugin.engine.refresh(true));
    btn("layout-dashboard", t().openDashboard, () => void this.plugin.openDashboard());
    this.body = root.createDiv({ cls: "pp-g-body" });
    this.registerEvent(this.plugin.engine.on("changed", () => this.draw()));
    this.registerEvent(this.plugin.engine.on("status", () => this.status()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.draw()));
    this.status();
    this.draw();
  }

  private status() {
    const s = this.plugin.engine.status.state;
    this.dot.className = "pp-live-dot" + (s === "ok" || s === "partial" ? " is-on" : s === "offline" ? " is-err" : s === "loading" ? " is-busy" : "");
  }

  /** Drawn while detached (a sidebar restored in the background)? Draw again once it is shown. */
  private drawnDetached = false;

  onResize(): void {
    if (this.drawnDetached && this.body?.isConnected) this.draw();
  }

  draw(): void {
    this.drawnDetached = !this.body.isConnected;
    this.body.empty();
    const mine = this.plugin.settings.mine;
    if (!mine.length) {
      this.body.createEl("p", { cls: "pp-muted", text: t().obText });
      this.body.createEl("button", { cls: "mod-cta", text: t().cmdAdd, attr: { type: "button" } }).addEventListener("click", () => void this.plugin.openDashboard());
      return;
    }
    renderList(this.body, this.plugin, mine, { days: 14, onOpen: (id) => void this.plugin.openDashboard(id) });
  }
}

/**
 * ```plugin-pulse
 * plugin: vault-orrery        (optional — default: all of yours; several separated by commas)
 * days: 30                    (optional — bars to show, 7 to 60)
 * rivals: true                (optional — the plugin side by side with its competitors)
 * ```
 */
export class PulseBlock extends MarkdownRenderChild {
  constructor(el: HTMLElement, private plugin: PulsePlugin, private source: string) { super(el); }

  onload(): void {
    this.draw();
    this.registerEvent(this.plugin.engine.on("changed", () => this.draw()));
  }

  private draw() {
    const el = this.containerEl;
    el.empty();
    el.addClass("pp-root", "pp-block");
    const opts: Record<string, string> = {};
    for (const line of this.source.split("\n")) {
      const m = line.match(/^\s*([a-z]+)\s*:\s*(.+?)\s*$/i);
      if (m) opts[m[1].toLowerCase()] = m[2];
    }
    const mine = this.plugin.settings.mine;
    const asked = (opts.plugin ?? opts.plugins)?.split(",").map((s) => s.trim()).filter(Boolean);
    const tracked = new Set(this.plugin.engine.tracked());
    const unknown = asked?.find((id) => !tracked.has(id));
    if (unknown) { el.createDiv({ cls: "pp-muted", text: t().blockUnknown(unknown) }); return; }
    const ids = asked?.length ? asked : mine;
    if (!ids.length) { el.createDiv({ cls: "pp-muted", text: t().blockEmpty }); return; }
    const days = Math.max(7, Math.min(60, parseInt(opts.days ?? "14", 10) || 14));
    const rivals = /^(true|yes|1)$/i.test(opts.rivals ?? "") && ids.length === 1;
    const list = rivals ? [ids[0], ...(this.plugin.settings.competitors[ids[0]] ?? [])] : ids;
    renderList(el, this.plugin, list, { days, rivalsOf: rivals ? ids[0] : undefined, onOpen: (id) => void this.plugin.openDashboard(mine.includes(id) ? id : ids[0], rivals ? "rivals" : undefined) });
  }
}
