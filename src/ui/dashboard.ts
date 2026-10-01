import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type PulsePlugin from "../main";
import { Model, mean, semverCmp, weekdayOf, type Analysis, type Pt } from "../analysis";
import { addDays, dayDiff, todayUtc } from "../data/store";
import { loc, t } from "../i18n";
import type { Range, UiState } from "../types";
import {
  Chart, makeChart, readPalette, baseOptions, wipe, crosshair, endLabels, releaseMarkers, forecastZone, peakLabel,
  areaFill, lineDataset, forecastSegment, project, num, dateTick, versionTick, dayTick,
  type Palette, type Marker, type Cfg, type Ds, type TI,
} from "./charts";
import { Orrery } from "./orrery";
import { fmt, fmt1, signed, delta, shortDate, longDate, rich, Tip, Revealer, countUp, sparkline, sparkBars, swatch, alpha, pct1, sharedMax } from "./util";
import { authorSearch } from "./modals";

export const DASHBOARD_VIEW = "plugin-pulse-dashboard";

/** First day of the public archive; a series starting then began before the archive did, so its age is unknown. */
const ARCHIVE_EPOCH = "2020-11-01";

interface Insight { k: string; t: string; b: string }
interface Tile { label: string; color?: string; value: number | string; prefix?: string; pre?: string; unit?: string; sub?: string; spark?: (number | null)[]; bars?: (number | null)[]; barMax?: number }
interface CardOpts { title: string; desc?: string; wide?: boolean; tall?: boolean; height?: number; legend?: { name: string; color?: string; cls?: string }[] | null }

export class DashboardView extends ItemView {
  private tip!: Tip;
  private revealer!: Revealer;
  private charts: Chart[] = [];
  private orrery: Orrery | null = null;
  private P!: Palette;
  private m!: Model;
  private colors = new Map<string, string>();
  private observers: ResizeObserver[] = [];
  /** Where each segmented control's highlight was, so a rebuilt control slides from there. */
  private thumbs = new Map<string, { x: number; y: number; w: number; h: number }>();
  private els!: { root: HTMLElement; live: HTMLElement; liveDot: HTMLElement; liveText: HTMLElement; refresh: HTMLElement; motion: HTMLElement; controls: HTMLElement; hero: HTMLElement; heroKicker: HTMLElement; heroNum: HTMLElement & { _val?: number }; heroLine: HTMLElement; heroChips: HTMLElement; heroMs: HTMLElement; body: HTMLElement };

  constructor(leaf: WorkspaceLeaf, private plugin: PulsePlugin) { super(leaf); }

  getViewType(): string { return DASHBOARD_VIEW; }
  getDisplayText(): string { return t().appName; }
  getIcon(): string { return "activity"; }

