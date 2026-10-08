import { App, Modal, Notice, Platform, TFile, normalizePath } from "obsidian";
import type PulsePlugin from "../main";
import { Model } from "../analysis";
import { addDays } from "../data/store";
import { t } from "../i18n";
import type { ShareOpts } from "../types";
import { SERIES_DARK, SERIES_LIGHT } from "./charts";
import { alpha, fmt, fmt1, signed } from "./util";

/*
 * A card of your plugins to post elsewhere: one big total, a line per plugin, and the app's name at the foot.
 * Drawn on a canvas, so the image is the same in every theme and on every device. Two shapes:
 *   wide  — 1200×675 (drawn at 2×), for X, Discord, Reddit and the forum
 *   story — 1080×1920, for Instagram and other stories, with the top and bottom kept clear of their buttons
 */

/** `slot` is the plugin's place in your list, which picks its color as on the dashboard. */
interface Row { name: string; slot: number; total: number; gain: number | null; daily: (number | null)[]; topPct: number | null }
export interface CardData {
  author: string | null;
  count: number;
  date: string;
  total: number;
  gain: number;
  days: number;
  rows: Row[];
  /** Plugins left off the card for space: how many, their downloads together, and their daily sum for the chart. */
  more: { n: number; total: number; daily: (number | null)[] } | null;
}

const INK = {
  light: { page: "#fbfbfa", ink: "#1d1d1f", mute: "#7a7a80", line: "#e4e3df", ring: "#c9c9cc", up: "#006300", series: SERIES_LIGHT },
  dark: { page: "#161618", ink: "#f2f2f3", mute: "#8e8e93", line: "#2e2e31", ring: "#4a4a4f", up: "#3fbf5f", series: SERIES_DARK },
};
type Ink = typeof INK.light;
type Drawn = Row & { color: string };

/** Everything the card shows, from the stored history. Null when none of your plugins has a reading yet. */
export function cardData(plugin: PulsePlugin, days: number, max: number): CardData | null {
  const m = new Model(plugin.store), s = plugin.settings;
  const known = s.mine.map((id, i) => ({ id, i, latest: m.latest(id) })).filter((x) => x.latest);
  if (!known.length) return null;
  const date = known.map((x) => x.latest?.date ?? "").sort().reverse()[0];
  const from = addDays(date, -days + 1);
  const rows = known.map(({ id, i, latest }) => {
    const series = m.series(id), byDate = new Map(series.map((p) => [p.date, p.daily]));
    const daily: (number | null)[] = [];
    for (let d = from; d <= date; d = addDays(d, 1)) daily.push(byDate.get(d) ?? null);
    return {
      name: s.meta[id]?.name ?? id, i, total: latest?.downloads ?? 0,
      gain: m.gainOver(series, days), daily, topPct: m.standing(id)?.topPct ?? null,
    };
  }).sort((a, b) => b.total - a.total);
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const rest = rows.slice(shown.length);
  const authors = [...new Set(s.mine.map((id) => s.meta[id]?.author).filter(Boolean))];
  return {
    author: authors.length === 1 ? authors[0] ?? null : null,
    count: s.mine.length,
    date,
    total: rows.reduce((n, r) => n + r.total, 0),
    gain: rows.reduce((n, r) => n + (r.gain ?? 0), 0),
    days,
    rows: shown.map(({ i, ...r }) => ({ ...r, slot: i })),
    more: rest.length ? {
      n: rest.length, total: rest.reduce((n, r) => n + r.total, 0),
      daily: rest[0].daily.map((_, k) => rest.some((r) => r.daily[k] != null) ? rest.reduce((n, r) => n + (r.daily[k] ?? 0), 0) : null),
    } : null,
  };
}

// ---------- drawing ----------
type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

