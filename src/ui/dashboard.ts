import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type PulsePlugin from "../main";
import { Model, SMALL_BASE, mean, semverCmp, weekdayOf, type Analysis, type Momentum, type Pt } from "../analysis";
import { addDays, dayDiff, todayUtc } from "../data/store";
import { loc, t } from "../i18n";
import type { Basis, Range, UiState } from "../types";
import {
  Chart, makeChart, readPalette, baseOptions, wipe, crosshair, endLabels, releaseMarkers, forecastZone, forecastBand, peakLabel,
  areaFill, lineDataset, forecastSegment, project, num, dateTick, versionTick, dayTick,
  type Palette, type Marker, type Cfg, type Ds, type TI,
} from "./charts";
import { Orrery } from "./orrery";
import { fmt, fmt1, signed, delta, moText, moTip, shortDate, longDate, rich, Tip, Revealer, countUp, sparkline, sparkBars, swatch, alpha, rgba, pct1, sharedMax } from "./util";
import { authorSearch } from "./modals";
import { breakdownCard, dateSpan, impactCard, ladderCard, monthlyCard, outlookCard, raceCard, recordsCard, scoreCard, streamCard } from "./cards";

export const DASHBOARD_VIEW = "plugin-pulse-dashboard";

/** First day of the public archive; a series starting then began before the archive did, so its age is unknown. */
const ARCHIVE_EPOCH = "2020-10-31";

interface Insight { k: string; t: string; b: string }
interface Tile { label: string; color?: string; value: number | string; prefix?: string; pre?: string; unit?: string; sub?: string; spark?: (number | null)[]; bars?: (number | null)[]; barMax?: number; avg?: [number, number]; tip?: string }
/** A table cell: its text, what it sorts by (higher first; text A→Z) and a tooltip, or a renderer of its own. */
interface Cell { text: string; sort?: number | string | null; tip?: string; render?: (td: HTMLElement) => void }
type Row = (string | Cell)[];
/** `lede`: one sentence under the title saying what to look at (rich text). */
interface CardOpts { title: string; desc?: string; lede?: string; wide?: boolean; tall?: boolean; height?: number; legend?: { name: string; color?: string; cls?: string }[] | null }

export class DashboardView extends ItemView {
  tip!: Tip;
  private revealer!: Revealer;
  private charts: Chart[] = [];
  private orrery: Orrery | null = null;
  P!: Palette;
  m!: Model;
  private colors = new Map<string, string>();
  private observers: ResizeObserver[] = [];
  /** Where each segmented control's highlight was, so a rebuilt control slides from there. */
  private thumbs = new Map<string, { x: number; y: number; w: number; h: number }>();
  private els!: { root: HTMLElement; live: HTMLElement; liveDot: HTMLElement; liveText: HTMLElement; refresh: HTMLElement; motion: HTMLElement; controls: HTMLElement; hero: HTMLElement; heroKicker: HTMLElement; heroNum: HTMLElement & { _val?: number }; heroLine: HTMLElement; heroChips: HTMLElement; heroMs: HTMLElement; body: HTMLElement };

