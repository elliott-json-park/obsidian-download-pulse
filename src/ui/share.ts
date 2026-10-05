import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type PulsePlugin from "../main";
import { Model } from "../analysis";
import { addDays } from "../data/store";
import { t } from "../i18n";
import type { ShareOpts } from "../types";
import { SERIES_DARK, SERIES_LIGHT } from "./charts";
import { fmt, fmt1, signed } from "./util";

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
  /** Plugins left off the card for space: how many, and their downloads together. */
  more: { n: number; total: number } | null;
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
    more: rest.length ? { n: rest.length, total: rest.reduce((n, r) => n + r.total, 0) } : null,
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

function gainParts(d: CardData, k: Ink) {
  const [pre, post] = t().cardGain(d.days);
  return [{ s: pre, color: k.mute }, { s: signed(d.gain), color: k.up, weight: 600 }, { s: post, color: k.mute }];
}

function cardDate(d: string) { return t().cardDate(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)); }

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

function drawWide(ctx: Ctx, d: CardData, rows: Drawn[], k: Ink, f: string) {
  const L = 64, R = 1136;
  // header
  dot(ctx, L + 8, 70, 6, k.ink);
  ctx.strokeStyle = k.ring; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(L + 8, 70, 11.5, 0, Math.PI * 2); ctx.stroke();
  runs(ctx, [{ s: d.author ?? "", color: k.ink, weight: 600 }, { s: (d.author ? " · " : "") + t().cardPlugins(d.count), color: k.mute }], L + 36, 77, 20, f);
  font(ctx, 20, 400, f);
  text(ctx, cardDate(d.date), R, 77, k.mute, "right");

  // the big number
  font(ctx, 112, 700, f, -0.045);
  text(ctx, fmt(d.total), L - 4, 214, k.ink);
  const nw = ctx.measureText(fmt(d.total)).width;
  font(ctx, 22, 400, f);
  text(ctx, t().cardTotal, L + nw + 22, 180, k.mute);
  runs(ctx, gainParts(d, k), L + nw + 22, 212, 22, f);

  // one line per plugin
  const top = 256, foot = 612;
  const n = rows.length + (d.more ? 1 : 0);
  const rh = Math.min(84, (foot - 20 - top) / Math.max(1, n));
  rows.forEach((r, i) => {
    const y = top + i * rh;
    hairline(ctx, L, R, y, k.line, 1.5);
    const mid = y + rh / 2 + 8;
    dot(ctx, L + 6, mid - 7, 6, r.color);
    font(ctx, 22, 600, f);
    text(ctx, fit(ctx, r.name, 330), L + 28, mid, k.ink);
    spark(ctx, r.daily, 420, y + rh / 2 - 18, 220, 36, r.color, 2.5);
    font(ctx, 22, 400, f);
    text(ctx, fmt(r.total), 820, mid, k.ink, "right");
    text(ctx, r.gain == null ? "–" : signed(r.gain), 960, mid, k.up, "right");
    text(ctx, topText(r.topPct), R, mid, k.mute, "right");
  });
  if (d.more) {
    const y = top + rows.length * rh;
    hairline(ctx, L, R, y, k.line, 1.5);
    font(ctx, 20, 400, f);
    text(ctx, t().cardMore(d.more.n, fmt(d.more.total)), L + 28, y + rh / 2 + 7, k.mute);
  }

  // foot
  hairline(ctx, L, R, foot, k.ink, 1.5);
  runs(ctx, [{ s: t().cardMadePre, color: k.mute }, { s: t().appName, color: k.ink, weight: 600 }, { s: t().cardMadePost, color: k.mute }], L, foot + 36, 17, f);
  font(ctx, 17, 400, f);
  text(ctx, t().cardSource, R, foot + 36, k.mute, "right");
}

/** 9:16. Stories cover about the top and bottom 250px with their own buttons, so the card lives between. */
function drawStory(ctx: Ctx, d: CardData, rows: Drawn[], k: Ink, f: string) {
  const L = 96, R = 1080 - 96, W = R - L;
  // header
  dot(ctx, L + 10, 262, 8, k.ink);
  ctx.strokeStyle = k.ring; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(L + 10, 262, 15, 0, Math.PI * 2); ctx.stroke();
  font(ctx, 34, 600, f);
  text(ctx, fit(ctx, d.author ?? t().cardPlugins(d.count), W - 46), L + 46, 274, k.ink);
  font(ctx, 30, 400, f);
  text(ctx, (d.author ? t().cardPlugins(d.count) + " · " : "") + cardDate(d.date), L, 334, k.mute);

  // the big number
  font(ctx, 196, 700, f, -0.05);
  text(ctx, fmt(d.total), L - 8, 540, k.ink);
  font(ctx, 34, 400, f);
  text(ctx, t().cardTotal, L, 600, k.mute);
  runs(ctx, gainParts(d, k), L, 648, 34, f);

  // a block per plugin: name and total, the line, then the gain and rank
  const top = 712, foot = 1590;
  const n = rows.length + (d.more ? 1 : 0);
  const bh = Math.min(270, (foot - 24 - top) / Math.max(1, n));
  rows.forEach((r, i) => {
    const y = top + i * bh;
    hairline(ctx, L, R, y, k.line, 2);
    dot(ctx, L + 9, y + 50, 9, r.color);
    font(ctx, 36, 400, f);
    const total = fmt(r.total);
    const tw = ctx.measureText(total).width;
    text(ctx, total, R, y + 62, k.ink, "right");
    font(ctx, 36, 600, f);
    text(ctx, fit(ctx, r.name, W - tw - 80), L + 36, y + 62, k.ink);
    spark(ctx, r.daily, L, y + 92, W, Math.max(30, bh - 170), r.color, 4);
    font(ctx, 30, 400, f);
    text(ctx, r.gain == null ? "–" : signed(r.gain), L, y + bh - 28, k.up);
    text(ctx, topText(r.topPct), R, y + bh - 28, k.mute, "right");
  });
  if (d.more) {
    const y = top + rows.length * bh;
    hairline(ctx, L, R, y, k.line, 2);
    font(ctx, 28, 400, f);
    text(ctx, t().cardMore(d.more.n, fmt(d.more.total)), L + 36, y + 58, k.mute);
  }

  // foot
  hairline(ctx, L, R, foot, k.ink, 2);
  runs(ctx, [{ s: t().cardMadePre, color: k.mute }, { s: t().appName, color: k.ink, weight: 600 }, { s: t().cardMadePost, color: k.mute }], L, foot + 52, 30, f);
  font(ctx, 26, 400, f);
  text(ctx, t().cardSource, L, foot + 94, k.mute);
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
    foot.createEl("button", { text: t().shareCopy, attr: { type: "button" } }).addEventListener("click", () => void this.export("copy"));
    foot.createEl("button", { cls: "mod-cta", text: t().shareSave, attr: { type: "button" } }).addEventListener("click", () => void this.export("save"));
  }

  /** Copy puts the image on the clipboard; where that isn't possible it falls back to saving. Save puts a PNG in the vault and opens it. */
  private async export(mode: "copy" | "save") {
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/png"));
    if (!blob) { new Notice(t().shareFailed); return; }
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
      const tag = this.opts.format === "story" ? "story" : "card";
      const name = `${t().appName} ${tag} ${this.cardDate()}.png`;
      const path = await this.freePath(name);
      const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
      new Notice(t().exported(path));
      this.close();
      if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
    } catch {
      new Notice(t().shareFailed);
    }
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
