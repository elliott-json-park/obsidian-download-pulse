import { lang, loc, t } from "../i18n";
import { addDays } from "../data/store";
import { SMALL_BASE, type Momentum } from "../analysis";

// ---------- numbers & dates ----------
export const fmt = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : Math.round(n).toLocaleString(loc());
export const fmt1 = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : (Math.round(n * 10) / 10).toLocaleString(loc());
export const signed = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + Math.round(n).toLocaleString(loc());
export const shortDate = (d: string): string => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export const longDate = (d: string): string => t().longDate(+d.slice(5, 7), +d.slice(8, 10));
/** How strong a change reads: 1 under ±10%, 2 under ±30%, 3 beyond. */
const level = (ratio: number): number => Math.abs(ratio) < 0.1 ? 1 : Math.abs(ratio) < 0.3 ? 2 : 3;
/**
 * ▲ 12% as rich-text markup in three strengths, "steady" when it rounds to 0%, or "" when there is nothing to compare.
 * Tripled or more reads as a multiple (▲ 4.2×): "▲ 320%" is easy to misread as 3.2×.
 */
export function delta(ratio: number | null | undefined): string {
  if (ratio == null || !isFinite(ratio)) return "";
  const pct = Math.round(Math.abs(ratio) * 100);
  if (!pct) return `{flat|${t().steady}}`;
  const text = ratio >= 2 ? t().timesX(fmt1(1 + ratio)) : `${pct.toLocaleString(loc())}%`;
  return `{${ratio > 0 ? "up" : "down"}${level(ratio)}|${ratio > 0 ? "▲" : "▼"} ${text}}`;
}
/**
 * A momentum as rich text. A small earlier week shows the change as a count (▲ +12), since 3 → 9 as "▲ 200%"
 * would say more about chance than about change. "" without two full windows to compare.
 */
export function moText(mo: Momentum | null | undefined): string {
  if (!mo || mo.before == null) return "";
  if (!mo.small) return delta(mo.ratio);
  const diff = mo.recent - mo.before;
  return !diff ? `{flat|${t().steady}}` : `{${diff > 0 ? "up" : "down"}1|${diff > 0 ? "▲" : "▼"} ${signed(diff)}}`;
}
/** What a momentum compares, for its tooltip. */
export function moTip(mo: Momentum | null | undefined, extra: { mo28?: Momentum | null; run?: number; name?: string } = {}): string {
  const range = (a: string, b: string) => `${longDate(a)} – ${longDate(b)}`;
  const head = (extra.name ? `**${extra.name}** · ` : "") + t().moTipTitle(mo?.days ?? 7);
  if (!mo || mo.before == null) return [head, t().moTipShort].join("\n");
  const lines = [head,
    `${range(mo.from, mo.to)}  **${fmt(mo.recent)}**`,
    `${range(addDays(mo.from, -mo.days), addDays(mo.to, -mo.days))}  ${fmt(mo.before)}`,
    `${t().moTipChange}  ${moText(mo)}` + (mo.small ? "" : `  (${signed(mo.recent - mo.before)})`)];
  if (mo.small) lines.push(t().moTipSmall(SMALL_BASE));
  if (mo.estimated) lines.push(t().moTipEst);
  const more = [extra.mo28?.before != null ? t().moTip28(moText(extra.mo28)) : "", extra.run && Math.abs(extra.run) >= 2 ? (extra.run > 0 ? t().runUp(extra.run) : t().runDown(-extra.run)) : ""].filter(Boolean);
  if (more.length) lines.push(more.join(" · "));
  return lines.join("\n");
}
export const pct1 = (x: number): string => `${fmt1(x * 100)}%`;

// ---------- fonts ----------
const CJK_SC = ['"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', '"Noto Sans SC"', '"Source Han Sans SC"'];
const CJK_KR = ['"Apple SD Gothic Neo"', '"Malgun Gothic"', '"Noto Sans CJK KR"', '"Noto Sans KR"'];
const GENERIC = /^(sans-serif|serif|system-ui|ui-sans-serif|ui-serif|monospace|cursive|fantasy)$/i;
/**
 * A font stack for canvas text with Chinese and Korean faces before the generic family, so a theme font
 * without CJK glyphs still draws plugin names and labels in a matching face. Chinese faces come first in
 * Chinese, so shared Han characters take simplified-Chinese shapes.
 */