  constructor(leaf: WorkspaceLeaf, readonly plugin: PulsePlugin) { super(leaf); }

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
    btn("file-text", t().cmdReport, () => void this.plugin.writeReport());
    btn("image", t().share, () => this.plugin.openShare());
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
    void this.plugin.engine.refreshIfStale();
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
    liveText.setText(s.state === "loading" ? t().checking : s.state === "offline" ? t().offline : s.state !== "idle" && time ? t().checkedAt(time) + " · " + this.nextText() : "");
    const notes = s.detail?.split("\n").map((n) => n === "github-limit" ? t().githubLimit : n).join("\n");
    this.tip.bind(live, [s.state === "partial" ? t().partial : "", notes ?? ""].filter(Boolean).join("\n") || t().refresh, false);
  }

  /** When Obsidian's next file is due, in local time: "next update ~9:40", tomorrow's marked, a late one says so. */
  private nextText(): string {
    const at = this.plugin.engine.nextPublish(), now = Date.now();
    if (at <= now) return t().nextLate;
    const d = new Date(at), time = d.toLocaleTimeString(loc(), { hour: "numeric", minute: "2-digit" });
    return t().nextAt(time, d.toDateString() !== new Date(now).toDateString());
  }

  setView(view: string, mode?: UiState["mode"]): void {
    this.ui.view = view;
    if (mode) this.ui.mode = mode;
    void this.plugin.saveSettings();
    this.render();
  }

  // ---------- data helpers ----------
  nameOf(id: string): string { return this.plugin.settings.meta[id]?.name ?? id; }
  colorOf(id: string): string { return this.colors.get(id) ?? this.P.ink2; }
  private assignColors(ids: string[]) {
    this.colors.clear();
    const S = this.P.series, mine = this.plugin.settings.mine;
    mine.forEach((id, i) => this.colors.set(id, S[i % S.length]));
    // Competitors take, in order, the colors no tab is showing; then those nothing on screen uses; past that,
    // a faded copy, so two lines never look the same.
    const shown = new Set(ids.filter((x) => this.colors.has(x)).map((x) => this.colors.get(x)));
    const tabs = new Set(mine.map((x) => this.colors.get(x)));
    const free = S.filter((x) => !tabs.has(x));
    let extra = 0;
    for (const id of ids) {
      if (this.colors.has(id)) continue;
      const c = S.find((x) => !shown.has(x) && !tabs.has(x)) ?? S.find((x) => !shown.has(x));
      const pick = c ?? this.blend((free.length ? free : S)[extra++ % (free.length || S.length)], this.P.surface);
      shown.add(pick);
      this.colors.set(id, pick);
    }
  }
  /** A color a third of the way to the background, opaque — so charts that add their own transparency still tell it apart. */
  private blend(c: string, bg: string): string {
    const [r, g, b] = rgba(c), [R, G, B] = rgba(bg), mix = (x: number, y: number) => Math.round(x * 0.62 + y * 0.38);
    return `rgb(${mix(r, R)}, ${mix(g, G)}, ${mix(b, B)})`;
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
    const s = this.plugin.settings, mine = s.mine;
    this.m = new Model(this.plugin.store, "official", mine);
    // Bots-excluded numbers once there are a few split days; competitor pages stay official.
    const rivalsPage = mine.includes(this.ui.view) && this.ui.mode === "rivals" && (s.competitors[this.ui.view] ?? []).length > 0;
    this.canSplit = this.m.canSplit(mine);
    if (this.canSplit && this.ui.basis === "human" && !rivalsPage) this.m = this.m.withBasis("human");

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

  /** Whether any of your plugins has enough days to tell bots apart. */
  private canSplit = false;
  private human(): boolean { return this.m.basis === "human"; }

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
    if (this.canSplit && !(s.mine.includes(view) && this.ui.mode === "rivals" && rivalCount > 0)) {
      const b = this.seg(row2, [{ key: "official", label: t().basisOfficial }, { key: "human", label: t().basisHuman }], this.ui.basis, (k) => {
        this.ui.basis = k as Basis; void this.plugin.saveSettings(); this.render();
      }, t().basisOfficial);
      this.tip.bind(b, t().basisTip, false);
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
    if (this.human()) this.tip.bind(heroKicker.createSpan({ cls: "pp-basis-tag", text: t().basisHuman }), t().basisTip);
    countUp(heroNum, A?.total ?? 0, this.plugin.motion(), { from: heroNum._val ?? 0, dur: 1600 });
    heroLine.empty(); heroChips.empty(); heroMs.empty();
    if (!A) return;
    const gone = scope.id ? this.m.delisted(scope.id) : null;
    if (gone) {
      // Its total stopped at the last file that had it; main.js downloads still show whether people install it.
      const ins = this.m.installsSince(scope.id as string, gone.since);
      rich(heroLine, `{down|${t().delistedLine(longDate(gone.date), fmt(gone.last))}}` + (ins ? " · " + t().installsSince(longDate(ins.from), signed(ins.gain)) : ""));
    } else if (scope.line) rich(heroLine, scope.line);
    else if (A.last) {
      const day = signed(A.last.daily);
      const record = A.lastRank === 1 && A.d.length > 7;
      const extra = record ? t().allTimeBest : A.ratio != null && A.ratio >= 1.15 ? t().timesUsual(fmt1(A.ratio)) : A.ratio != null && A.ratio <= 0.85 ? t().quieter : "";
      rich(heroLine, t().latestDay(day) + (extra ? " · " + extra : "") + (A.last.gap ? t().missedDay : ""));
    }
    const chip = rich(heroChips.createSpan({ cls: "pp-chip" }), `${t().days7} **${signed(A.sum7)}** ${moText(A.mo)}`);
    this.tip.bind(chip, moTip(A.mo, A));
    if (scope.id) {
      const st = this.m.standing(scope.id);
      if (st) rich(heroChips.createSpan({ cls: "pp-chip" }), `**${t().rankChip(fmt(st.rank))}**` + (st.climbed7 && st.climbed7 > 0 ? ` {up|▲ ${fmt(st.climbed7)}}` : ""));
    }
    if (A.next) {
      const pct = Math.max(2, Math.min(100, (A.total - A.prevM) / (A.next - A.prevM) * 100));
      const head = heroMs.createDiv({ cls: "pp-ms-head" });
      rich(head.createSpan(), t().msTo(fmt(A.next), fmt(A.next - A.total)));
      const r = gone ? null : this.m.eta(A);
      const when = head.createSpan({ text: r ? dateSpan(addDays(A.lastDate, r.lo), r.hi != null ? addDays(A.lastDate, r.hi) : null) : A.etaDate && !gone ? t().around(longDate(A.etaDate)) : "" });
      if (A.etaDate && !gone) this.tip.bind(when, t().etaTip(fmt1(A.pace), longDate(A.etaDate)));
      const track = heroMs.createDiv({ cls: "pp-ms-track", attr: { role: "progressbar", "aria-valuemin": String(A.prevM), "aria-valuemax": String(A.next), "aria-valuenow": String(A.total) } });
      // A still bar: no fill animation, just where it stands.
      track.createDiv({ cls: "pp-ms-fill" }).setCssStyles({ width: pct + "%" });
    }
  }

  private syncOrrery(ids: string[], focus: string | null) {
    this.orrery?.sync(ids.map((id) => {
      const a = this.m.analyze(this.m.series(id));
      return { id, name: this.nameOf(id), total: a?.total ?? 0, daily: a?.last?.daily ?? 0, pace: a?.pace ?? 0, sum7: a?.sum7 ?? 0, color: this.colorOf(id),
        rank: this.m.standing(id)?.rank ?? null, stars: this.plugin.store.repos[id]?.stars ?? 0 };
    }), focus, ids.some((id) => !this.plugin.settings.mine.includes(id)) ? t().groupTotal : t().allTotal);
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
      if (x.tip) this.tip.bind(d, x.tip);
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
      if (x.bars) sparkBars(d, x.bars, x.color || this.P.ink2, x.barMax, x.avg);
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
    const el = g.createEl("section", { cls: "pp-card" + (o.wide ? " is-wide" : "") + (o.lede ? " has-lede" : "") });
    const h = el.createEl("h2", { text: o.title });
    if (o.desc) this.tip.bind(h, o.desc);
    if (o.lede) rich(el.createEl("p", { cls: "pp-lede" }), o.lede);
    if (o.legend) {
      const lg = el.createDiv({ cls: "pp-legend" });
      for (const l of o.legend) {
        const s = lg.createSpan();
        if (l.cls) s.createSpan({ cls: "pp-legend-" + l.cls }); else swatch(s, l.color ?? this.P.ink2);
        rich(s, l.name);
      }
    }
    return el;
  }

  chartCard(o: CardOpts, build: () => Cfg): HTMLElement {
    const el = this.card(o);
    const box = el.createDiv({ cls: "pp-chart" + (o.tall ? " is-tall" : "") });
    if (o.height) box.setCssStyles({ height: o.height + "px" });
    const cv = box.createEl("canvas", { attr: { role: "img", "aria-label": o.title } });
    this.revealer.add(el, this.grid().childElementCount % 2, () => { this.charts.push(makeChart(cv, build())); });
    return el;
  }

  domCard(o: CardOpts, fill: (el: HTMLElement) => (() => void) | void): HTMLElement {
    const el = this.card(o);
    const after = fill(el);
    // Targets are set a frame after the card appears, so bars and dots move into place.
    this.revealer.add(el, this.grid().childElementCount % 2, () => { if (after) window.requestAnimationFrame(after); });
    return el;
  }

  /** How each sortable table was last sorted, so a refresh keeps it. */
  private sorts = new Map<string, { col: number; dir: 1 | -1 }>();

  /**
   * `o.sort` makes the columns whose cells carry sort keys sortable by clicking their header, starting at `col`.
   * Numbers sort high to low first, text A to Z; empty keys stay last either way. `o.foot` is a row kept at the bottom.
   */
  private tableCard(head: string[], rows: Row[], title?: string, desc?: string, open = false, o: { sort?: { key: string; col: number }; foot?: Row; headTips?: Record<number, string> } = {}) {
    const el = this.grid().createEl("section", { cls: "pp-card is-wide" });
    let host: HTMLElement = el;
    if (title) {
      const h = el.createEl("h2", { text: title });
      if (desc) this.tip.bind(h, desc);
    }
    const keyOf = (r: Row, i: number) => { const c = r[i]; return typeof c === "string" ? undefined : c?.sort; };
    const sortable = head.map((_, i) => !!o.sort && rows.some((r) => keyOf(r, i) != null));
    const fill = (row: HTMLElement, r: Row) => r.forEach((c, i) => {
      const td = row.createEl("td");
      const cell: Cell = typeof c === "string" ? { text: c } : c;
      if (cell.render) cell.render(td);
      else if (i === 0 && cell.text.startsWith("§")) { const [, color, name] = cell.text.split("§"); swatch(td, color); td.appendText(name); }
      else rich(td, cell.text);
      if (cell.tip) this.tip.bind(td, cell.tip, false);
    });
    const build = () => {
      const scroll = host.createDiv({ cls: "pp-table-scroll" });
      const table = scroll.createEl("table");
      const tr = table.createEl("thead").createEl("tr");
      const tb = table.createEl("tbody");
      const tf = o.foot ? table.createEl("tfoot") : null;
      const state = o.sort ? (this.sorts.get(o.sort.key) ?? { col: o.sort.col, dir: -1 }) : null;
      const ths = head.map((h, i) => {
        const th = tr.createEl("th");
        if (o.headTips?.[i]) this.tip.bind(th, o.headTips[i], !sortable[i]);
        if (!sortable[i]) { th.setText(h); return th; }
        const b = th.createEl("button", { cls: "pp-sort", text: h, attr: { type: "button", "aria-label": t().sortBy(h) } });
        b.addEventListener("click", () => {
          if (!state || !o.sort) return;
          const text = rows.some((r) => typeof keyOf(r, i) === "string");
          state.dir = state.col === i ? (-state.dir as 1 | -1) : text ? 1 : -1;
          state.col = i;
          this.sorts.set(o.sort.key, state);
          draw();
        });
        return th;
      });
      const draw = () => {
        tb.empty();
        let list = rows;
        if (state) {
          list = [...rows].sort((a, b) => {
            const x = keyOf(a, state.col), y = keyOf(b, state.col);
            if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
            const cmp = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y), loc()) : x - y;
            return cmp * state.dir;
          });
          ths.forEach((th, i) => {
            if (!sortable[i]) return;
            th.setAttr("aria-sort", i === state.col ? (state.dir > 0 ? "ascending" : "descending") : "none");
            th.toggleClass("is-sorted", i === state.col);
          });
        }
        for (const r of list) fill(tb.createEl("tr"), r);
      };
      draw();
      if (tf && o.foot) fill(tf.createEl("tr"), o.foot);
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

  /** main.js downloads: Obsidian fetches it only to install or update, so the count leaves out update checks and stats bots. */
  private installsTile(ids: string[], official: number, color?: string): Tile | null {
    const x = this.m.installs(ids);
    if (!x) return null;
    return { label: t().tInstalls, value: x.total, color, sub: x.pace != null ? t().installsPace(fmt1(x.pace)) : t().installsFrom(longDate(x.date)),
      tip: t().installsTip(official > 0 ? Math.round(x.total / official * 100) + "%" : "–") + (x.pace != null ? "\n" + t().installsVs(x.span, fmt(x.prev)) : "") };
  }

  /** The first insight when your plugins dropped out of the official file: what stopped, since when, and where to look. */
  private delistedInsight(ids: string[]): Insight | null {
    const gone = ids.map((id) => ({ id, d: this.m.delisted(id) })).filter((x): x is { id: string; d: NonNullable<typeof x.d> } => !!x.d);
    if (!gone.length) return null;
    const lines = gone.map(({ id, d }) => {
      const ins = this.m.installsSince(id, d.since);
      return t().delistedItem(this.nameOf(id), longDate(d.date), fmt(d.last)) + (ins ? " · " + t().installsSince(longDate(ins.from), signed(ins.gain)) : "");
    });
    return { k: t().kDelisted, t: ids.length === 1 ? t().delistedHead(longDate(gone[0].d.date)) : gone.map((x) => this.nameOf(x.id)).join(" · "), b: [...lines, t().delistedBody].join("\n") };
  }

  // ---------- momentum ----------
  /** The 14 calendar days momentum compares, ending at the last reading, and each window's daily average. */
  private moBars(full: { date: string; daily: number | null }[], A: Analysis): { bars: (number | null)[]; avg?: [number, number] } {
    const byDate = new Map(full.map((x) => [x.date, x.daily]));
    const bars = Array.from({ length: 14 }, (_, i) => byDate.get(addDays(A.lastDate, i - 13)) ?? null);
    return { bars, avg: A.mo?.before != null ? [A.mo.before / 7, A.mo.recent / 7] : undefined };
  }

  /** The "Last 7 days" tile: the sum, its momentum, and the two weeks behind it. */
  private moTile(A: Analysis, full: { date: string; daily: number | null }[], color?: string): Tile {
    return { label: t().tLast7, value: A.sum7, prefix: "+", color, sub: A.mo?.before != null ? `${moText(A.mo)} ${t().vsPrev}` : "", tip: moTip(A.mo, A), ...this.moBars(full, A) };
  }

  /** A table cell with the momentum as a bar from the middle (up right, down left) and as text. */
  private moCell(a: Analysis | null | undefined, name: string, scale: number): Cell {
    const mo = a?.mo;
    if (!mo || mo.before == null) return { text: "–", sort: null, tip: moTip(mo, { name }) };
    const r = mo.ratio ?? (mo.recent > mo.before ? Infinity : 0);
    return {
      // Counts too small for a fair percentage sort after every fair one, among themselves by their shrunk change.
      text: moText(mo), sort: mo.small ? -10 + Math.max(-1, Math.min(1, mo.score)) : mo.score, tip: moTip(mo, { ...a, name }),
      render: (td) => {
        const bar = td.createSpan({ cls: "pp-mbar" + (mo.small ? " is-small" : "") });
        const w = Math.min(1, Math.abs(r) / scale) * 50;
        if (w > 0.5) {
          const f = bar.createSpan({ cls: "pp-mbar-fill " + (r > 0 ? "is-up" : "is-down") });
          f.setCssStyles({ width: w + "%", left: r > 0 ? "50%" : 50 - w + "%" });
        }
        rich(td.createSpan({ cls: "pp-mtext" }), moText(mo));
      },
    };
  }

  /** The scale the momentum bars of a table share: the biggest fair change, at least ±25% and at most ±100%. */
  private moScale(list: (Analysis | null | undefined)[]): number {
    const rs = list.map((a) => a?.mo).filter((m): m is Momentum => !!m && !m.small && m.ratio != null).map((m) => Math.abs(m.ratio as number));
    return Math.min(1, Math.max(0.25, ...rs));
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
    const recent = s.slice(-7).filter((x) => x.daily != null && !x.gap).map((x) => x.daily as number);
    const lede = peak < 0 ? "" : t().dailyLede(shortDate(s[peak].date), signed(s[peak].daily)) + (recent.length ? " · " + t().dailyLedeAvg(fmt(mean(recent))) : "");
    this.chartCard({ title: o.title, desc: o.desc, wide: true, lede, legend: [...(o.legend ?? []), { name: t().ma7, cls: "line" }] }, () => {
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
    const wv = A.weekdayReady ? A.weekday.filter((x) => x.avg != null) as { i: number; avg: number; n: number }[] : [];
    const hiW = wv.length ? wv.reduce((b, x) => x.avg > b.avg ? x : b) : null, loW = wv.length ? wv.reduce((b, x) => x.avg < b.avg ? x : b) : null;
    const wLede = hiW && loW && hiW !== loW && hiW.avg > 0 ? t().whenLede(W[hiW.i], W[loW.i], fmt(hiW.avg), fmt(loW.avg)) : t().whenLedeBest(signed(max));
    this.domCard({ title: t().cWhen, desc: t().dWhen, wide: true, lede: wLede }, (el) => {
      const when = el.createDiv({ cls: "pp-when" });
      // A single plugin's calendar is shaded with that plugin's color; the overview keeps the indigo ramp.
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
    const r = this.m.eta(A);
    const jLede = list.length >= 2 ? t().jLede(fmt(list[0].m), fmt(list[list.length - 1].m), dayDiff(list[0].date, list[list.length - 1].date)) +
      (A.next && r ? " · " + t().jLedeNext(fmt(A.next), dateSpan(addDays(A.lastDate, r.lo), r.hi != null ? addDays(A.lastDate, r.hi) : null)) : "") : "";
    this.domCard({ title: t().cMilestones, desc: t().dMilestones(name), wide: true, lede: jLede }, (el) => {
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
    const ends = series.map((x) => { const r = x.s.filter((v) => v.rank != null && v.date >= labels[0]); return { id: x.id, a: r[0], b: r[r.length - 1] }; }).filter((e) => e.a && e.b);
    let rLede = "";
    if (ends.length) {
      const top = ends.reduce((m, e) => (e.b.rank as number) < (m.b.rank as number) ? e : m);
      const climb = ends.reduce((m, e) => (e.a.rank as number) - (e.b.rank as number) > (m.a.rank as number) - (m.b.rank as number) ? e : m);
      const up = (climb.a.rank as number) - (climb.b.rank as number), multi = ids.length > 1, st = this.m.standing(top.id);
      rLede = (multi ? this.nameOf(top.id) + " " : "") + `**${t().rankTick(fmt(top.b.rank))}**` + (st ? " " + t().topPct(fmt1(st.topPct)) : "") +
        (up > 0 ? " · " + t().rankLedeUp(shortDate(climb.a.date), multi ? this.nameOf(climb.id) + " " : "", fmt(up)) : "");
    }
    // Names are written at the line ends, so no legend.
    this.chartCard({ title: t().cRank, desc: t().dRank, wide, lede: rLede }, () => {
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
    const med = arr[Math.floor(arr.length / 2)], best = sorted[0], above = st.filter((x) => x.downloads > med).length;
    const sLede = st.length === 1 ? t().standLedeOne(fmt1(best.downloads / Math.max(1, med)), fmt(med), fmt1(best.topPct))
      : t().standLedeMany(st.length, above, fmt(med), this.nameOf(best.id), fmt1(best.topPct));
    this.domCard({ title: t().cStanding, desc: t().dStanding(fmt(arr.length), fmt(arr[0])), wide: true, lede: sLede }, (el) => {
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
      this.moTile(A, full, color),
      { label: t().tLast30, value: this.m.gainOver(full, 30) ?? 0, prefix: "+", bars: full.slice(-30).map((x) => x.daily), color },
      this.installsTile([id], A.total, color),
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
    const f = this.m.forecast(A, H);
    const bandLo = [A.total, ...f.lo], bandHi = [A.total, ...f.hi];
    this.chartCard({ title: t().cTotal, desc: t().dTotalSelf(H), lede: t().totalLedeSelf(fmt(A.total), H, fmt(f.lo[H - 1]), fmt(f.hi[H - 1])),
      legend: [{ name: t().actual, cls: "line" }, { name: t().forecast, cls: "dash" }, { name: t().range, cls: "band" }] }, () => {
      const o = baseOptions(P, this.plugin.motion(), { grow: false });
      o.scales.y.beginAtZero = false;
      o.scales.y.max = undefined;
      (o.scales.y as unknown as Record<string, unknown>).suggestedMax = bandHi[bandHi.length - 1];
      o.scales.x.ticks.callback = dateTick;
      o.plugins.tooltip.callbacks = {
        label: (it: TI) => ` ${it.dataIndex > lastIdx ? t().forecast : t().hTotal} ${fmt(num(it.raw))}` + (it.dataIndex > lastIdx ? ` (${fmt(bandLo[it.dataIndex - lastIdx])}–${fmt(bandHi[it.dataIndex - lastIdx])})` : ""),
        footer: this.releaseFooter([id]),
      };
      return {
        type: "line",
        data: { labels: fLabels, datasets: [{ ...lineDataset(P, [...s.map((x) => x.total), ...f.mid], color, true), label: name, segment: forecastSegment(lastIdx, color) }] },
        options: o, plugins: [forecastZone(P, lastIdx, A.next), forecastBand(P, lastIdx, bandLo, bandHi, color), wipe(this.plugin.motion()), crosshair(P), releaseMarkers(P, markers, false)],
      };
    });

    this.rankCard([id], false);
    outlookCard(this, A, color);
    monthlyCard(this, full, A, { color });

    if (versions.length) {
      const relDate = Object.fromEntries((store.releases[id] ?? []).map((r) => [r.version, r.date.slice(0, 10)]));
      const vTop = versions.reduce((b, x) => x.total > b.total ? x : b, versions[0]);
      const vLede = t().verLede(versions[0].version, fmt(versions[0].total)) + (vTop !== versions[0] ? " · " + t().verLedeTop(vTop.version, fmt(vTop.total)) : "");
      this.chartCard({ title: t().cVersions, desc: t().dVersions(versions.length), lede: vLede, height: Math.max(240, versions.length * 22 + 40) }, () => {
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
      const newest = launches[launches.length - 1];
      const lLede = peak < 0 ? "" : t().launchLede(launches[peak].version, fmt(launches[peak].first3)) +
        (launches[peak] !== newest ? " · " + t().launchLedeNew(newest.version, fmt(newest.first3)) + (newest.partial ? " " + t().inProgressShort : "") : "");
      this.chartCard({ title: t().cLaunch, desc: t().dLaunch, lede: lLede, height: Math.max(240, launches.length * 22 + 40) }, () => {
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

    impactCard(this, id, full, color);
    ladderCard(this, id);
    this.standingCard([id]);
    this.whenCard(A, color);
    this.journeyCard(A, name);
    recordsCard(this, A, id);
    this.tableCard([t().hDate, t().hTotal, t().hNew, t().hRank],
      [...full].reverse().filter((x) => x.total != null).map((x) => [x.date, fmt(x.total), x.daily == null ? "–" : signed(x.daily), x.rank ? fmt(x.rank) : "–"]));
  }

  // ---------- all of yours ----------
  private renderTotal() {
    const P = this.P, mine = this.plugin.settings.mine, store = this.plugin.store;
    const full = this.m.totalSeries(mine);
    const A = this.m.analyzeTotal(full);
    if (!A) { this.renderPending(mine[0]); return; }
    const s = this.clip(full);
    const versionCount = mine.reduce((n, id) => n + Object.keys(store.versions[id] ?? {}).length, 0);
    const stars = mine.reduce((n, id) => n + (store.repos[id]?.stars ?? 0), 0);
    this.renderHero({ name: t().allPlugins, A });
    this.syncOrrery(mine, null);
    this.insights(this.totalInsights(A));
    this.tiles([
      this.moTile(A, full),
      { label: t().tLast30, value: this.m.gainOver(A.full, 30) ?? 0, prefix: "+", bars: full.slice(-30).map((x) => x.daily) },
      this.installsTile(mine, A.total),
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
    const f = this.m.forecast(A, H), bandLo = [A.total, ...f.lo], bandHi = [A.total, ...f.hi];
    const last = full[full.length - 1], big = mine.reduce((b, id) => (last.parts[id]?.total ?? 0) > (last.parts[b]?.total ?? 0) ? id : b, mine[0]);
    const tLede = t().totalLedeStack(this.nameOf(big), Math.round((last.parts[big]?.total ?? 0) / Math.max(1, last.total) * 100), H, fmt(f.lo[H - 1]), fmt(f.hi[H - 1]));
    this.chartCard({ title: t().cTotal, desc: t().dTotalStack(H), wide: true, tall: true, lede: tLede, legend: [...legend, { name: t().forecast, cls: "dash" }, { name: t().range, cls: "band" }] }, () => {
      const o = baseOptions(P, this.plugin.motion(), { stacked: true, grow: false });
      (o.scales.y as unknown as Record<string, unknown>).suggestedMax = bandHi[bandHi.length - 1];
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
        options: o, plugins: [forecastZone(P, lastIdx, A.next), forecastBand(P, lastIdx, bandLo, bandHi, P.ink2), wipe(this.plugin.motion()), crosshair(P), releaseMarkers(P, this.markers(mine), false)],
      };
    });

    this.dailyChart({ labels, s, ids: mine, title: t().cDaily, desc: t().dDailyStack, legend,
      datasets: mine.map((id) => ({ label: this.nameOf(id), data: s.map((x, i) => (i === 0 && x.daily == null) ? null : x.parts[id]?.daily ?? null), backgroundColor: this.colorOf(id) })) });
    // Where the week's change came from, next to the months; one alone spans the row.
    const wf = mine.length > 1 ? breakdownCard(this, full, mine) : null;
    const mo = monthlyCard(this, full, A, { ids: mine, wide: !wf });
    if (wf && !mo) wf.addClass("is-wide");
    outlookCard(this, A, P.ink2);
    if (mine.length > 1) { raceCard(this, mine); streamCard(this, mine, labels); }
    this.rankCard(mine, true);
    this.standingCard(mine);
    if (mine.length > 1) { this.releasesCard(mine, labels); scoreCard(this, mine); }
    this.whenCard(A);
    this.journeyCard(A, t().allPlugins);
    recordsCard(this, A);
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

    const facts = all.map((a) => {
      const an = this.m.analyze(a.full), w = smooth(pick(a.full, "daily")).filter((x): x is number => x != null);
      return { id: a.id, total: this.m.latest(a.id)?.downloads ?? 0, pace: (o.smooth ? w[w.length - 1] : an?.pace) ?? 0 };
    });
    const fx = (k: "total" | "pace", hi: boolean) => facts.reduce((b, x) => (hi ? x[k] > b[k] : x[k] < b[k]) ? x : b, facts[0]);
    const big = fx("total", true), small = fx("total", false), fast = fx("pace", true), slow = fx("pace", false);
    const ledes: Record<string, string> = facts.length < 2 ? {} : {
      total: t().sbsTotal(this.nameOf(big.id), fmt(big.total)) + (small !== big && small.total > 0 ? " · " + t().sbsTimes(this.nameOf(small.id), fmt1(big.total / small.total)) : ""),
      daily: t().sbsPace(this.nameOf(fast.id), fmt1(fast.pace)) + (slow !== fast ? " · " + t().sbsSlow(this.nameOf(slow.id), fmt1(slow.pace)) : ""),
    };
    for (const [key, ttl, desc, val, tall] of [
      ["total", t().cTotal, t().dCompareTotal, fmt, true],
      ["daily", o.smooth ? t().cDailyMA : t().cDaily, o.smooth ? t().dRivalsDaily : t().dCompareDaily, o.smooth ? fmt1 : signed, false],
    ] as const) {
      // The totals name their lines at the ends, so only the daily chart keeps a legend.
      this.chartCard({ title: ttl + (key === "total" && log ? ` · ${t().log}` : ""), desc: desc + ageDesc, wide: true, tall, lede: ledes[key], legend: key === "total" ? null : legend }, () => {
        const op = baseOptions(P, this.plugin.motion(), { xTitle: age ? t().xAge : undefined, grow: false, log: key === "total" && log });
        op.layout = { padding: { right: key === "total" ? 152 : 0, top: 8 } };
        op.scales.x.ticks.callback = tick;
        // Smoothed lines keep the day's own value in the tooltip.
        const rawOf = new Map(all.map((a) => [this.nameOf(a.id), pick(a.full, "daily")]));
        op.plugins.tooltip.callbacks = { title, label: (it: TI) => ` ${it.dataset.label ?? ""} ${val(num(it.raw))}` + (key === "daily" && o.smooth ? ` (${t().thatDay} ${signed(rawOf.get(it.dataset.label ?? "")?.[it.dataIndex])})` : ""), footer: age ? undefined : this.releaseFooter(ids) };
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
    const A = this.m.analyzeTotal(total);
    this.renderHero({ name: t().allPlugins, A });
    this.syncOrrery(mine, null);
    if (A) this.insights(this.totalInsights(A).filter((x) => [t().kLead, t().kRank, t().kStart].includes(x.k)));
    // The last 14 days on one shared scale, so both shape and size compare.
    this.tiles(this.groupTiles(mine), 8);
    this.sideBySide(mine, { smooth: true });
    raceCard(this, mine);
    this.rankCard(mine, true);
    this.standingCard(mine);

    const an = new Map(mine.map((id) => [id, this.m.analyze(this.m.series(id))]));
    const scale = this.moScale([...an.values()]);
    const perDay = (a: Analysis | null | undefined) => a ? mean(a.d.slice(-14).filter((x) => !x.gap).map((x) => x.daily)) : null;
    const rows: Row[] = mine.map((id) => {
      const full = this.m.series(id), latest = this.m.latest(id), a = an.get(id), st = this.m.standing(id);
      const vs = Object.keys(store.versions[id] ?? {}).sort(semverCmp);
      return [{ text: `§${this.colorOf(id)}§${this.nameOf(id)}`, sort: this.nameOf(id) }, { text: fmt(latest?.downloads), sort: latest?.downloads }, { text: signed(a?.sum7), sort: a?.sum7 },
        this.moCell(a, this.nameOf(id), scale), { text: signed(this.m.gainOver(full, 30)), sort: this.m.gainOver(full, 30) },
        { text: fmt1(perDay(a)), sort: perDay(a) }, { text: st ? t().rankTick(fmt(st.rank)) : "–", sort: st ? -st.rank : null },
        vs.length ? "v" + vs[vs.length - 1] : "–", { text: fmt(vs.length), sort: vs.length }, { text: fmt(store.repos[id]?.stars), sort: store.repos[id]?.stars }, { text: full[0]?.date ?? "–", sort: full[0]?.date }];
    });
    const foot: Row | undefined = A && total.length ? [`**${t().hSum}**`, `**${fmt(A.total)}**`, signed(A.sum7), { ...this.moCell(A, t().allPlugins, scale), sort: undefined }, signed(this.m.gainOver(A.full, 30)),
      fmt1(perDay(A)), "–", "–", fmt(mine.reduce((n, id) => n + Object.keys(store.versions[id] ?? {}).length, 0)), fmt(mine.reduce((n, id) => n + (store.repos[id]?.stars ?? 0), 0)), total[0].date] : undefined;
    this.tableCard([t().hPlugin, t().hTotal, t().h7, t().hMomentum, t().h30, t().hPerDay, t().hRank, t().hLatest, t().hVersions, t().hStars, t().hFirst], rows, t().cSummary, t().dSummary, true,
      { sort: { key: "compare", col: 3 }, foot, headTips: { 3: t().thMomentum } });
  }

  /** One tile per plugin. The bars are the 14 days momentum compares, whatever range is picked. */
  private groupTiles(ids: string[]): Tile[] {
    const end = ids.map((id) => this.m.latest(id)?.date).filter((d): d is string => !!d).sort().pop();
    const days = end ? Array.from({ length: 14 }, (_, i) => addDays(end, i - 13)) : [];
    const dailyOf = (full: Pt[]) => this.pick(full, days, "daily");
    const barMax = sharedMax(ids.map((id) => dailyOf(this.m.series(id))));
    return ids.filter((id) => this.m.series(id).length).map((id) => {
      const full = this.m.series(id), a = this.m.analyze(full);
      return { label: this.nameOf(id), color: this.colorOf(id), value: this.m.latest(id)?.downloads ?? 0,
        sub: `${t().h7} ${signed(a?.sum7)} ${moText(a?.mo)} · ${t().h30} ${signed(this.m.gainOver(full, 30))}`, bars: dailyOf(full), barMax: barMax ?? undefined,
        avg: a?.mo?.before != null ? [a.mo.before / 7, a.mo.recent / 7] as [number, number] : undefined, tip: moTip(a?.mo, { ...a, name: this.nameOf(id) }) };
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
    this.momentumMap(me, group);
    this.sideBySide(group, { smooth: true });

    // Share of the group's new downloads, over a rolling 7 days.
    const labels = this.datesFor(group);
    const daily = new Map(group.map((id) => [id, new Map(this.m.series(id).map((x) => [x.date, x.daily ?? 0]))]));
    const roll = (id: string, d: string) => { let n = 0; for (let k = 0; k < 7; k++) n += daily.get(id)?.get(addDays(d, -k)) ?? 0; return n; };
    const shares = group.map((id) => labels.map((d) => {
      const tot = group.reduce((n, x) => n + roll(x, d), 0);
      return tot > 0 ? Math.round(roll(id, d) / tot * 1000) / 10 : null;
    }));
    const mineShare = shares[0].filter((x): x is number => x != null), nowS = mineShare[mineShare.length - 1], wkS = mineShare[mineShare.length - 8];
    const shLede = nowS != null ? t().shareLede(this.nameOf(me), fmt1(nowS)) + (wkS != null ? " " + t().shareLedeWk(fmt1(wkS)) : "") : "";
    this.chartCard({ title: t().cShare, desc: t().dShare, wide: true, lede: shLede, legend: group.map((id) => ({ name: this.nameOf(id), color: this.colorOf(id) })) }, () => {
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
    const an = new Map(group.map((id) => [id, this.m.analyze(this.m.series(id))]));
    const scale = this.moScale([...an.values()]);
    const rows: Row[] = group.map((id) => {
      const full = this.m.series(id), latest = this.m.latest(id), a = an.get(id), st = this.m.standing(id);
      const race = id === me ? null : this.m.race(me, id);
      const rel = [...(store.releases[id] ?? [])].sort((x, y) => y.date.localeCompare(x.date));
      const cad = this.m.cadence(id);
      const upd = store.updated[id], ago = upd ? Math.max(0, dayDiff(new Date(upd).toISOString().slice(0, 10), today)) : null;
      const name = this.nameOf(id) + (id === me ? ` (${t().you})` : "");
      const perDay = a ? mean(a.d.slice(-14).filter((x) => !x.gap).map((x) => x.daily)) : null;
      return [{ text: `§${this.colorOf(id)}§${name}`, sort: this.nameOf(id) }, { text: fmt(latest?.downloads), sort: latest?.downloads }, { text: signed(a?.sum7), sort: a?.sum7 },
        this.moCell(a, this.nameOf(id), scale), { text: signed(this.m.gainOver(full, 30)), sort: this.m.gainOver(full, 30) },
        { text: fmt1(perDay), sort: perDay }, { text: st ? t().rankTick(fmt(st.rank)) : "–", sort: st ? -st.rank : null },
        { text: !race || !race.gap ? "–" : race.gap > 0 ? t().gapAhead(fmt(race.gap)) : t().gapBehind(fmt(-race.gap)), sort: race?.gap },
        { text: race?.days == null ? "–" : race.days > 365 ? t().overYear : race.gap > 0 ? "~" + t().daysN(fmt(race.days)) : `{down|${t().caughtIn(fmt(race.days))}}`, sort: race?.days == null ? null : -race.days },
        rel[0] ? "v" + rel[0].version : "–", { text: ago == null ? "–" : t().ago(ago), sort: ago == null ? null : -ago },
        { text: cad != null ? t().daysN(fmt1(cad)) : "–", sort: cad == null ? null : -cad }, { text: fmt(store.repos[id]?.stars), sort: store.repos[id]?.stars }, { text: full[0]?.date ?? "–", sort: full[0]?.date }];
    });
    this.tableCard([t().hPlugin, t().hTotal, t().h7, t().hMomentum, t().h30, t().hPerDay, t().hRank, t().hGap, t().hEta, t().hLatest, t().hUpdated, t().hCadence, t().hStars, t().hFirst],
      rows, t().cSummary, t().dSummary, true, { sort: { key: "rivals", col: 3 }, headTips: { 3: t().thMomentum } });
  }

  /** The competitors' combined momentum: everyone but `me` with two full weeks, summed. */
  private groupMomentum(me: string, an: Map<string, Analysis | null>): { recent: number; before: number; ratio: number | null; small: boolean } | null {
    const mos = [...an].filter(([id]) => id !== me).map(([, a]) => a?.mo).filter((m): m is Momentum => m?.before != null);
    if (!mos.length) return null;
    const recent = mos.reduce((n, m) => n + m.recent, 0), before = mos.reduce((n, m) => n + (m.before as number), 0);
    return { recent, before, ratio: before ? (recent - before) / before : null, small: before < SMALL_BASE };
  }

  /**
   * Every plugin of the group by size (x, log) and momentum (y): four corners from "leading, speeding up" to
   * "slowing", the competitors' combined momentum as a dashed line. Unfair percentages are hollow dots.
   */
  private momentumMap(me: string, group: string[]) {
    const an = new Map(group.map((id) => [id, this.m.analyze(this.m.series(id))]));
    const pts = group.map((id) => ({ id, a: an.get(id) as Analysis })).filter((p) => p.a?.mo?.before != null && p.a.total > 0);
    const missing = group.filter((id) => !pts.some((p) => p.id === id));
    if (pts.length < 2) return;
    const ratio = (mo: Momentum) => mo.ratio ?? (mo.recent > (mo.before ?? 0) ? Infinity : 0);
    const fair = pts.filter((p) => !p.a.mo?.small).map((p) => Math.abs(ratio(p.a.mo as Momentum))).filter(isFinite);
    const grp = this.groupMomentum(me, an);
    const top = Math.max(0, ...fair, grp?.ratio != null ? Math.abs(grp.ratio) : 0);
    const Y = [0.25, 0.5, 1, 2].find((v) => v >= top) ?? 2;
    const logs = pts.map((p) => Math.log10(p.a.total));
    let lo = Math.min(...logs), hi = Math.max(...logs);
    if (hi - lo < 0.5) { const c = (hi + lo) / 2; lo = c - 0.25; hi = c + 0.25; }
    // Dots stay inside 8–92% across and 10–90% down, clear of the corner names.
    const xOf = (total: number) => 8 + (Math.log10(total) - lo) / (hi - lo) * 84;
    const yOf = (r: number) => 50 - Math.max(-1, Math.min(1, r / Y)) * 40;
    const mid = xOf(Math.pow(10, mean(logs)));
    const pctTick = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.round(Math.abs(v) * 100) + "%";

    const showGroup = grp?.ratio != null && !grp.small;
    const legend = showGroup ? [{ name: t().qGroup(delta(grp?.ratio)), cls: "dash" }] : null;
    const fastest = pts.reduce((b, p) => ratio(p.a.mo as Momentum) > ratio(b.a.mo as Momentum) ? p : b, pts[0]), largest = pts.reduce((b, p) => p.a.total > b.a.total ? p : b, pts[0]);
    const mLede = t().mapLede(this.nameOf(fastest.id), moText(fastest.a.mo)) + (largest !== fastest ? " · " + t().mapLedeBig(this.nameOf(largest.id), moText(largest.a.mo)) : "");
    this.domCard({ title: t().cMomentumMap, desc: t().dMomentumMap, wide: true, lede: mLede, legend }, (el) => {
      const box = el.createDiv({ cls: "pp-quad" });
      const plot = box.createDiv({ cls: "pp-quad-plot" });
      for (const v of [Y, Y / 2, 0, -Y / 2, -Y]) {
        const tick = plot.createDiv({ cls: "pp-quad-tick" + (v === 0 ? " is-zero" : "") });
        tick.setCssStyles({ top: yOf(v) + "%" });
        tick.createSpan({ text: pctTick(v) });
      }
      plot.createDiv({ cls: "pp-quad-mid" }).setCssStyles({ left: mid + "%" });
      ([["tl", t().qTL], ["tr", t().qTR], ["bl", t().qBL], ["br", t().qBR]] as const).forEach(([k, label]) => plot.createDiv({ cls: "pp-quad-q is-" + k, text: label }));
      if (showGroup && grp?.ratio != null) plot.createDiv({ cls: "pp-quad-group" }).setCssStyles({ top: yOf(grp.ratio) + "%" });
      const dots = pts.map((p, i) => {
        const mo = p.a.mo as Momentum;
        const d = plot.createDiv({ cls: "pp-quad-dot" + (p.id === me ? " is-me" : "") + (mo.small ? " is-small" : "") });
        d.setCssProps({ "--pp-c": this.colorOf(p.id), "--pp-d": String(i) });
        this.tip.bind(d, moTip(mo, { ...p.a, name: this.nameOf(p.id) }) + `\n${t().hTotal} ${fmt(p.a.total)}`);
        const label = plot.createDiv({ cls: "pp-quad-label" + (p.id === me ? " is-me" : "") });
        label.setCssProps({ "--pp-d": String(i) });
        label.appendText(this.nameOf(p.id) + " ");
        rich(label, moText(mo));
        return { id: p.id, d, label, x: xOf(p.a.total), y: yOf(ratio(mo)), me: p.id === me };
      });
      const axis = box.createDiv({ cls: "pp-quad-axis" });
      axis.createSpan({ text: fmt(Math.pow(10, lo)) });
      axis.createSpan({ text: t().qX + " →" });
      axis.createSpan({ text: fmt(Math.pow(10, hi)) });
      if (missing.length) el.createDiv({ cls: "pp-muted pp-quad-note", text: t().qNoData(missing.map((id) => this.nameOf(id)).join(", ")) });
      return () => {
        // Each label goes right of its dot, or left, above or below: the first spot that overlaps nothing placed yet.
        const W = plot.clientWidth, H = plot.clientHeight, crowded: typeof dots = [];
        // Every dot is an obstacle from the start, so no label covers another plugin's dot. Each label takes the
        // free spot nearest its dot (right, left, above, below, then the corners), or the one overlapping least.
        const placed: DOMRect[] = dots.map((p) => { const r = p.d.offsetWidth / 2 + 2; return new DOMRect(p.x / 100 * W - r, p.y / 100 * H - r, 2 * r, 2 * r); });
        // The corner names too.
        plot.querySelectorAll<HTMLElement>(".pp-quad-q").forEach((q) => placed.push(new DOMRect(q.offsetLeft, q.offsetTop, q.offsetWidth, q.offsetHeight)));
        const cost = (r: DOMRect) => (r.left < 0 || r.right > W || r.top < 0 || r.bottom > H ? 1e9 : 0) +
          placed.reduce((n, q) => n + Math.max(0, Math.min(r.right, q.right) - Math.max(r.left, q.left)) * Math.max(0, Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top)), 0);
        for (const p of [...dots].sort((a, b) => Number(b.me) - Number(a.me))) {
          p.d.setCssStyles({ left: p.x + "%", top: p.y + "%" });
          const px = p.x / 100 * W, py = p.y / 100 * H, lw = p.label.offsetWidth, lh = p.label.offsetHeight, gap = p.d.offsetWidth / 2 + 6;
          const spots = [[px + gap, py - lh / 2], [px - gap - lw, py - lh / 2], [px - lw / 2, py - gap - lh], [px - lw / 2, py + gap],
            [px + gap * 0.7, py - gap * 0.7 - lh], [px + gap * 0.7, py + gap * 0.7], [px - gap * 0.7 - lw, py - gap * 0.7 - lh], [px - gap * 0.7 - lw, py + gap * 0.7]];
          let at = new DOMRect(spots[0][0], spots[0][1], lw, lh), best = Infinity;
          for (const [x, y] of spots) { const r = new DOMRect(x, y, lw, lh), c = cost(r); if (c < best) { best = c; at = r; } if (!c) break; }
          // No room (a narrow pane, a crowd): the dot keeps its tooltip and the name goes to a legend below. Yours always shows.
          if (best > 0 && !p.me) { p.label.hide(); crowded.push(p); continue; }
          placed.push(at);
          p.label.setCssStyles({ left: at.left + "px", top: at.top + "px" });
          p.label.addClass("is-on");
        }
        if (crowded.length) {
          const lg = el.createDiv({ cls: "pp-legend pp-quad-legend" });
          for (const p of crowded) { const sp = lg.createSpan(); swatch(sp, this.colorOf(p.id)); rich(sp, this.nameOf(p.id) + " " + moText(an.get(p.id)?.mo)); }
        }
      };
    });
  }

  private releasesCard(ids: string[], labels: string[]) {
    const store = this.plugin.store;
    if (!labels.length || !ids.some((id) => store.releases[id]?.length)) return;
    const from = labels[0], to = labels[labels.length - 1], span = Math.max(1, dayDiff(from, to));
    const inRange = (id: string) => (store.releases[id] ?? []).filter((r) => r.date.slice(0, 10) >= from && r.date.slice(0, 10) <= to).length;
    const counts = ids.map((id) => ({ id, n: inRange(id) })), all = counts.reduce((n, x) => n + x.n, 0), most = counts.reduce((b, x) => x.n > b.n ? x : b, counts[0]);
    const relLede = all ? t().relLede(shortDate(from), all) + (ids.length > 1 && most.n ? " · " + t().relLedeMost(this.nameOf(most.id), most.n, fmt1(span / most.n)) : " " + t().relEvery(fmt1(span / all))) : "";
    this.domCard({ title: t().cReleases, desc: t().dReleases, wide: true, lede: relLede }, (el) => {
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
        row.createDiv({ cls: "pp-rel-n", text: t().relCount(rel.length) });
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
      // A reading after missed days holds several days: it is not compared with single days.
      const head = A.last.gap ? t().usualDay(v) + t().missedDay : A.lastRank === 1 && A.d.length > 7 ? t().bestDay(v) : r >= 1.15 ? t().usualTimes(fmt1(r), v) : r <= 0.85 ? t().quietDay(v) : t().usualDay(v);
      push(t().kLatest, head, t().latestBody(longDate(A.last.date), signed(A.avgPrev), A.d.length, A.lastRank ?? 0) +
        (A.lastRank !== 1 && A.best ? t().latestBest(longDate(A.best.date), signed(A.best.daily)) : ""));
    }
    if (A.mo?.before != null) push(t().kMomentum, t().momentumHead(signed(A.sum7), moText(A.mo)), moTip(A.mo, A));
    // Several weeks the same way, or the last 28 days against the 28 before, so one odd week doesn't read as a trend.
    if (A.weeks.length >= 3 && (Math.abs(A.run) >= 2 || A.mo28?.before != null)) {
      const d28 = A.mo28?.before != null ? moText(A.mo28) : "";
      const head = A.run >= 2 ? t().runUpHead(A.run) : A.run <= -2 ? t().runDownHead(-A.run) : t().trend28Head(d28);
      push(t().kTrend, head + (Math.abs(A.run) >= 2 && d28 ? ` · ${t().trend28Head(d28)}` : ""), t().trendBody(A.weeks.map((w) => fmt(w)).join(" → "), d28));
    }
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
    const gone = this.delistedInsight(mine);
    if (gone) out.unshift(gone);
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
    const gone = this.delistedInsight([id]);
    if (gone) out.unshift(gone);
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

    // My momentum against the competitors' combined: is the whole niche moving, or only me?
    const grp = this.groupMomentum(me, an);
    if (grp?.ratio != null && mine.mo?.ratio != null && !grp.small && !mine.mo.small) {
      const pts = Math.round((mine.mo.ratio - grp.ratio) * 100);
      const lead = pts > 0 ? t().vsGroupAhead(fmt(pts)) : pts < 0 ? t().vsGroupBehind(fmt(-pts)) : t().vsGroupEven;
      out.push({ k: t().kVsGroup, t: t().vsGroupHead(moText(mine.mo), delta(grp.ratio)), b: t().vsGroupBody(lead, fmt(grp.recent), fmt(grp.before)) });
    }

    const others = group.filter((id) => id !== me);
    const above = others.filter((id) => (an.get(id)?.total ?? 0) > mine.total).sort((a, b) => (an.get(a)?.total ?? 0) - (an.get(b)?.total ?? 0));
    if (above.length) {
      const id = above[0], r = this.m.race(me, id);
      if (r) out.push({ k: t().kOvertake, t: r.days != null ? t().overtakeHead(this.nameOf(id), r.days) : t().overtakeAway(this.nameOf(id)), b: t().overtakeBody(fmt(r.gap), fmt1(r.myPace), fmt1(r.theirPace), this.nameOf(id)) });
    } else {
      const second = [...others].sort((a, b) => (an.get(b)?.total ?? 0) - (an.get(a)?.total ?? 0))[0];
      if (second) out.push({ k: t().kOvertake, t: t().topOfGroup, b: t().topBody(this.nameOf(second), fmt(mine.total - (an.get(second)?.total ?? 0))) });
    }

    const chasers = others.filter((id) => (an.get(id)?.total ?? 0) <= mine.total)
      .map((id) => ({ id, r: this.m.race(me, id) })).filter((x) => x.r?.days != null).sort((a, b) => (a.r?.days ?? 0) - (b.r?.days ?? 0));
    if (chasers.length) {
      const c = chasers[0], r = c.r as NonNullable<typeof c.r>;
      out.push({ k: t().kChaser, t: t().chaserHead(this.nameOf(c.id), r.days as number), b: t().chaserBody(fmt(-r.gap), fmt1(r.myPace), fmt1(r.theirPace), this.nameOf(c.id)) });
    } else if (others.some((id) => (an.get(id)?.total ?? 0) <= mine.total)) {
      out.push({ k: t().kChaser, t: t().chaserSafe, b: others.filter((id) => (an.get(id)?.total ?? 0) <= mine.total).map((id) => `${this.nameOf(id)} ${fmt(an.get(id)?.total)}`).join(" · ") });
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
      const median = cads.length ? t().everyN(fmt1(cads[Math.floor(cads.length / 2)])) : "–";
      out.push({ k: t().kCadence, t: myCad != null ? t().cadenceHead(fmt1(myCad), median) : t().cadenceNone, b: t().cadenceBody });
    }
    return out;
  }
}