  get ui(): UiState { return this.plugin.settings.ui; }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<UiState> | null;
    if (s?.view) { this.ui.view = s.view; if (s.mode) this.ui.mode = s.mode; if (this.els) this.render(); }
    await super.setState(state, result);
  }

  getState(): Record<string, unknown> { return { view: this.ui.view }; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("pp-root");
    const wrap = root.createDiv({ cls: "pp-wrap" });
    this.tip = new Tip(root);
    this.revealer = new Revealer(() => this.plugin.motion());

    const header = wrap.createEl("header", { cls: "pp-header" });
    header.createEl("h1", { text: t().appName });
    const meta = header.createDiv({ cls: "pp-meta" });
    const live = meta.createSpan({ cls: "pp-live" });
    const liveDot = live.createSpan({ cls: "pp-live-dot" });
    const liveText = live.createSpan({ text: t().checking });
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = meta.createEl("button", { cls: "pp-icon-btn clickable-icon", attr: { "aria-label": label, type: "button" } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    const refresh = btn("refresh-cw", t().refresh, () => void this.plugin.engine.refresh(true));
    const motion = btn("sparkles", t().motion, () => {
      this.plugin.settings.motion = this.plugin.motion() ? "off" : "on";
      void this.plugin.saveSettings();
      this.applyMotion(); this.render();
    });
    btn("settings", t().settings, () => this.plugin.openSettings());

    const controls = wrap.createDiv({ cls: "pp-controls" });

    const hero = wrap.createEl("section", { cls: "pp-hero" });
    const heroMain = hero.createDiv({ cls: "pp-hero-main" });
    const heroKicker = heroMain.createDiv({ cls: "pp-kicker" });
    const heroNum = heroMain.createDiv({ cls: "pp-hero-num", text: "0" });
    const heroLine = heroMain.createEl("p", { cls: "pp-hero-line" });
    const heroChips = heroMain.createDiv({ cls: "pp-chips" });
    const heroMs = heroMain.createDiv();
    const viz = hero.createDiv({ cls: "pp-hero-viz" });
    const cv = viz.createEl("canvas", { cls: "pp-orrery", attr: { role: "img" } });
    this.orrery = new Orrery(cv, () => this.P, () => this.plugin.motion(), this.tip, (id) => this.setView(this.ui.view === id ? (this.plugin.settings.mine.length > 1 ? "overview" : id) : id));

    const body = wrap.createDiv({ cls: "pp-body" });
    this.els = { root: wrap, live, liveDot, liveText, refresh, motion, controls, hero, heroKicker, heroNum, heroLine, heroChips, heroMs, body };

    this.registerEvent(this.plugin.engine.on("changed", () => this.render()));
    this.registerEvent(this.plugin.engine.on("status", () => this.showStatus()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.render()));
    this.applyMotion();
    this.showStatus();
    this.render();
    if (this.plugin.engine.status.state === "idle") void this.plugin.engine.refresh();
  }

  async onClose(): Promise<void> {
    this.destroyCharts();
    this.observers.forEach((o) => o.disconnect());
    this.orrery?.destroy();
    this.revealer?.disconnect();
    this.tip.disconnect();
  }

  // ---------- chrome ----------
  private applyMotion() {
    this.contentEl.toggleClass("pp-still", !this.plugin.motion());
    this.els.motion.setAttr("aria-pressed", String(this.plugin.motion()));
  }

  private showStatus() {
    const s = this.plugin.engine.status, { liveDot, liveText, refresh, live } = this.els;
    refresh.toggleClass("is-spinning", s.state === "loading");
    liveDot.className = "pp-live-dot" + (s.state === "ok" || s.state === "partial" ? " is-on" : s.state === "offline" ? " is-err" : "");
    const time = s.at ? new Date(s.at).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }) : "";
    liveText.setText(s.state === "loading" ? t().checking : s.state === "offline" ? t().offline : s.state !== "idle" && time ? t().checkedAt(time) : "");
    const notes = s.detail?.split("\n").map((n) => n === "github-limit" ? t().githubLimit : n).join("\n");
    this.tip.bind(live, [s.state === "partial" ? t().partial : "", notes ?? ""].filter(Boolean).join("\n") || t().refresh, false);
  }

  setView(view: string, mode?: UiState["mode"]): void {
    this.ui.view = view;
    if (mode) this.ui.mode = mode;
    void this.plugin.saveSettings();
    this.render();
  }

  // ---------- data helpers ----------
  private nameOf(id: string) { return this.plugin.settings.meta[id]?.name ?? id; }
  private colorOf(id: string) { return this.colors.get(id) ?? this.P.ink2; }
  private assignColors(ids: string[]) {
    this.colors.clear();
    const S = this.P.series, mine = this.plugin.settings.mine;
    mine.forEach((id, i) => this.colors.set(id, S[i % S.length]));
    // Competitors take the colors their plugin isn't using, in order.
    let k = 0;
    for (const id of ids) {
      if (this.colors.has(id)) continue;
      const used = new Set(ids.filter((x) => this.colors.has(x)).map((x) => this.colors.get(x)));
      for (let tries = 0; tries < S.length && used.has(S[k % S.length]); tries++) k++;
      this.colors.set(id, S[k++ % S.length]);
    }
  }
  private clip<T extends { date: string }>(series: T[]): T[] {
    if (this.ui.range === "all" || !series.length) return series;
    const start = addDays(series[series.length - 1].date, -(+this.ui.range) + 1);
    return series.filter((s) => s.date >= start);
  }
  private datesFor(ids: string[]): string[] {
    const ss = ids.map((id) => this.m.series(id)).filter((s) => s.length);
    if (!ss.length) return [];
    const first = ss.map((s) => s[0].date).sort()[0], last = ss.map((s) => s[s.length - 1].date).sort().reverse()[0];
    const out: string[] = [];
    const from = this.ui.range === "all" ? first : [first, addDays(last, -(+this.ui.range) + 1)].sort().reverse()[0];
    for (let d = from; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }
  private horizon() { return this.ui.range === "7" ? 3 : this.ui.range === "30" ? 10 : 14; }
  private pick(full: Pt[], labels: string[], key: "total" | "daily" | "rank") {
    const m = new Map(full.map((x) => [x.date, x[key]]));
    return labels.map((d) => m.get(d) ?? null);
  }

  // ---------- render ----------
  private destroyCharts() { while (this.charts.length) this.charts.pop()?.destroy(); }

  render(): void {
    if (!this.els) return;
    this.destroyCharts();
    this.revealer.disconnect();
    this.revealer = new Revealer(() => this.plugin.motion());
    this.els.body.empty();
    this.P = readPalette(this.contentEl);
    Chart.defaults.font.family = this.P.font;
    this.m = new Model(this.plugin.store);
    const s = this.plugin.settings, mine = s.mine;

    if (!mine.length) {
      this.els.controls.empty();
      this.els.hero.hide();
      this.renderOnboarding();
      return;
    }
    const valid = ["overview", "compare"].includes(this.ui.view) ? mine.length > 1 : mine.includes(this.ui.view);
    if (!valid) this.ui.view = mine.length > 1 ? "overview" : mine[0];
    const view = this.ui.view;
    const rivals = mine.includes(view) ? (s.competitors[view] ?? []) : [];
    this.assignColors(mine.includes(view) ? [view, ...rivals] : mine);
    this.renderControls(rivals.length);
    this.els.hero.show();

    if (view === "overview") this.renderTotal();
    else if (view === "compare") this.renderCompare();
    else if (!this.m.series(view).length) this.renderPending(view);
    else if (this.ui.mode === "rivals" && rivals.length) this.renderRivals(view, rivals);
    else this.renderPlugin(view);

    const note = this.els.body.createEl("details", { cls: "pp-note" });
    note.createEl("summary", { text: t().basisTitle });
    note.createEl("p", { text: t().basis });
  }

  // ---------- controls ----------
  private seg(parent: HTMLElement, items: { key: string; label: string; color?: string }[], current: string, onPick: (k: string) => void, label: string): HTMLElement {
    const el = parent.createDiv({ cls: "pp-seg", attr: { role: "group", "aria-label": label } });
    const thumb = el.createSpan({ cls: "pp-thumb" });
    for (const it of items) {
      const b = el.createEl("button", { attr: { type: "button", "aria-pressed": String(it.key === current) } });
      if (it.color) swatch(b, it.color);
      b.appendText(it.label);
      b.addEventListener("click", () => onPick(it.key));
    }
    const put = (p: { x: number; y: number; w: number; h: number }) =>
      thumb.setCssStyles({ width: p.w + "px", height: p.h + "px", transform: `translate(${p.x}px, ${p.y}px)` });
    const place = () => {
      const on = el.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (!on) { thumb.setCssStyles({ width: "0" }); return; }
      const p = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
      put(p);
      this.thumbs.set(label, p);
      if (on.offsetLeft < el.scrollLeft || on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = on.offsetLeft - 8;
    };
    const prev = this.thumbs.get(label);
    if (prev) { thumb.addClass("is-still"); put(prev); }
    window.requestAnimationFrame(() => { thumb.removeClass("is-still"); window.requestAnimationFrame(place); });
    const ro = new ResizeObserver(place);
    ro.observe(el);
    this.observers.push(ro);
    return el;
  }

  private renderControls(rivalCount: number) {
    const c = this.els.controls, s = this.plugin.settings, view = this.ui.view;
    this.observers.forEach((o) => o.disconnect());
    this.observers = [];
    c.empty();
    const tabs = [
      ...(s.mine.length > 1 ? [{ key: "overview", label: t().overview }, { key: "compare", label: t().compare }] : []),
      ...s.mine.map((id) => ({ key: id, label: this.nameOf(id), color: this.colorOf(id) })),
    ];
    const row = c.createDiv({ cls: "pp-row" });
    this.seg(row, tabs, view, (k) => this.setView(k), t().appName);
    const add = row.createEl("button", { cls: "pp-icon-btn clickable-icon", attr: { type: "button", "aria-label": t().cmdAdd } });
    setIcon(add, "plus");
    add.addEventListener("click", () => this.plugin.openFollow());

    const row2 = c.createDiv({ cls: "pp-row" });
    if (s.mine.includes(view)) {
      if (rivalCount) {
        this.seg(row2, [{ key: "self", label: t().self }, { key: "rivals", label: t().rivals(rivalCount) }], this.ui.mode, (k) => this.setView(view, k as UiState["mode"]), t().rivals(rivalCount));
      }
      const edit = row2.createEl("button", { cls: "pp-link-btn", text: rivalCount ? t().editRivals : "+ " + t().addRivals, attr: { type: "button" } });
      edit.addEventListener("click", () => this.plugin.openCompetitors(view, () => { if (!rivalCount) this.ui.mode = "rivals"; }));
    }
    row2.createDiv({ cls: "pp-spacer" });
    const multi = view === "compare" || (s.mine.includes(view) && this.ui.mode === "rivals" && rivalCount > 0);
    if (multi) {
      this.seg(row2, [{ key: "date", label: t().byDate }, { key: "age", label: t().byAge }], this.ui.align, (k) => { this.ui.align = k as UiState["align"]; void this.plugin.saveSettings(); this.render(); }, t().byDate);
    }
    const ranges: Range[] = ["7", "30", "90", "365", "all"];
    this.seg(row2, ranges.map((r) => ({ key: r, label: t().ranges[r] })), this.ui.range, (k) => { this.ui.range = k as Range; void this.plugin.saveSettings(); this.render(); }, t().ranges.all);
  }

  // ---------- states without data ----------
  private renderOnboarding() {
    const card = this.els.body.createDiv({ cls: "pp-card pp-onboard" });
    card.createEl("h2", { cls: "pp-onboard-title", text: t().obTitle });
    card.createEl("p", { text: t().obText });
    authorSearch(card, this.plugin, () => this.render());
    const more = card.createEl("button", { cls: "pp-link-btn", text: t().searchAny, attr: { type: "button" } });
    more.addEventListener("click", () => this.plugin.openFollow());
  }

  private renderPending(id: string) {
    this.renderHero({ name: this.nameOf(id), color: this.colorOf(id), A: null, id });
    const loading = this.plugin.engine.busy || this.plugin.engine.status.state === "idle";
    const card = this.els.body.createDiv({ cls: "pp-card pp-empty" });
    card.createEl("h2", { cls: "pp-onboard-title", text: loading ? t().loadingTitle : t().pendingTitle });
    if (!loading) card.createEl("p", { text: t().pendingText });
    this.orrery?.sync([], null);
  }

  // ---------- hero ----------
  private renderHero(scope: { name: string; color?: string; A: Analysis | null; id?: string; line?: string }) {
    const { heroKicker, heroNum, heroLine, heroChips, heroMs } = this.els, A = scope.A;
    heroKicker.empty();
    if (scope.color) swatch(heroKicker, scope.color);
    heroKicker.appendText(t().totalOf(scope.name));
    countUp(heroNum, A?.total ?? 0, this.plugin.motion(), { from: heroNum._val ?? 0, dur: 1600 });
    heroLine.empty(); heroChips.empty(); heroMs.empty();
    if (!A) return;
    if (scope.line) rich(heroLine, scope.line);
    else if (A.last) {
      const day = signed(A.last.daily);
      const record = A.lastRank === 1 && A.d.length > 7;
      const extra = record ? t().allTimeBest : A.ratio != null && A.ratio >= 1.15 ? t().timesUsual(fmt1(A.ratio)) : A.ratio != null && A.ratio <= 0.85 ? t().quieter : "";
      rich(heroLine, t().latestDay(day) + (extra ? " · " + extra : ""));
    }
    rich(heroChips.createSpan({ cls: "pp-chip" }), `${t().days7} **${signed(A.sum7)}** ${delta(A.momentum)}`);
    if (scope.id) {
      const st = this.m.standing(scope.id);
      if (st) rich(heroChips.createSpan({ cls: "pp-chip" }), `**${t().rankChip(fmt(st.rank))}**` + (st.climbed7 && st.climbed7 > 0 ? ` {up|▲ ${fmt(st.climbed7)}}` : ""));
    }
    if (A.next) {
      const pct = Math.max(2, Math.min(100, (A.total - A.prevM) / (A.next - A.prevM) * 100));
      const head = heroMs.createDiv({ cls: "pp-ms-head" });
      rich(head.createSpan(), t().msTo(fmt(A.next), fmt(A.next - A.total)));
      head.createSpan({ text: A.etaDate ? t().around(longDate(A.etaDate)) : "" });
      const track = heroMs.createDiv({ cls: "pp-ms-track", attr: { role: "progressbar", "aria-valuemin": String(A.prevM), "aria-valuemax": String(A.next), "aria-valuenow": String(A.total) } });
      const fill = track.createDiv({ cls: "pp-ms-fill" });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => fill.setCssStyles({ width: pct + "%" })));
    }
  }

  private syncOrrery(ids: string[], focus: string | null) {
    this.orrery?.sync(ids.map((id) => {
      const a = this.m.analyze(this.m.series(id));
      return { id, name: this.nameOf(id), total: a?.total ?? 0, daily: a?.last?.daily ?? 0, pace: a?.pace ?? 0, color: this.colorOf(id), rank: this.m.standing(id)?.rank ?? null };
    }), focus);
  }

  // ---------- strips ----------
  private insights(list: Insight[], max = 4, skip = [t().kLatest, t().kNext, t().kMomentum]) {
    const el = this.els.body.createDiv({ cls: "pp-insights" });
    list.filter((x) => !skip.includes(x.k)).slice(0, max).forEach((x, i) => {
      const d = el.createEl("article", { cls: "pp-ins" });
      this.tip.bind(d, x.b);
      d.createDiv({ cls: "pp-ins-k", text: x.k });
      rich(d.createDiv({ cls: "pp-ins-t" }), x.t);
      this.revealer.add(d, i);
    });
    if (!el.childElementCount) el.remove();
  }

  private tiles(list: (Tile | null | false | undefined)[], max = 4) {
    const el = this.els.body.createDiv({ cls: "pp-tiles" });
    (list.filter(Boolean) as Tile[]).slice(0, max).forEach((x, i) => {
      const d = el.createDiv({ cls: "pp-tile" });
      const label = d.createDiv({ cls: "pp-tile-label" });
      if (x.color) swatch(label, x.color);
      label.appendText(x.label);
      const value = d.createDiv({ cls: "pp-tile-value" });
      if (typeof x.value === "number") {
        if (x.pre) value.appendText(x.pre);
        value.createSpan({ text: "0", attr: { "data-pp-count": String(x.value), "data-pp-prefix": x.prefix ?? "" } });
        if (x.unit) value.appendText(x.unit);
      } else value.setText(x.value);
      rich(d.createDiv({ cls: "pp-tile-sub" }), x.sub ?? "");
      if (x.bars) sparkBars(d, x.bars, x.color || this.P.ink2, x.barMax);
      else if (x.spark) sparkline(d, x.spark, x.color || this.P.ink2);
      this.revealer.add(d, i);
    });
  }

  // ---------- cards ----------
  private grid(): HTMLElement {
    return this.els.body.querySelector<HTMLElement>(".pp-grid") ?? this.els.body.createDiv({ cls: "pp-grid" });
  }

  private card(o: CardOpts): HTMLElement {
    const g = this.grid();
    const el = g.createEl("section", { cls: "pp-card" + (o.wide ? " is-wide" : "") });
    const h = el.createEl("h2", { text: o.title });
    if (o.desc) this.tip.bind(h, o.desc);
    if (o.legend) {
      const lg = el.createDiv({ cls: "pp-legend" });
      for (const l of o.legend) {
        const s = lg.createSpan();
        if (l.cls) s.createSpan({ cls: "pp-legend-" + l.cls }); else swatch(s, l.color ?? this.P.ink2);
        s.appendText(l.name);
      }
    }
    return el;
  }

  private chartCard(o: CardOpts, build: () => Cfg): HTMLElement {
    const el = this.card(o);
    const box = el.createDiv({ cls: "pp-chart" + (o.tall ? " is-tall" : "") });
    if (o.height) box.setCssStyles({ height: o.height + "px" });
    const cv = box.createEl("canvas", { attr: { role: "img", "aria-label": o.title } });
    this.revealer.add(el, this.grid().childElementCount % 2, () => { this.charts.push(makeChart(cv, build())); });
    return el;
  }

  private domCard(o: CardOpts, fill: (el: HTMLElement) => (() => void) | void): HTMLElement {
    const el = this.card(o);
    const after = fill(el);
    // Targets are set a frame after the card appears, so bars and dots move into place.
    this.revealer.add(el, this.grid().childElementCount % 2, () => { if (after) window.requestAnimationFrame(after); });
    return el;
  }

  private tableCard(head: string[], rows: string[][], title?: string, desc?: string, open = false) {
    const el = this.grid().createEl("section", { cls: "pp-card is-wide" });
    let host: HTMLElement = el;
    if (title) {
      const h = el.createEl("h2", { text: title });
      if (desc) this.tip.bind(h, desc);
    }
    const build = () => {
      const scroll = host.createDiv({ cls: "pp-table-scroll" });
      const table = scroll.createEl("table");
      const tr = table.createEl("thead").createEl("tr");
      head.forEach((h) => tr.createEl("th", { text: h }));
      const tb = table.createEl("tbody");
      for (const r of rows) {
        const row = tb.createEl("tr");
        r.forEach((c, i) => {
          const td = row.createEl("td");
          if (i === 0 && c.startsWith("§")) { const [, color, name] = c.split("§"); swatch(td, color); td.appendText(name); }
          else rich(td, c);
        });
      }
    };
    if (open) build();
    else {
      // Years of history make thousands of cells; build them only when asked.
      const det = el.createEl("details");
      det.createEl("summary", { text: t().showTable(rows.length) });
      host = det;
      det.addEventListener("toggle", () => { if (det.open && !det.querySelector("table")) build(); });
    }
    this.revealer.add(el);
  }

  private markers(ids: string[]): Marker[] {
    return ids.flatMap((id) => (this.plugin.store.releases[id] ?? []).map((r) => ({ date: r.date.slice(0, 10), label: "v" + r.version, color: this.colorOf(id), id })))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  private releaseFooter(ids: string[]) {
    const ms = this.markers(ids);
    return (items: TI[]) => {
      if (!items.length) return "";
      const label = items[0].chart.data.labels?.[items[0].dataIndex];
      const date = typeof label === "string" ? label : "";
      const rs = ms.filter((r) => r.date === date);
      return rs.length ? t().released + rs.map((r) => `${this.nameOf(r.id)} ${r.label}`).join(", ") : "";
    };
  }

  // ---------- shared cards ----------
  private dailyChart(o: { labels: string[]; s: { date: string; daily: number | null; gap?: boolean }[]; ids: string[]; title: string; desc: string; legend?: { name: string; color?: string }[]; datasets: Ds[]; markers?: ReturnType<typeof releaseMarkers> }) {
    const P = this.P, s = o.s;
    const ma = s.map((_, i) => { const w = s.slice(Math.max(0, i - 6), i + 1).map((x) => x.daily).filter((v): v is number => v != null); return w.length >= 3 ? Math.round(mean(w) * 10) / 10 : null; });
    const peak = s.reduce((b, x, i) => x.daily != null && (b < 0 || x.daily > (s[b].daily as number)) ? i : b, -1);
    this.chartCard({ title: o.title, desc: o.desc, wide: true, legend: [...(o.legend ?? []), { name: t().ma7, cls: "line" }] }, () => {
      const op = baseOptions(P, this.plugin.motion(), { stacked: true });
      op.layout = { padding: { top: 18 } };
      op.scales.x.ticks.callback = dateTick;
      op.plugins.tooltip.itemSort = (a: TI, b: TI) => b.datasetIndex - a.datasetIndex;
      op.plugins.tooltip.callbacks = {
        label: (it: TI) => (it.dataset as unknown as Ds).isMA ? ` ${t().ma7} ${fmt1(num(it.raw))}` : ` ${it.dataset.label ?? ""} ${signed(num(it.raw))}${s[it.dataIndex].gap ? t().missedDay : ""}`,
        footer: (items: TI[]) => [o.datasets.length > 1 ? t().sumLine(signed(s[items[0]?.dataIndex]?.daily)) : "", this.releaseFooter(o.ids)(items)].filter(Boolean),
      };
      return {
        type: "bar",
        data: {
          labels: o.labels, datasets: [
            ...o.datasets.map((d) => ({ ...d, borderColor: P.surface, borderWidth: o.datasets.length > 1 ? { top: 2 } : 0, borderSkipped: "bottom",
              borderRadius: o.datasets.length > 1 ? 0 : { topLeft: 4, topRight: 4 }, maxBarThickness: 22, categoryPercentage: 0.85, barPercentage: 0.9 })),
            { type: "line", label: t().ma7, isMA: true, data: ma, stack: "ma", order: -1, borderColor: P.ink2, backgroundColor: P.ink2,
              borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, cubicInterpolationMode: "monotone", spanGaps: true },
          ],
        },
        options: op,
        plugins: [crosshair(P), ...(o.markers ? [o.markers] : []), peakLabel(P, peak, peak >= 0 ? t().peak(signed(s[peak].daily)) : "", (d) => !!d.isMA)],
      };
    });
  }

  private whenCard(A: Analysis, color?: string) {
    const d = A.d.slice(-26 * 7);
    if (d.length < 7) return;
    const max = Math.max(1, ...d.map((x) => x.daily));
    const bin = (v: number) => v <= 0 ? 0 : Math.min(5, Math.ceil(v / max * 5));
    const start = addDays(d[0].date, -weekdayOf(d[0].date));
    const byDate = new Map(d.map((x) => [x.date, x.daily]));
    const W = t().weekdays;
    this.domCard({ title: t().cWhen, desc: t().dWhen, wide: true }, (el) => {
      const when = el.createDiv({ cls: "pp-when" });
      // A single plugin's calendar is shaded with that plugin's color; the overview keeps the neutral blue.
      if (color) when.setCssProps({
        "--pp-h1": alpha(color, 0.14), "--pp-h2": alpha(color, 0.32), "--pp-h3": alpha(color, 0.52),
        "--pp-h4": alpha(color, 0.74), "--pp-h5": color, "--pp-s1": color,
      });
      const heat = when.createDiv().createDiv({ cls: "pp-heat" });
      heat.createSpan();
      W.forEach((w, i) => heat.createSpan({ cls: "pp-wk", text: i % 2 ? "" : w }));
      let n = 0, lastMonth = "";
      for (let w = start; w <= d[d.length - 1].date; w = addDays(w, 7)) {
        const mo = w.slice(5, 7);
        heat.createSpan({ cls: "pp-mo", text: mo !== lastMonth ? t().monthShort(+mo) : "" }); lastMonth = mo;
        for (let k = 0; k < 7; k++) {
          const day = addDays(w, k), v = byDate.get(day);
          const cell = heat.createEl("i", { cls: "pp-cell" + (v == null ? " is-none" : ` pp-h${bin(v)}`) });
          cell.setCssProps({ "--pp-d": String(n++) });
          if (v != null) this.tip.bind(cell, `**${longDate(day)} (${W[k]})**\n${t().newN(signed(v))}`);
        }
      }
      const wmax = Math.max(1, ...A.weekday.map((x) => x.avg ?? 0));
      const best = A.weekday.reduce((b, x) => (x.avg ?? -1) > (b.avg ?? -1) ? x : b);
      const wd = when.createDiv({ cls: "pp-wd" });
      const bars: [HTMLElement, number][] = [];
      A.weekday.forEach((x, i) => {
        const col = wd.createDiv({ cls: "pp-wd-col" + (A.weekdayReady && x === best ? " is-best" : "") });
        this.tip.bind(col, `**${t().weekdayLong(W[x.i])}**\n${t().avgN(fmt1(x.avg), x.n)}`);
        col.createSpan({ cls: "pp-wd-v", text: x.avg == null ? "–" : fmt(x.avg) });
        const bar = col.createDiv({ cls: "pp-wd-bar" });
        bar.setCssProps({ "--pp-d": String(i) });
        bars.push([bar, x.avg ? Math.max(3, x.avg / wmax * 78) : 0]);
        col.createSpan({ cls: "pp-wd-n", text: W[x.i] });
      });
      return () => bars.forEach(([b, h]) => b.setCssStyles({ height: h + "%" }));
    });
  }

  private journeyCard(A: Analysis, name: string) {
    if (!A.next && !A.achieved.length) return;
    const list = A.achieved.slice(-6);
    this.domCard({ title: t().cMilestones, desc: t().dMilestones(name), wide: true }, (el) => {
      const j = el.createDiv({ cls: "pp-journey" });
      list.forEach((x, i) => {
        const prev = i ? list[i - 1] : A.achieved[A.achieved.length - list.length - 1];
        const stop = j.createDiv({ cls: "pp-stop" });
        stop.setCssProps({ "--pp-d": String(i) });
        if (prev) this.tip.bind(stop, t().sinceLast(dayDiff(prev.date, x.date)));
        stop.createDiv({ cls: "pp-stop-dot" });
        stop.createDiv({ cls: "pp-stop-m", text: fmt(x.m) });
        stop.createDiv({ text: shortDate(x.date) });
      });
      if (A.next) {
        const stop = j.createDiv({ cls: "pp-stop is-next" });
        stop.setCssProps({ "--pp-d": String(list.length) });
        stop.createDiv({ cls: "pp-stop-dot" });
        stop.createDiv({ cls: "pp-stop-m", text: fmt(A.next) });
        stop.createDiv({ text: A.etaDate ? t().expected(shortDate(A.etaDate)) : "–" });
      }
    });
  }

  private rankCard(ids: string[], wide: boolean) {
    const series = ids.map((id) => ({ id, s: this.m.series(id) })).filter((x) => x.s.some((v) => v.rank != null));
    if (!series.length) return;
    const all = this.datesFor(series.map((x) => x.id));
    // Only days with a rank: archive-filled days have none, and a long empty stretch would flatten the chart.
    const firstRanked = series.map((x) => x.s.find((v) => v.rank != null)?.date as string).sort()[0];
    const labels = all.filter((d) => d >= firstRanked);
    if (labels.length < 2) return;
    const P = this.P;
    this.chartCard({ title: t().cRank, desc: t().dRank, wide, legend: ids.length > 1 ? series.map((x) => ({ name: this.nameOf(x.id), color: this.colorOf(x.id) })) : null }, () => {
      const o = baseOptions(P, this.plugin.motion(), { grow: false });
      o.layout = { padding: { right: 152, top: 8 } };
      o.scales.y.reverse = true; o.scales.y.beginAtZero = false;
      o.scales.y.ticks.callback = (v) => t().rankTick(fmt(Number(v)));
      o.scales.x.ticks.callback = dateTick;
      o.plugins.tooltip.callbacks = { label: (it: TI) => ` ${it.dataset.label ?? ""} ${t().rankTick(fmt(num(it.raw)))}` };
      o.plugins.tooltip.itemSort = (a: TI, b: TI) => (num(a.raw) ?? 0) - (num(b.raw) ?? 0);
      return {
        type: "line",
        data: { labels, datasets: series.map((x) => ({ ...lineDataset(P, this.pick(x.s, labels, "rank"), this.colorOf(x.id)), label: this.nameOf(x.id) })) },
        options: o, plugins: [wipe(this.plugin.motion()), crosshair(P), endLabels(P, (v) => t().rankTick(fmt(v)), 152)],
      };
    });
  }

  private standingCard(ids: string[]) {
    const st = ids.map((id) => this.m.standing(id)).filter((x): x is NonNullable<typeof x> => !!x);
    const arr = this.plugin.store.market?.downloads;
    if (!st.length || !arr?.length) return;
    const sorted = [...st].sort((a, b) => a.topPct - b.topPct);
    this.domCard({ title: t().cStanding, desc: t().dStanding(fmt(arr.length), fmt(arr[0])), wide: true }, (el) => {
      const stand = el.createDiv({ cls: "pp-stand" });
      stand.setCssProps({ "--pp-lv": String(st.length) });
      for (const p of [50, 25, 10]) {
        const tick = stand.createDiv({ cls: "pp-stand-tick" });
        tick.setCssStyles({ left: 100 - p + "%" });
        tick.createSpan({ text: t().topPct(String(p)) });
      }
      const dots: [HTMLElement, number][] = [];
      st.forEach((s, i) => {
        const me = stand.createDiv({ cls: "pp-stand-me" });
        me.setCssProps({ "--pp-c": this.colorOf(s.id), "--pp-d": String(i), "--pp-k": String(sorted.indexOf(s)) });
        this.tip.bind(me, `**${this.nameOf(s.id)}** ${t().rankTick(fmt(s.rank))} / ${fmt(s.of)}` + (s.need100 && s.need100 > 0 ? `\n${t().more100(signed(s.need100))}` : ""));
        me.createSpan({ text: (st.length > 1 ? this.nameOf(s.id) + " · " : "") + t().topPct(fmt1(s.topPct)) });
        dots.push([me, 100 - s.topPct]);
      });
      return () => dots.forEach(([d, l]) => d.setCssStyles({ left: l + "%" }));
    });
  }

  // ---------- one plugin ----------
  private renderPlugin(id: string) {
    const P = this.P, color = this.colorOf(id), name = this.nameOf(id), store = this.plugin.store;
    const full = this.m.series(id), A = this.m.analyze(full) as Analysis, s = this.clip(full);
    const st = this.m.standing(id), repo = store.repos[id];
    const launchesAll = this.m.launches(id);
    const versions = [...launchesAll].sort((a, b) => semverCmp(b.version, a.version));
    this.renderHero({ name, color, A, id });
    this.syncOrrery(this.plugin.settings.mine, id);
    this.insights(this.pluginInsights(id, A));

    this.tiles([
      { label: t().tLast7, value: A.sum7, prefix: "+", sub: delta(A.momentum), spark: A.d.slice(-14).map((x) => x.daily), color },
      { label: t().tLast30, value: this.m.gainOver(full, 30) ?? 0, prefix: "+", bars: full.slice(-30).map((x) => x.daily), color },
      st && { label: t().tRank, value: st.rank, pre: t().rankPre, unit: t().rankPost, sub: t().topPct(fmt1(st.topPct)), spark: full.filter((x) => x.rank).slice(-30).map((x) => -(x.rank as number)), color },
      A.best && { label: t().tBest, value: A.best.daily, prefix: "+", sub: longDate(A.best.date) },
      versions[0] && { label: t().tVersion, value: "v" + versions[0].version, sub: t().thisVersion(fmt(versions[0].total), versions.length) },
      repo && { label: t().tStars, value: repo.stars, sub: repo.stars ? t().perStar(fmt(A.total / repo.stars)) : t().noneYet },
    ]);

    const labels = s.map((x) => x.date);
    const markers = this.markers([id]);
    this.dailyChart({ labels, s, ids: [id], title: t().cDaily, desc: t().dDailySelf,
      datasets: [{ label: t().hNew, data: s.map((x) => x.daily), backgroundColor: color }], markers: releaseMarkers(P, markers) });

    const H = this.horizon(), lastIdx = labels.length - 1;
    const fLabels = [...labels, ...Array.from({ length: H }, (_, i) => addDays(labels[labels.length - 1], i + 1))];
    const lastTotal = [...s].reverse().find((x) => x.total != null)?.total ?? A.total;
    this.chartCard({ title: t().cTotal, desc: t().dTotalSelf(H), legend: [{ name: t().actual, cls: "line" }, { name: t().forecast, cls: "dash" }] }, () => {
      const o = baseOptions(P, this.plugin.motion(), { grow: false });
      o.scales.y.beginAtZero = false;
      o.scales.x.ticks.callback = dateTick;
      o.plugins.tooltip.callbacks = { label: (it: TI) => ` ${it.dataIndex > lastIdx ? t().forecast : t().hTotal} ${fmt(num(it.raw))}`, footer: this.releaseFooter([id]) };
      return {
        type: "line",
        data: { labels: fLabels, datasets: [{ ...lineDataset(P, [...s.map((x) => x.total), ...project(lastTotal, full.map((x) => x.daily), H)], color, true), label: name, segment: forecastSegment(lastIdx, color) }] },
        options: o, plugins: [forecastZone(P, lastIdx, A.next), wipe(this.plugin.motion()), crosshair(P), releaseMarkers(P, markers, false)],
      };
    });

    this.rankCard([id], false);

    if (versions.length) {
      const relDate = Object.fromEntries((store.releases[id] ?? []).map((r) => [r.version, r.date.slice(0, 10)]));
      this.chartCard({ title: t().cVersions, desc: t().dVersions(versions.length), height: Math.max(240, versions.length * 22 + 40) }, () => {
        const o = baseOptions(P, this.plugin.motion(), { indexAxis: "y" });
        o.plugins.tooltip.callbacks = { title: (it: TI[]) => "v" + it[0].label, label: (it: TI) => ` ${t().hTotal} ${fmt(num(it.raw))}`, afterLabel: (it: TI) => relDate[it.label] ? t().released2(relDate[it.label]) : "" };
        o.scales.y.ticks.callback = versionTick;
        o.scales.y.ticks.autoSkip = false;
        return {
          type: "bar",
          data: { labels: versions.map((v) => v.version), datasets: [{ data: versions.map((v) => v.total), backgroundColor: color, borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: "left", maxBarThickness: 16 }] },
          options: o,
        };
      });
    }

    const launches = launchesAll;
    if (launches.length) {
      const peak = launches.reduce((b, v, i) => !v.partial && (b < 0 || v.first3 > launches[b].first3) ? i : b, -1);
      this.chartCard({ title: t().cLaunch, desc: t().dLaunch, height: Math.max(240, launches.length * 22 + 40) }, () => {
        const o = baseOptions(P, this.plugin.motion(), { indexAxis: "y" });
        o.scales.y.ticks.callback = versionTick;
        o.scales.y.ticks.autoSkip = false;
        o.plugins.tooltip.callbacks = {
          title: (it: TI[]) => "v" + it[0].label,
          label: (it: TI) => { const v = launches[it.dataIndex]; return [t().launchBody(fmt(v.first3), fmt(v.total)) + (v.partial ? t().inProgress(v.days) : ""), t().firstSeen(v.first)]; },
        };
        return {
          type: "bar",
          data: { labels: launches.map((v) => v.version), datasets: [{ data: launches.map((v) => v.first3), backgroundColor: launches.map((v) => v.partial ? alpha(color, 0.4) : color),
            borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: "left", maxBarThickness: 16 }] },
          options: o,
          plugins: [peakLabel(P, peak, peak >= 0 ? t().best(fmt(launches[peak].first3)) : "")],
        };
      });
    }

    this.standingCard([id]);
    this.whenCard(A, color);
    this.journeyCard(A, name);
    this.tableCard([t().hDate, t().hTotal, t().hNew, t().hRank],
      [...full].reverse().filter((x) => x.total != null).map((x) => [x.date, fmt(x.total), x.daily == null ? "–" : signed(x.daily), x.rank ? fmt(x.rank) : "–"]));
  }

  // ---------- all of yours ----------
  private renderTotal() {
    const P = this.P, mine = this.plugin.settings.mine, store = this.plugin.store;
    const full = this.m.totalSeries(mine);
    const A = this.m.analyze(full.map((x) => ({ date: x.date, total: x.total, daily: x.daily, rank: null, gap: x.gap })));
    if (!A) { this.renderPending(mine[0]); return; }
    const s = this.clip(full);
    const versionCount = mine.reduce((n, id) => n + Object.keys(store.versions[id] ?? {}).length, 0);
    const stars = mine.reduce((n, id) => n + (store.repos[id]?.stars ?? 0), 0);
    this.renderHero({ name: t().allPlugins, A });
    this.syncOrrery(mine, null);
    this.insights(this.totalInsights(A));
    this.tiles([
      { label: t().tLast7, value: A.sum7, prefix: "+", sub: delta(A.momentum), spark: A.d.slice(-14).map((x) => x.daily) },
      { label: t().tLast30, value: this.m.gainOver(A.full, 30) ?? 0, prefix: "+", bars: full.slice(-30).map((x) => x.daily) },
      A.best && { label: t().tBest, value: A.best.daily, prefix: "+", sub: longDate(A.best.date) },
      { label: t().tPlugins, value: t().pluginsAndReleases(mine.length, versionCount), sub: t().tPluginsSub },
      Object.keys(store.repos).some((id) => mine.includes(id)) && { label: t().tStars, value: stars, sub: mine.map((id) => `${this.nameOf(id).split(" ").pop()} ${store.repos[id]?.stars ?? 0}`).join(" · ") },
    ]);

    const labels = s.map((x) => x.date);
    const legend = mine.map((id) => ({ name: this.nameOf(id), color: this.colorOf(id) }));
    const tick = dateTick;
    const H = this.horizon(), lastIdx = labels.length - 1;
    const fLabels = [...labels, ...Array.from({ length: H }, (_, i) => addDays(labels[labels.length - 1], i + 1))];
    const proj = Object.fromEntries(mine.map((id) => [id, project(s[s.length - 1].parts[id]?.total ?? 0, full.map((x) => x.parts[id]?.daily ?? null), H)]));
    this.chartCard({ title: t().cTotal, desc: t().dTotalStack(H), wide: true, tall: true, legend: [...legend, { name: t().forecast, cls: "dash" }] }, () => {
      const o = baseOptions(P, this.plugin.motion(), { stacked: true, grow: false });
      o.scales.x.ticks.callback = tick;
      o.plugins.tooltip.itemSort = (a: TI, b: TI) => b.datasetIndex - a.datasetIndex;
      o.plugins.tooltip.callbacks = {
        title: (it: TI[]) => it[0].label + (it[0].dataIndex > lastIdx ? t().forecastTitle : ""),
        label: (it: TI) => ` ${it.dataset.label ?? ""} ${fmt(num(it.raw))}`,
        footer: (items: TI[]) => [t().sumLine(fmt(items.reduce((n, it) => n + (num(it.raw) ?? 0), 0))), this.releaseFooter(mine)(items)].filter(Boolean),
      };
      return {
        type: "line",
        data: { labels: fLabels, datasets: mine.map((id, i) => {
          const c = this.colorOf(id);
          return { ...lineDataset(P, [...s.map((x) => x.parts[id]?.total ?? 0), ...proj[id]], c), label: this.nameOf(id), fill: i === 0 ? "origin" : "-1", backgroundColor: areaFill(c, 0.44, 0.19), segment: forecastSegment(lastIdx, c) };
        }) },
        options: o, plugins: [forecastZone(P, lastIdx, A.next), wipe(this.plugin.motion()), crosshair(P), releaseMarkers(P, this.markers(mine), false)],
      };
    });

    this.dailyChart({ labels, s, ids: mine, title: t().cDaily, desc: t().dDailyStack, legend,
      datasets: mine.map((id) => ({ label: this.nameOf(id), data: s.map((x, i) => (i === 0 && x.daily == null) ? null : x.parts[id]?.daily ?? null), backgroundColor: this.colorOf(id) })) });
    this.whenCard(A);
    this.journeyCard(A, t().allPlugins);
    this.rankCard(mine, true);
    this.standingCard(mine);
    this.tableCard([t().hDate, t().hSum, t().hNew, ...mine.map((id) => this.nameOf(id))],
      [...full].reverse().map((x) => [x.date, fmt(x.total), x.daily == null ? "–" : signed(x.daily), ...mine.map((id) => fmt(x.parts[id]?.total))]));
  }

  // ---------- several side by side (your plugins, or one plugin and its competitors) ----------
  private sideBySide(ids: string[], o: { smooth: boolean }) {
    const P = this.P;
    const all = ids.map((id) => ({ id, full: this.m.series(id) })).filter((x) => x.full.length);
    const age = this.ui.align === "age";
    const legend = all.map((a) => ({ name: this.nameOf(a.id), color: this.colorOf(a.id) }));
    let labels: (string | number)[];
    let pick: (full: Pt[], key: "total" | "daily") => (number | null)[];
    if (age) {
      const len = Math.max(...all.map((a) => a.full.length));
      const n = this.ui.range === "all" ? len : Math.min(len, +this.ui.range);
      labels = Array.from({ length: n }, (_, i) => i);
      pick = (full, key) => (labels as number[]).map((i) => full[i]?.[key] ?? null);
    } else {
      labels = this.datesFor(all.map((a) => a.id));
      pick = (full, key) => this.pick(full, labels as string[], key);
    }
    const tick = age ? dayTick : dateTick;
    const title = (it: TI[]) => age ? t().dayTitle(Number(it[0].label)) : it[0].label;
    const ageDesc = age ? t().dAge : t().dReleasesMarked;
    const smooth = (a: (number | null)[]) => a.map((_, i) => { const w = a.slice(Math.max(0, i - 6), i + 1).filter((v): v is number => v != null); return w.length >= 3 ? Math.round(mean(w) * 10) / 10 : null; });
    // Plugins far apart in size share a chart only on a log scale.
    const totals = all.map((a) => this.m.latest(a.id)?.downloads ?? 0).filter((v) => v > 0);
    const log = totals.length > 1 && Math.max(...totals) / Math.max(1, Math.min(...totals)) > 10;

    for (const [key, ttl, desc, val, tall] of [
      ["total", t().cTotal, t().dCompareTotal, fmt, true],
      ["daily", o.smooth ? t().cDailyMA : t().cDaily, o.smooth ? t().dRivalsDaily : t().dCompareDaily, o.smooth ? fmt1 : signed, false],
    ] as const) {
      this.chartCard({ title: ttl + (key === "total" && log ? ` · ${t().log}` : ""), desc: desc + ageDesc, wide: true, tall, legend }, () => {
        const op = baseOptions(P, this.plugin.motion(), { xTitle: age ? t().xAge : undefined, grow: false, log: key === "total" && log });
        op.layout = { padding: { right: key === "total" ? 152 : 0, top: 8 } };
        op.scales.x.ticks.callback = tick;
        op.plugins.tooltip.callbacks = { title, label: (it: TI) => ` ${it.dataset.label ?? ""} ${val(num(it.raw))}`, footer: age ? undefined : this.releaseFooter(ids) };
        op.plugins.tooltip.itemSort = (a: TI, b: TI) => (num(b.raw) ?? -1) - (num(a.raw) ?? -1);
        return {
          type: "line",
          data: { labels, datasets: all.map((a) => {
            const raw = pick(a.full, key);
            return { ...lineDataset(P, key === "daily" && o.smooth ? smooth(raw) : raw, this.colorOf(a.id)), label: this.nameOf(a.id) };
          }) },
          options: op, plugins: [wipe(this.plugin.motion()), crosshair(P), ...(key === "total" ? [endLabels(P, fmt, 152)] : []), ...(age ? [] : [releaseMarkers(P, this.markers(ids), false)])],
        };
      });
    }
  }

  private renderCompare() {
    const mine = this.plugin.settings.mine, store = this.plugin.store;
    const total = this.m.totalSeries(mine);
    const A = this.m.analyze(total.map((x) => ({ date: x.date, total: x.total, daily: x.daily, rank: null, gap: x.gap })));
    this.renderHero({ name: t().allPlugins, A });
    this.syncOrrery(mine, null);
    if (A) this.insights(this.totalInsights(A).filter((x) => [t().kLead, t().kRank, t().kStart].includes(x.k)));
    // The last 14 days on one shared scale, so both shape and size compare.
    this.tiles(this.groupTiles(mine), 8);
    this.sideBySide(mine, { smooth: false });
    this.rankCard(mine, true);
    this.standingCard(mine);

    const rows = mine.map((id) => {
      const full = this.m.series(id), latest = this.m.latest(id), a = this.m.analyze(full), st = this.m.standing(id);
      const vs = Object.keys(store.versions[id] ?? {}).sort(semverCmp);
      return [`§${this.colorOf(id)}§${this.nameOf(id)}`, fmt(latest?.downloads), signed(this.m.gainOver(full, 7)), delta(a?.momentum) || "–", signed(this.m.gainOver(full, 30)),
        full.length && latest ? fmt1(latest.downloads / full.length) : "–", st ? t().rankTick(fmt(st.rank)) : "–",
        vs.length ? "v" + vs[vs.length - 1] : "–", fmt(vs.length), fmt(store.repos[id]?.stars), full[0]?.date ?? "–"];
    });
    if (A && total.length) rows.push([`**${t().hSum}**`, `**${fmt(A.total)}**`, signed(this.m.gainOver(A.full, 7)), delta(A.momentum) || "–", signed(this.m.gainOver(A.full, 30)),
      fmt1(A.total / total.length), "–", "–", fmt(mine.reduce((n, id) => n + Object.keys(store.versions[id] ?? {}).length, 0)), fmt(mine.reduce((n, id) => n + (store.repos[id]?.stars ?? 0), 0)), total[0].date]);
    this.tableCard([t().hPlugin, t().hTotal, t().h7, t().hMomentum, t().h30, t().hPerDay, t().hRank, t().hLatest, t().hVersions, t().hStars, t().hFirst], rows, t().cSummary, t().dSummary, true);
  }

  private groupTiles(ids: string[]): Tile[] {
    const days = this.datesFor(ids).slice(-14);
    const dailyOf = (full: Pt[]) => this.pick(full, days, "daily");
    const barMax = sharedMax(ids.map((id) => dailyOf(this.m.series(id))));
    return ids.filter((id) => this.m.series(id).length).map((id) => {
      const full = this.m.series(id), a = this.m.analyze(full);
      return { label: this.nameOf(id), color: this.colorOf(id), value: this.m.latest(id)?.downloads ?? 0,
        sub: `${t().h7} ${signed(a?.sum7)} ${delta(a?.momentum)} · ${t().h30} ${signed(this.m.gainOver(full, 30))}`, bars: dailyOf(full), barMax: barMax ?? undefined };
    });
  }

  // ---------- one plugin against its competitors ----------
  private renderRivals(me: string, rivals: string[]) {
    const P = this.P, store = this.plugin.store;
    const group = [me, ...rivals].filter((id) => this.m.series(id).length);
    const A = this.m.analyze(this.m.series(me)) as Analysis;
    const sums = new Map(group.map((id) => [id, this.m.analyze(this.m.series(id))?.sum7 ?? 0]));
    const sumAll = [...sums.values()].reduce((n, x) => n + x, 0);
    const byTotal = [...group].sort((a, b) => (this.m.latest(b)?.downloads ?? 0) - (this.m.latest(a)?.downloads ?? 0));
    this.renderHero({ name: this.nameOf(me), color: this.colorOf(me), A, id: me,
      line: group.length > 1 ? t().groupLine(byTotal.indexOf(me) + 1, group.length, sumAll ? pct1((sums.get(me) ?? 0) / sumAll) : "–") : undefined });
    this.syncOrrery(group, me);
    if (group.length < 2) {
      const card = this.els.body.createDiv({ cls: "pp-card pp-empty" });
      card.createEl("p", { text: t().rivalsNoData });
      return;
    }
    this.insights(this.rivalInsights(me, group), 6, []);
    this.tiles(this.groupTiles(group), 9);
    this.sideBySide(group, { smooth: true });

    // Share of the group's new downloads, over a rolling 7 days.
    const labels = this.datesFor(group);
    const daily = new Map(group.map((id) => [id, new Map(this.m.series(id).map((x) => [x.date, x.daily ?? 0]))]));
    const roll = (id: string, d: string) => { let n = 0; for (let k = 0; k < 7; k++) n += daily.get(id)?.get(addDays(d, -k)) ?? 0; return n; };
    const shares = group.map((id) => labels.map((d) => {
      const tot = group.reduce((n, x) => n + roll(x, d), 0);
      return tot > 0 ? Math.round(roll(id, d) / tot * 1000) / 10 : null;
    }));
    this.chartCard({ title: t().cShare, desc: t().dShare, wide: true, legend: group.map((id) => ({ name: this.nameOf(id), color: this.colorOf(id) })) }, () => {
      const o = baseOptions(P, this.plugin.motion(), { stacked: true, grow: false });
      o.scales.y.max = 100;
      o.scales.y.ticks.callback = (v) => v + "%";
      o.scales.x.ticks.callback = dateTick;
      o.plugins.tooltip.itemSort = (a: TI, b: TI) => b.datasetIndex - a.datasetIndex;
      o.plugins.tooltip.callbacks = { label: (it: TI) => ` ${it.dataset.label ?? ""} ${fmt1(num(it.raw))}%` };
      return {
        type: "line",
        data: { labels, datasets: group.map((id, i) => ({ ...lineDataset(P, shares[i], this.colorOf(id)), label: this.nameOf(id), fill: i === 0 ? "origin" : "-1", backgroundColor: alpha(this.colorOf(id), id === me ? 0.55 : 0.28), borderWidth: id === me ? 2 : 1 })) },
        options: o, plugins: [wipe(this.plugin.motion()), crosshair(P)],
      };
    });

    this.rankCard(group, true);
    this.releasesCard(group, labels);
    this.standingCard(group);

    const today = todayUtc();
    const rows = group.map((id) => {
      const full = this.m.series(id), latest = this.m.latest(id), a = this.m.analyze(full), st = this.m.standing(id);
      const race = id === me ? null : this.m.race(me, id);
      const rel = [...(store.releases[id] ?? [])].sort((x, y) => y.date.localeCompare(x.date));
      const cad = this.m.cadence(id);
      const upd = store.updated[id];
      const name = this.nameOf(id) + (id === me ? ` (${t().you})` : "");
      return [`§${this.colorOf(id)}§${name}`, fmt(latest?.downloads), signed(a?.sum7), delta(a?.momentum) || "–", signed(this.m.gainOver(full, 30)),
        a ? fmt1(mean(a.d.slice(-14).map((x) => x.daily))) : "–", st ? t().rankTick(fmt(st.rank)) : "–",
        race ? signed(race.gap) : "–", race?.days == null ? "–" : race.gap > 0 ? "~" + t().daysN(fmt(race.days)) : `{down|${t().caughtIn(fmt(race.days))}}`,
        rel[0] ? "v" + rel[0].version : "–", upd ? t().ago(Math.max(0, dayDiff(new Date(upd).toISOString().slice(0, 10), today))) : "–",
        cad != null ? t().daysN(fmt1(cad)) : "–", fmt(store.repos[id]?.stars), full[0]?.date ?? "–"];
    });
    this.tableCard([t().hPlugin, t().hTotal, t().h7, t().hMomentum, t().h30, t().hPerDay, t().hRank, t().hGap, t().hEta, t().hLatest, t().hUpdated, t().hCadence, t().hStars, t().hFirst],
      rows, t().cSummary, t().dSummary, true);
  }

  private releasesCard(ids: string[], labels: string[]) {
    const store = this.plugin.store;
    if (!labels.length || !ids.some((id) => store.releases[id]?.length)) return;
    const from = labels[0], to = labels[labels.length - 1], span = Math.max(1, dayDiff(from, to));
    this.domCard({ title: t().cReleases, desc: t().dReleases, wide: true }, (el) => {
      const box = el.createDiv({ cls: "pp-releases" });
      for (const id of ids) {
        const row = box.createDiv({ cls: "pp-rel-row" });
        const name = row.createDiv({ cls: "pp-rel-name" });
        swatch(name, this.colorOf(id));
        name.appendText(this.nameOf(id));
        const track = row.createDiv({ cls: "pp-rel-track" });
        const rel = (store.releases[id] ?? []).filter((r) => r.date.slice(0, 10) >= from && r.date.slice(0, 10) <= to);
        for (const r of rel) {
          const tick = track.createDiv({ cls: "pp-rel-tick" });
          tick.setCssProps({ "--pp-c": this.colorOf(id) });
          tick.setCssStyles({ left: dayDiff(from, r.date.slice(0, 10)) / span * 100 + "%" });
          this.tip.bind(tick, `**${this.nameOf(id)} v${r.version}**\n${longDate(r.date.slice(0, 10))}`);
        }
        row.createDiv({ cls: "pp-rel-n", text: String(rel.length) });
      }
      const axis = box.createDiv({ cls: "pp-rel-axis" });
      axis.createSpan({ text: shortDate(from) });
      axis.createSpan({ text: shortDate(to) });
    });
  }

  // ---------- insights ----------
  private baseInsights(A: Analysis): Insight[] {
    const out: Insight[] = [];
    const push = (k: string, tt: string, b: string) => out.push({ k, t: tt, b });
    if (A.last && A.avgPrev != null) {
      const r = A.ratio ?? 1, v = signed(A.last.daily);
      const head = A.lastRank === 1 && A.d.length > 7 ? t().bestDay(v) : r >= 1.15 ? t().usualTimes(fmt1(r), v) : r <= 0.85 ? t().quietDay(v) : t().usualDay(v);
      push(t().kLatest, head, t().latestBody(longDate(A.last.date), signed(A.avgPrev), A.d.length, A.lastRank ?? 0) +
        (A.lastRank !== 1 && A.best ? t().latestBest(longDate(A.best.date), signed(A.best.daily)) : ""));
    }
    if (A.momentum != null) push(t().kMomentum, t().momentumHead(signed(A.sum7), delta(A.momentum)), t().momentumBody(signed(A.sum7), signed(A.sumBefore7), fmt1(A.pace)));
    if (A.next && A.etaDate && A.etaDays != null) push(t().kNext, t().nextHead(fmt(A.next), fmt(A.next - A.total)), t().nextBody(fmt1(A.pace), longDate(A.etaDate), A.etaDays));
    if (A.doubleDays != null && A.doubleDays > 0) push(t().kGrowth, t().doubled(A.doubleDays), t().doubledBody(longDate(addDays(A.lastDate, -A.doubleDays)), fmt(A.total / 2)) + (A.streak >= 5 ? t().streak(A.streak) : ""));
    return out;
  }

  private weekdayInsight(A: Analysis): Insight | null {
    if (!A.weekdayReady) return null;
    const w = A.weekday.filter((x) => x.avg != null) as { i: number; avg: number; n: number }[];
    if (!w.length) return null;
    const hi = w.reduce((b, x) => x.avg > b.avg ? x : b), lo = w.reduce((b, x) => x.avg < b.avg ? x : b);
    if (hi.avg <= 0) return null;
    const W = t().weekdays;
    return { k: t().kWeekday, t: t().weekdayHead(W[hi.i]), b: t().weekdayBody(fmt1(hi.avg), W[lo.i], fmt1(lo.avg), lo.avg > 0 ? t().timesX(fmt1(hi.avg / lo.avg)) : t().farAbove) };
  }

  private totalInsights(A: Analysis): Insight[] {
    const out = this.baseInsights(A), mine = this.plugin.settings.mine;
    if (mine.length > 1) {
      const parts = mine.map((id) => ({ id, a: this.m.analyze(this.m.series(id)) })).filter((x): x is { id: string; a: Analysis } => !!x.a);
      const sum7 = parts.reduce((n, x) => n + x.a.sum7, 0);
      const lead = parts.reduce<typeof parts[number] | null>((b, x) => !b || x.a.sum7 > b.a.sum7 ? x : b, null);
      if (lead && sum7 > 0) out.push({ k: t().kLead, t: t().leadHead(this.nameOf(lead.id), Math.round(lead.a.sum7 / sum7 * 100)), b: parts.map((x) => `${this.nameOf(x.id)} ${signed(x.a.sum7)}`).join(" · ") });
      const st = mine.map((id) => this.m.standing(id)).filter((s): s is NonNullable<typeof s> => s?.climbed7 != null);
      const climber = st.reduce<typeof st[number] | null>((b, s) => !b || (s.climbed7 as number) > (b.climbed7 as number) ? s : b, null);
      if (climber && (climber.climbed7 as number) > 0) out.push({ k: t().kRank, t: t().climbedHead(this.nameOf(climber.id), fmt(climber.climbed7)), b: st.map((s) => t().rankOf(this.nameOf(s.id), fmt(s.rank))).join(" · ") + t().ofAll(fmt(climber.of)) });
      const ages = parts.map((x) => x.a.full.length), n = Math.min(...ages);
      if (n >= 3 && Math.max(...ages) > n) {
        const at = parts.map((x) => ({ id: x.id, v: x.a.full[n - 1]?.total ?? 0 })).sort((a, b) => b.v - a.v);
        const ratio = at[1].v > 0 ? fmt1(at[0].v / at[1].v) : "";
        out.push({ k: t().kStart, t: t().fastestStart(this.nameOf(at[0].id)), b: t().startBody(n, at.map((x) => `${this.nameOf(x.id)} ${fmt(x.v)}`).join(" · "), ratio) });
      }
    }
    const wd = this.weekdayInsight(A);
    if (wd) out.push(wd);
    return out;
  }

  private pluginInsights(id: string, A: Analysis): Insight[] {
    const out = this.baseInsights(A);
    const s = this.m.standing(id);
    if (s) out.push({ k: t().kOverall, t: t().overallHead(fmt(s.rank), fmt1(s.topPct)), b: [
      s.climbed7 && s.climbed7 > 0 ? t().climbed7(fmt(s.climbed7)) : s.climbed7 && s.climbed7 < 0 ? t().fell7(fmt(-s.climbed7)) : "",
      s.need100 && s.need100 > 0 ? t().need100(signed(s.need100)) : "",
      s.band && s.needBand ? t().needBand(s.band, signed(s.needBand)) : "",
    ].filter(Boolean).join(" · ") || t().topPct(fmt1(s.topPct)) });
    const launches = this.m.launches(id).filter((v) => v.known && !v.partial);
    const bestV = launches.reduce<typeof launches[number] | null>((b, v) => !b || v.first3 > b.first3 ? v : b, null);
    if (bestV) {
      const cad = this.m.cadence(id);
      out.push({ k: t().kRelease, t: t().bestLaunch(bestV.version), b: t().launchBody(fmt(bestV.first3), fmt(bestV.total)) + (cad != null ? t().everyDays(fmt1(cad)) : "") });
    }
    const imp = this.m.releaseImpact(id, A.full)[0];
    if (imp && imp.before > 0) out.push({ k: t().kEffect, t: `v${imp.version} ${delta(imp.after / imp.before - 1)}`, b: t().effectBody(fmt1(imp.before), fmt1(imp.after), longDate(imp.date)) });
    const wd = this.weekdayInsight(A);
    if (wd) out.push(wd);
    return out;
  }

  private rivalInsights(me: string, group: string[]): Insight[] {
    const out: Insight[] = [];
    const an = new Map(group.map((id) => [id, this.m.analyze(this.m.series(id)) as Analysis]));
    const mine = an.get(me) as Analysis;
    const sum7 = group.reduce((n, id) => n + (an.get(id)?.sum7 ?? 0), 0);
    if (sum7 > 0) out.push({ k: t().kShare, t: t().shareHead(pct1(mine.sum7 / sum7)), b: group.map((id) => `${this.nameOf(id)} ${signed(an.get(id)?.sum7)}`).join(" · ") });

    const others = group.filter((id) => id !== me);
    const above = others.filter((id) => (an.get(id)?.total ?? 0) > mine.total).sort((a, b) => (an.get(a)?.total ?? 0) - (an.get(b)?.total ?? 0));
    if (above.length) {
      const id = above[0], r = this.m.race(me, id);
      if (r) out.push({ k: t().kOvertake, t: r.days != null ? t().overtakeHead(this.nameOf(id), r.days) : t().overtakeAway(this.nameOf(id)), b: t().overtakeBody(fmt(r.gap), fmt1(r.myPace), fmt1(r.theirPace)) });
    } else {
      const second = [...others].sort((a, b) => (an.get(b)?.total ?? 0) - (an.get(a)?.total ?? 0))[0];
      if (second) out.push({ k: t().kOvertake, t: t().topOfGroup, b: t().topBody(this.nameOf(second), fmt(mine.total - (an.get(second)?.total ?? 0))) });
    }

    const chasers = others.filter((id) => (an.get(id)?.total ?? 0) <= mine.total)
      .map((id) => ({ id, r: this.m.race(me, id) })).filter((x) => x.r?.days != null).sort((a, b) => (a.r?.days ?? 0) - (b.r?.days ?? 0));
    if (chasers.length) {
      const c = chasers[0], r = c.r as NonNullable<typeof c.r>;
      out.push({ k: t().kChaser, t: t().chaserHead(this.nameOf(c.id), r.days as number), b: t().chaserBody(fmt(-r.gap), fmt1(r.myPace), fmt1(r.theirPace)) });
    } else if (others.some((id) => (an.get(id)?.total ?? 0) <= mine.total)) {
      out.push({ k: t().kChaser, t: t().chaserSafe, b: others.map((id) => `${this.nameOf(id)} ${fmt(an.get(id)?.total)}`).join(" · ") });
    }

    const growth = group.map((id) => { const a = an.get(id); return { id, g: a && a.total - a.sum7 > 0 ? a.sum7 / (a.total - a.sum7) : 0 }; }).sort((a, b) => b.g - a.g);
    if (growth[0]?.g > 0) out.push({ k: t().kFastest, t: t().fastestHead(this.nameOf(growth[0].id), pct1(growth[0].g)), b: t().fastestBody + "\n" + growth.map((x) => `${this.nameOf(x.id)} +${pct1(x.g)}`).join(" · ") });

    // Same age: only plugins whose history starts at their listing, not at the archive's first day.
    const age = mine.full.length;
    const peers = group.filter((id) => { const s = this.m.series(id); return s.length >= age && s[0].date > ARCHIVE_EPOCH; });
    if (peers.length > 1 && mine.full[0].date > ARCHIVE_EPOCH) {
      const at = peers.map((id) => ({ id, v: [...this.m.series(id).slice(0, age)].reverse().find((x) => x.total != null)?.total ?? 0 })).sort((a, b) => b.v - a.v);
      out.push({ k: t().kSameAge, t: t().sameAgeHead(age, at.findIndex((x) => x.id === me) + 1, at.length), b: t().sameAgeBody(at.map((x) => `${this.nameOf(x.id)} ${fmt(x.v)}`).join(" · ")) });
    }

    const cads = others.map((id) => this.m.cadence(id)).filter((x): x is number => x != null).sort((a, b) => a - b);
    const myCad = this.m.cadence(me);
    if (cads.length || myCad != null) {
      const median = cads.length ? t().daysN(fmt1(cads[Math.floor(cads.length / 2)])) : "–";
      out.push({ k: t().kCadence, t: myCad != null ? t().cadenceHead(fmt1(myCad), median) : t().cadenceNone, b: t().cadenceBody });
    }
    return out;
  }
}