export function withCjk(family: string): string {
  const parts = family.split(",").map((s) => s.trim()).filter(Boolean);
  const have = new Set(parts.map((s) => s.replace(/["']/g, "").toLowerCase()));
  const extra = (lang() === "ko" ? [...CJK_KR, ...CJK_SC] : [...CJK_SC, ...CJK_KR]).filter((f) => !have.has(f.replace(/"/g, "").toLowerCase()));
  const generic = parts.filter((s) => GENERIC.test(s));
  return [...parts.filter((s) => !GENERIC.test(s)), ...extra, ...(generic.length ? generic : ["sans-serif"])].join(", ");
}

// ---------- safe rich text ----------
/** Appends text with **bold** and {up|…}/{down2|…}/{flat|…} markup (the digit is a strength, 1–3) as DOM nodes. Never parses HTML. */
export function rich(parent: HTMLElement, text: string): HTMLElement {
  const re = /\*\*(.+?)\*\*|\{(up|down|flat)([123])?\|(.+?)\}|\n/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendText(text.slice(last, m.index));
    if (m[1] != null) parent.createEl("b", { text: m[1] });
    else if (m[2]) parent.createSpan({ cls: ["pp-delta", m[2] === "flat" ? "" : "is-" + m[2], m[3] ? "is-s" + m[3] : ""].filter(Boolean).join(" "), text: m[4] });
    else parent.createEl("br");
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendText(text.slice(last));
  return parent;
}

// ---------- colors ----------
let probe: CanvasRenderingContext2D | null = null;
const parsed = new Map<string, [number, number, number, number]>();
/** Any CSS color → [r, g, b, a], so alpha can be added to colors themes write as hsl() or names. Memoised: charts ask per segment. */
export function rgba(color: string): [number, number, number, number] {
  const hit = parsed.get(color);
  if (hit) return hit;
  probe ??= createEl("canvas").getContext("2d");
  if (!probe) return [128, 128, 128, 1];
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  const v = String(probe.fillStyle);
  let out: [number, number, number, number];
  if (v.startsWith("#")) out = [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
  else { const m = v.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128, 1]; out = [m[0], m[1], m[2], m[3] ?? 1]; }
  parsed.set(color, out);
  return out;
}
export function alpha(color: string, a: number): string {
  const [r, g, b] = rgba(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---------- tooltip ----------
/** One floating tooltip per container. `[data-pp-tip]` elements hold rich text shown on hover and focus. */
export class Tip {
  el: HTMLElement;
  private texts = new WeakMap<Element, string>();
  private anchor: Element | null = null;
  private ox = 0; private oy = 0;
  private clean: (() => void) | null = null;

  constructor(private root: HTMLElement) {
    // Mounted on the body: fixed positioning must be viewport-relative, and Obsidian can wrap the
    // view in a transformed leaf that would otherwise become the fixed-position containing block.
    this.el = root.win.document.body.createDiv({ cls: "pp-tip", attr: { role: "tooltip" } });
    root.addEventListener("pointermove", (e) => {
      const target = (e.target as HTMLElement).closest?.("[data-pp-tip]");
      if (target && this.texts.has(target)) this.show(this.texts.get(target) as string, e.clientX, e.clientY, target);
      else if (!(e.target as HTMLElement).closest?.(".pp-orrery")) this.hide();
    });
    root.addEventListener("pointerleave", () => this.hide());
    root.addEventListener("focusin", (e) => {
      const target = (e.target as HTMLElement).closest?.("[data-pp-tip]");
      if (target && this.texts.has(target)) { const r = target.getBoundingClientRect(); this.show(this.texts.get(target) as string, r.left + r.width / 2, r.top, target); }
    });
    root.addEventListener("focusout", () => this.hide());
    const win = root.win;
    // While visible, hover tooltips follow their anchor as the content scrolls or the window resizes.
    win.addEventListener("scroll", this.follow, true);
    win.addEventListener("resize", this.follow);
    this.clean = () => { win.removeEventListener("scroll", this.follow, true); win.removeEventListener("resize", this.follow); };
  }

  /** Detaches the listeners and removes the body-mounted tooltip, which the view's own teardown would not reach. */
  disconnect(): void { this.clean?.(); this.clean = null; this.anchor = null; this.el.remove(); }

  bind(el: HTMLElement, text: string, focusable = true): HTMLElement {
    this.texts.set(el, text);
    el.setAttr("data-pp-tip", "");
    if (focusable && !el.hasAttribute("tabindex")) el.tabIndex = 0;
    return el;
  }

  show(text: string, x: number, y: number, anchor?: Element): void {
    this.anchor = anchor ?? null;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      this.ox = x - r.left; this.oy = y - r.top;
    }
    this.el.empty();
    rich(this.el, text);
    this.el.addClass("is-on");
    this.place(x, y);
  }

  /** Keeps an anchored tooltip glued to its element while the viewport moves under it. */
  private follow = (): void => {
    if (!this.anchor || !this.el.hasClass("is-on")) return;
    const r = (this.anchor as HTMLElement).getBoundingClientRect();
    if (!r.width && !r.height) return;
    this.place(r.left + this.ox, r.top + this.oy);
  };

  private place(x: number, y: number): void {
    const r = this.el.getBoundingClientRect(), win = this.el.win;
    const left = Math.max(8, Math.min(win.innerWidth - r.width - 8, x + 14));
    const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    this.el.setCssStyles({ left: left + "px", top: Math.max(8, top) + "px" });
  }

  hide(): void { this.el.removeClass("is-on"); this.anchor = null; }
}

// ---------- motion ----------
export function countUp(el: HTMLElement & { _raf?: number; _val?: number }, to: number, motion: boolean, opts: { from?: number; prefix?: string; dur?: number } = {}): void {
  const { from = 0, prefix = "", dur = 1400 } = opts;
  const text = (v: number) => (prefix === "+" && v > 0 ? "+" : "") + Math.round(v).toLocaleString(loc());
  const win = el.win ?? window;
  if (el._raf) win.cancelAnimationFrame(el._raf);
  if (!motion || from === to) { el.setText(text(to)); el._val = to; return; }
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el._val = from + (to - from) * e;
    el.setText(text(el._val));
    if (k < 1) el._raf = win.requestAnimationFrame(step); else el._val = to;
  };
  el._raf = win.requestAnimationFrame(step);
}

/** Cards fade in as they scroll into view, and charts are built only then, so their animation plays in sight. */
export class Revealer {
  private io: IntersectionObserver;
  private hooks = new WeakMap<Element, () => void>();
  constructor(private motion: () => boolean) {
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.io.unobserve(e.target);
        this.fire(e.target as HTMLElement);
      }
    }, { rootMargin: "0px 0px -4% 0px" });
  }
  private fire(el: HTMLElement) {
    el.addClass("is-in");
    this.hooks.get(el)?.();
    this.hooks.delete(el);
    el.querySelectorAll<HTMLElement>("[data-pp-count]").forEach((n) =>
      countUp(n, Number(n.dataset.ppCount), this.motion(), { prefix: n.dataset.ppPrefix || "" }));
  }
  add(el: HTMLElement, i = 0, fn?: () => void): HTMLElement {
    el.addClass("pp-rv");
    el.setCssProps({ "--pp-i": String(i) });
    if (fn) this.hooks.set(el, fn);
    this.io.observe(el);
    return el;
  }
  disconnect(): void { this.io.disconnect(); }
}

// ---------- sparklines ----------
export function sparkline(parent: HTMLElement, values: (number | null)[], color: string): void {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return;
  const max = Math.max(...v), min = Math.min(...v), span = max - min || 1;
  const d = v.map((y, i) => (i ? "L" : "M") + (i / (v.length - 1) * 100).toFixed(1) + " " + (27 - (y - min) / span * 24).toFixed(1)).join("");
  const svg = parent.createSvg("svg", { cls: "pp-spark", attr: { viewBox: "0 0 100 30", preserveAspectRatio: "none", "aria-hidden": "true" } });
  svg.createSvg("path", { cls: "pp-spark-line", attr: { d, stroke: color, "vector-effect": "non-scaling-stroke" } });
}

/**
 * One scale for several bar sparklines, so their sizes compare too — but only when they are within
 * 10× of each other. Next to a plugin a hundred times bigger, a shared scale would flatten the rest.
 */
export function sharedMax(rows: (number | null)[][]): number | null {
  const peaks = rows.map((r) => Math.max(0, ...r.map((v) => v ?? 0))).filter((v) => v > 0);
  if (!peaks.length) return null;
  const hi = Math.max(...peaks), lo = Math.min(...peaks);
  return hi / lo <= 10 ? hi : null;
}

/**
 * Bars per day. Passing the same `max` to several makes their sizes comparable too.
 * `avg` splits the bars in two equal windows, as momentum compares them: the earlier one faded,
 * a divider between, and each window's daily average as a dashed line across it.
 */
export function sparkBars(parent: HTMLElement, values: (number | null)[], color: string, max = Math.max(1, ...values.map((v) => v ?? 0)), avg?: [number, number]): void {
  if (!values.length) return;
  const w = 100 / values.length, half = Math.floor(values.length / 2);
  if (avg) max = Math.max(max, ...avg);
  // Obsidian's createSvg adds `cls` with classList.add, which throws on a space: several classes go as an array.
  const svg = parent.createSvg("svg", { cls: avg ? ["pp-spark", "is-split"] : "pp-spark", attr: { viewBox: "0 0 100 30", preserveAspectRatio: "none", "aria-hidden": "true" } });
  const y = (v: number) => (30 - Math.max(0.8, v / max * 29)).toFixed(2);
  values.forEach((v, i) => {
    if (v == null) return;
    const h = Math.max(0.8, v / max * 29);
    svg.createSvg("rect", { ...(avg && i < half ? { cls: "is-before" } : {}), attr: { x: (i * w + w * 0.15).toFixed(2), width: (w * 0.7).toFixed(2), y: (30 - h).toFixed(2), height: h.toFixed(2), fill: color } });
  });
  if (!avg) return;
  const line = (x1: number, x2: number, v: number, cls: string[]) => svg.createSvg("line", { cls, attr: { x1, x2, y1: y(v), y2: y(v), stroke: color, "vector-effect": "non-scaling-stroke" } });
  svg.createSvg("line", { cls: "pp-spark-split", attr: { x1: half * w, x2: half * w, y1: 0, y2: 30, "vector-effect": "non-scaling-stroke" } });
  line(0, half * w, avg[0], ["pp-spark-avg", "is-before"]);
  line(half * w, 100, avg[1], ["pp-spark-avg"]);
}

export function swatch(parent: HTMLElement, color: string): HTMLElement {
  const s = parent.createSpan({ cls: "pp-swatch" });
  s.setCssProps({ "--pp-c": color });
  return s;
}