function font(ctx: Ctx, size: number, weight: number, family: string, tracking = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${tracking * size}px`;
}

/** Text cut with an ellipsis to fit `max` pixels. */
function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

function text(ctx: Ctx, s: string, x: number, y: number, color: string, align: CanvasTextAlign = "left") {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

/** Parts drawn one after another on a baseline, each in its own color and weight. Returns the end x. */
function runs(ctx: Ctx, parts: { s: string; color: string; weight?: number }[], x: number, y: number, size: number, family: string): number {
  ctx.textAlign = "left";
  for (const p of parts) {
    font(ctx, size, p.weight ?? 400, family);
    ctx.fillStyle = p.color;
    ctx.fillText(p.s, x, y);
    x += ctx.measureText(p.s).width;
  }
  return x;
}

function dot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function hairline(ctx: Ctx, x1: number, x2: number, y: number, color: string, w: number) {
  ctx.fillStyle = color;
  ctx.fillRect(x1, y - w / 2, x2 - x1, w);
}

/** Daily downloads as a line. Missed days break it. */
function spark(ctx: Ctx, values: (number | null)[], x: number, y: number, w: number, h: number, color: string, lw: number) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const px = x + i * step, py = y + h - lw / 2 - (v / max) * (h - lw);
    if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    pen = true;
  });
  ctx.stroke();
}

const topText = (p: number | null) => p == null ? "" : t().cardTop(p < 1 ? fmt1(p) : fmt(Math.max(1, Math.round(p))));

function cardDate(d: string) { return t().cardDate(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)); }

/** Width of `s` in the given font. Leaves that font set. */
function measure(ctx: Ctx, s: string, size: number, weight: number, family: string, tracking = 0): number {
  font(ctx, size, weight, family, tracking);
  return ctx.measureText(s).width;
}

/** The largest size, from `size` down to half of it, at which `s` fits in `max` pixels. Leaves that font set. */
function fitSize(ctx: Ctx, s: string, max: number, size: number, weight: number, family: string, tracking = 0): number {
  let z = size;
  while (z > size / 2 && measure(ctx, s, z, weight, family, tracking) > max) z -= 2;
  return z;
}

/** Letter spacing for small labels: spaced capitals in Latin; Hangul reads better without. */
const tracking = (s: string) => /[ㄱ-힝]/.test(s) ? 0 : 0.06;

/** A small label in spaced capitals. */
function label(ctx: Ctx, s: string, x: number, y: number, size: number, color: string, family: string, align: CanvasTextAlign = "left") {
  font(ctx, size, 600, family, tracking(s));
  text(ctx, s.toUpperCase(), x, y, color, align);
  font(ctx, size, 600, family);
}

/** The app's mark: a rounded square with a pulse line. `y` is its top. */
function mark(ctx: Ctx, x: number, y: number, s: number, k: Ink) {
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, s * 0.26);
  ctx.fillStyle = k.ink;
  ctx.fill();
  const p = (u: number, v: number): [number, number] => [x + u * s, y + v * s];
  ctx.beginPath();
  ctx.moveTo(...p(0.16, 0.55));
  for (const [u, v] of [[0.36, 0.55], [0.45, 0.28], [0.57, 0.76], [0.66, 0.48], [0.84, 0.48]]) ctx.lineTo(...p(u, v));
  ctx.strokeStyle = k.page;
  ctx.lineWidth = s * 0.09;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/** Author in bold and the plugin count, cut to `max` pixels. */
function byline(ctx: Ctx, d: CardData, k: Ink, f: string, x: number, y: number, size: number, max: number) {
  const count = t().cardPlugins(d.count);
  if (!d.author) { font(ctx, size, 400, f); text(ctx, fit(ctx, count, max), x, y, k.mute); return; }
  const tail = " · " + count;
  const tw = measure(ctx, tail, size, 400, f);
  font(ctx, size, 600, f);
  const author = fit(ctx, d.author, Math.max(max - tw, max * 0.6));
  text(ctx, author, x, y, k.ink);
  const aw = ctx.measureText(author).width;
  font(ctx, size, 400, f);
  text(ctx, fit(ctx, tail, max - aw), x + aw, y, k.mute);
}

/** The period's gain in a tinted pill: "+2,300 last 30 days". `y` is its top. Returns its height. */
function gainChip(ctx: Ctx, d: CardData, k: Ink, f: string, x: number, y: number, size: number, max: number): number {
  const h = Math.round(size * 1.9), pad = Math.round(size * 0.75);
  const gain = signed(d.gain), period = " " + t().cardPeriod(d.days);
  const gw = measure(ctx, gain, size, 700, f), pw = measure(ctx, period, size, 400, f);
  const w = Math.min(max, gw + pw + pad * 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = alpha(k.up, 0.12);
  ctx.fill();
  const base = y + h / 2 + size * 0.36;
  font(ctx, size, 700, f);
  text(ctx, gain, x + pad, base, k.up);
  font(ctx, size, 400, f);
  text(ctx, fit(ctx, period, w - pad * 2 - gw), x + pad + gw, base, k.ink);
  return h;
}

/** Every plugin's daily new downloads, stacked in its color; the ones left off the card on top in grey. Missed days stay empty. */
function stackedBars(ctx: Ctx, rows: Pick<Drawn, "daily" | "color">[], x: number, y: number, w: number, h: number, k: Ink, lw: number) {
  const n = rows[0]?.daily.length ?? 0;
  const sums = Array.from({ length: n }, (_, i) => rows.reduce((s, r) => s + Math.max(0, r.daily[i] ?? 0), 0));
  const max = Math.max(1, ...sums);
  const step = w / Math.max(1, n), bw = Math.max(1.5, step * (n > 45 ? 0.72 : 0.6));
  for (let i = 0; i < n; i++) {
    let top = y + h;
    for (const r of rows) {
      const v = Math.max(0, r.daily[i] ?? 0);
      if (!v) continue;
      const bh = v / max * h;
      ctx.fillStyle = r.color;
      ctx.fillRect(x + i * step + (step - bw) / 2, top - bh, bw, bh);
      top -= bh;
    }
  }
  hairline(ctx, x, x + w, y + h + lw / 2, k.line, lw);
}

/** The daily chart with its caption above: what it shows on the left, the busiest day on the right. `y` is the caption's baseline. */
function dailyBlock(ctx: Ctx, d: CardData, shown: Drawn[], k: Ink, f: string, x: number, y: number, w: number, h: number, size: number, lw: number) {
  const rows: Pick<Drawn, "daily" | "color">[] = d.more ? [...shown, { daily: d.more.daily, color: k.ring }] : shown;
  const n = rows[0]?.daily.length ?? 0;
  const peak = Math.max(0, ...Array.from({ length: n }, (_, i) => rows.reduce((s, r) => s + Math.max(0, r.daily[i] ?? 0), 0)));
  const pk = t().cardPeak(signed(peak)), pw = measure(ctx, pk, size, 400, f);
  text(ctx, pk, x + w, y, k.mute, "right");
  font(ctx, size, 600, f, tracking(t().cardDaily));
  label(ctx, fit(ctx, t().cardDaily.toUpperCase(), w - pw - 24), x, y, size, k.mute, f);
  stackedBars(ctx, rows, x, y + size, w, h - size, k, lw);
}

/** The app's name, and where the numbers come from: beside it, or below it on a narrow card. */
function footer(ctx: Ctx, k: Ink, f: string, L: number, R: number, y: number, size: number, stacked: boolean, lw: number) {
  hairline(ctx, L, R, y, k.ink, lw);
  const made = [{ s: t().cardMadePre, color: k.mute }, { s: t().appName, color: k.ink, weight: 600 }, { s: t().cardMadePost, color: k.mute }];
  const end = runs(ctx, made, L, y + size * 2.1, size, f);
  font(ctx, size, 400, f);
  if (stacked) text(ctx, fit(ctx, t().cardSource, R - L), L, y + size * 3.7, k.mute);
  else text(ctx, fit(ctx, t().cardSource, R - end - GAP), R, y + size * 2.1, k.mute, "right");
}

const GAP = 32;

/** Draws the card onto `canvas`, sizing it for the format. */
export function drawCard(canvas: HTMLCanvasElement, d: CardData, opts: ShareOpts, family: string): void {
  const story = opts.format === "story";
  const W = story ? 1080 : 1200, H = story ? 1920 : 675, scale = story ? 1 : 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx: Ctx | null = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const k = INK[opts.theme];
  ctx.fillStyle = k.page;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  const rows = d.rows.map((r) => ({ ...r, color: k.series[r.slot % k.series.length] }));
  if (story) drawStory(ctx, d, rows, k, family); else drawWide(ctx, d, rows, k, family);
}

/** 16:9. Header, the total beside the daily chart, then a table whose columns are as wide as their widest value. */
function drawWide(ctx: Ctx, d: CardData, rows: Drawn[], k: Ink, f: string) {
  const L = 64, R = 1136;
  mark(ctx, L, 48, 30, k);
  const date = cardDate(d.date), dw = measure(ctx, date, 19, 400, f);
  text(ctx, date, R, 70, k.mute, "right");
  byline(ctx, d, k, f, L + 44, 70, 19, R - dw - GAP - (L + 44));

  // the total and the period's gain, beside the daily chart
  const heroW = 500;
  label(ctx, t().cardTotal, L, 140, 14, k.mute, f);
  const total = fmt(d.total), z = fitSize(ctx, total, heroW, 100, 700, f, -0.04);
  text(ctx, total, L - z * 0.03, 152 + z * 0.74, k.ink);
  gainChip(ctx, d, k, f, L, 262, 19, heroW);
  dailyBlock(ctx, d, rows, k, f, 620, 140, R - 620, 160, 14, 1.5);

  // the table
  const cols = t().cardCols(d.days);
  const size = 21, hs = 13;
  const hasRank = rows.some((r) => r.topPct != null);
  const colW = (vals: string[], head: string, weight: number) =>
    Math.max(...vals.map((v) => measure(ctx, v, size, weight, f)), measure(ctx, head.toUpperCase(), hs, 600, f, tracking(head)));
  const rankW = hasRank ? colW(rows.map((r) => topText(r.topPct)), cols[4], 400) : 0;
  const gainR = hasRank ? R - rankW - GAP : R;
  const gainW = colW(rows.map((r) => r.gain == null ? "–" : signed(r.gain)), cols[3], 600);
  const totalR = gainR - gainW - GAP;
  const totalW = colW(rows.map((r) => fmt(r.total)), cols[2], 400);
  const sparkR = totalR - totalW - GAP, nameL = L + 26;
  // The name keeps at least 200px; the line gives way first.
  const sparkW = Math.max(80, Math.min(200, sparkR - nameL - 200 - GAP));
  const sparkL = sparkR - sparkW, nameW = sparkL - GAP - nameL;

  const head = 350;
  label(ctx, cols[0], nameL, head, hs, k.mute, f);
  font(ctx, hs, 600, f, tracking(cols[1]));
  label(ctx, fit(ctx, cols[1].toUpperCase(), sparkW), sparkL, head, hs, k.mute, f);
  label(ctx, cols[2], totalR, head, hs, k.mute, f, "right");
  label(ctx, cols[3], gainR, head, hs, k.mute, f, "right");
  if (hasRank) label(ctx, cols[4], R, head, hs, k.mute, f, "right");

  const top = 364, bottom = 600;
  const n = rows.length + (d.more ? 1 : 0);
  const rh = Math.min(62, (bottom - top) / Math.max(1, n));
  rows.forEach((r, i) => {
    const y = top + i * rh, mid = y + rh / 2 + size * 0.36;
    hairline(ctx, L, R, y, k.line, 1.5);
    dot(ctx, L + 6, y + rh / 2, 6, r.color);
    font(ctx, size, 600, f);
    text(ctx, fit(ctx, r.name, nameW), nameL, mid, k.ink);
    spark(ctx, r.daily, sparkL, y + rh / 2 - 14, sparkW, 28, r.color, 2.5);
    font(ctx, size, 400, f);
    text(ctx, fmt(r.total), totalR, mid, k.ink, "right");
    if (hasRank) text(ctx, topText(r.topPct), R, mid, k.mute, "right");
    font(ctx, size, 600, f);
    text(ctx, r.gain == null ? "–" : signed(r.gain), gainR, mid, k.up, "right");
  });
  if (d.more) {
    const y = top + rows.length * rh;
    hairline(ctx, L, R, y, k.line, 1.5);
    ctx.strokeStyle = k.ring;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(L + 6, y + rh / 2, 5, 0, Math.PI * 2); ctx.stroke();
    font(ctx, 19, 400, f);
    text(ctx, fit(ctx, t().cardMore(d.more.n, fmt(d.more.total)), R - nameL), nameL, y + rh / 2 + 7, k.mute);
  }
  footer(ctx, k, f, L, R, 616, 16, false, 1.5);
}

/** 9:16. Stories cover about the top and bottom 250px with their own buttons, so the card lives between. */
function drawStory(ctx: Ctx, d: CardData, rows: Drawn[], k: Ink, f: string) {
  const L = 96, R = 1080 - 96, W = R - L;
  mark(ctx, L, 236, 46, k);
  const count = t().cardPlugins(d.count), date = cardDate(d.date);
  if (d.author) {
    font(ctx, 34, 600, f);
    text(ctx, fit(ctx, d.author, W - 66), L + 66, 272, k.ink);
    font(ctx, 28, 400, f);
    text(ctx, fit(ctx, count + " · " + date, W), L, 340, k.mute);
  } else {
    font(ctx, 28, 400, f);
    text(ctx, fit(ctx, count + " · " + date, W - 66), L + 66, 270, k.mute);
  }

  // the total and the period's gain
  label(ctx, t().cardTotal, L, 440, 24, k.mute, f);
  const total = fmt(d.total), z = fitSize(ctx, total, W, 200, 700, f, -0.045);
  const base = 462 + z * 0.74;
  text(ctx, total, L - z * 0.03, base, k.ink);
  const chipTop = base + 40;
  const ch = gainChip(ctx, d, k, f, L, chipTop, 32, W);

  // the daily chart, taller when there are few plugins below it
  const n = rows.length + (d.more ? 1 : 0), bottom = 1540;
  const chartY = chipTop + ch + 100;
  const chartH = Math.max(220, Math.min(460, bottom - 56 - chartY - n * 124));
  dailyBlock(ctx, d, rows, k, f, L, chartY, W, chartH, 24, 2);

  // one block per plugin: name and total, then the gain and rank
  const top = chartY + chartH + 56;
  const bh = Math.min(124, (bottom - top) / Math.max(1, n));
  rows.forEach((r, i) => {
    const y = top + i * bh, l1 = y + bh * 0.44, l2 = y + bh * 0.82;
    hairline(ctx, L, R, y, k.line, 2);
    dot(ctx, L + 9, l1 - 12, 9, r.color);
    const tot = fmt(r.total), tw = measure(ctx, tot, 34, 400, f);
    text(ctx, tot, R, l1, k.ink, "right");
    font(ctx, 34, 600, f);
    text(ctx, fit(ctx, r.name, W - 36 - tw - GAP), L + 36, l1, k.ink);
    const top3 = topText(r.topPct), rw = measure(ctx, top3, 28, 400, f);
    if (top3) text(ctx, top3, R, l2, k.mute, "right");
    const g = r.gain == null ? "–" : signed(r.gain);
    font(ctx, 28, 600, f);
    text(ctx, g, L + 36, l2, k.up);
    const gw = ctx.measureText(g).width;
    font(ctx, 28, 400, f);
    text(ctx, fit(ctx, " " + t().cardPeriod(d.days), R - rw - GAP - (L + 36 + gw)), L + 36 + gw, l2, k.mute);
  });
  if (d.more) {
    const y = top + rows.length * bh;
    hairline(ctx, L, R, y, k.line, 2);
    ctx.strokeStyle = k.ring;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(L + 9, y + 46, 8, 0, Math.PI * 2); ctx.stroke();
    font(ctx, 28, 400, f);
    text(ctx, fit(ctx, t().cardMore(d.more.n, fmt(d.more.total)), W - 36), L + 36, y + 56, k.mute);
  }
  footer(ctx, k, f, L, R, 1580, 26, true, 2);
}

// ---------- the dialog ----------
const MAX_ROWS = { wide: 4, story: 4 };

/** Preview with format, theme and period, then copy the image or save it in the vault. */
export class ShareModal extends Modal {
  private canvas!: HTMLCanvasElement;
  private opts: ShareOpts;

  constructor(app: App, private plugin: PulsePlugin) {
    super(app);
    this.opts = { ...plugin.settings.share };
  }

  onOpen(): void {
    this.modalEl.addClass("pp-share-modal");
    this.titleEl.setText(t().shareTitle);
    this.contentEl.addClass("pp-modal");
    this.draw();
  }

  private family(): string {
    const f = getComputedStyle(activeDocument.body).getPropertyValue("--font-interface").trim() || getComputedStyle(activeDocument.body).fontFamily;
    return f || "system-ui, sans-serif";
  }

  private draw() {
    const el = this.contentEl;
    el.empty();
    const data = cardData(this.plugin, this.opts.days, MAX_ROWS[this.opts.format]);
    if (!data) { el.createEl("p", { cls: "pp-muted", text: t().shareEmpty }); return; }

    const bar = el.createDiv({ cls: "pp-share-opts" });
    const group = <K extends keyof ShareOpts>(key: K, choices: [ShareOpts[K], string][]) => {
      const g = bar.createDiv({ cls: "pp-share-group", attr: { role: "group" } });
      for (const [v, label] of choices) {
        const b = g.createEl("button", { text: label, attr: { type: "button", "aria-pressed": String(this.opts[key] === v) } });
        b.toggleClass("is-active", this.opts[key] === v);
        b.addEventListener("click", () => {
          this.opts[key] = v;
          this.plugin.settings.share = { ...this.opts };
          void this.plugin.saveSettings();
          this.draw();
        });
      }
    };
    group("format", [["wide", t().shareWide], ["story", t().shareStory]]);
    group("theme", [["light", t().shareLight], ["dark", t().shareDark]]);
    group("days", [[7, t().ranges["7"]], [30, t().ranges["30"]], [90, t().ranges["90"]]]);

    const box = el.createDiv({ cls: "pp-share-preview" });
    box.toggleClass("is-story", this.opts.format === "story");
    this.canvas = box.createEl("canvas", { attr: { role: "img", "aria-label": t().shareTitle } });
    drawCard(this.canvas, data, this.opts, this.family());

    el.createEl("p", { cls: "pp-muted pp-share-hint", text: this.opts.format === "story" ? t().shareStoryHint : t().shareWideHint });

    const foot = el.createDiv({ cls: "modal-button-container" });
    const button = (text: string, mode: "copy" | "save" | "download", cta = false) =>
      foot.createEl("button", { cls: cta ? "mod-cta" : "", text, attr: { type: "button" } }).addEventListener("click", () => void this.export(mode));
    button(t().shareCopy, "copy");
    // A file saved outside the vault needs a desktop's save dialog; on a phone the vault is the place.
    if (Platform.isDesktopApp) { button(t().shareSave, "save"); button(t().shareDownload, "download", true); }
    else button(t().shareSave, "save", true);
  }

  /**
   * Copy puts the image on the clipboard; where that isn't possible it falls back to saving.
   * Save puts a PNG in the vault and opens it. Download asks where on the computer to put it.
   */
  private async export(mode: "copy" | "save" | "download") {
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/png"));
    if (!blob) { new Notice(t().shareFailed); return; }
    if (mode === "download") { await this.download(blob); return; }
    if (mode === "copy") {
      try {
        if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("clipboard");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        new Notice(t().shareCopied);
        return;
      } catch {
        new Notice(t().shareCopyFallback);
      }
    }
    try {
      const path = await this.freePath(this.fileName());
      const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
      new Notice(t().exported(path));
      this.close();
      if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
    } catch {
      new Notice(t().shareFailed);
    }
  }

  private fileName() { return `${t().appName} ${this.opts.format === "story" ? "story" : "card"} ${this.cardDate()}.png`; }

  /** The system's save dialog where the app has one, otherwise a plain browser download. */
  private async download(blob: Blob) {
    const name = this.fileName();
    type Picker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
    const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker.call(window, { suggestedName: name, types: [{ description: "PNG", accept: { "image/png": [".png"] } }] });
        const out = await handle.createWritable();
        await out.write(blob);
        await out.close();
        new Notice(t().shareDownloaded);
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // closed the dialog
      }
    }
    const url = URL.createObjectURL(blob);
    createEl("a", { href: url, attr: { download: name } }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private cardDate() { return cardData(this.plugin, this.opts.days, 1)?.date ?? new Date().toISOString().slice(0, 10); }

  /** Obsidian's attachment folder setting decides where; a number is added when the name is taken. */
  private async freePath(name: string): Promise<string> {
    try { return await this.app.fileManager.getAvailablePathForAttachment(name); } catch { /* below */ }
    const dot = name.lastIndexOf("."), base = name.slice(0, dot), ext = name.slice(dot);
    let path = normalizePath(name);
    for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${base} ${i}${ext}`);
    return path;
  }

  onClose(): void { this.contentEl.empty(); }
}
