import { loc, t } from "../i18n";

// ---------- numbers & dates ----------
export const fmt = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : Math.round(n).toLocaleString(loc());
export const fmt1 = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : (Math.round(n * 10) / 10).toLocaleString(loc());
export const signed = (n: number | null | undefined): string => n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + Math.round(n).toLocaleString(loc());
export const shortDate = (d: string): string => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export const longDate = (d: string): string => t().longDate(+d.slice(5, 7), +d.slice(8, 10));
/** ▲ 12% as rich-text markup, or "" when there is nothing to compare. */
export function delta(ratio: number | null | undefined): string {
  if (ratio == null || !isFinite(ratio)) return "";
  const pct = Math.round(Math.abs(ratio) * 100);
  return ratio > 0.005 ? `{up|▲ ${pct}%}` : ratio < -0.005 ? `{down|▼ ${pct}%}` : `{flat|– ${pct}%}`;
}
export const pct1 = (x: number): string => `${fmt1(x * 100)}%`;

// ---------- safe rich text ----------
/** Appends text with **bold** and {up|…}/{down|…}/{flat|…} markup as DOM nodes. Never parses HTML. */
export function rich(parent: HTMLElement, text: string): HTMLElement {
  const re = /\*\*(.+?)\*\*|\{(up|down|flat)\|(.+?)\}|\n/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendText(text.slice(last, m.index));
    if (m[1] != null) parent.createEl("b", { text: m[1] });
    else if (m[2]) parent.createSpan({ cls: `pp-delta ${m[2] === "flat" ? "" : "is-" + m[2]}`, text: m[3] });
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
  constructor(private root: HTMLElement) {
    this.el = root.createDiv({ cls: "pp-tip", attr: { role: "tooltip" } });
    root.addEventListener("pointermove", (e) => {
      const target = (e.target as HTMLElement).closest?.("[data-pp-tip]");
      if (target && this.texts.has(target)) this.show(this.texts.get(target) as string, e.clientX, e.clientY);
      else if (!(e.target as HTMLElement).closest?.(".pp-orrery")) this.hide();
    });
    root.addEventListener("pointerleave", () => this.hide());
    root.addEventListener("focusin", (e) => {
      const target = (e.target as HTMLElement).closest?.("[data-pp-tip]");
      if (target && this.texts.has(target)) { const r = target.getBoundingClientRect(); this.show(this.texts.get(target) as string, r.left + r.width / 2, r.top); }
    });
    root.addEventListener("focusout", () => this.hide());
  }
  bind(el: HTMLElement, text: string, focusable = true): HTMLElement {
    this.texts.set(el, text);
    el.setAttr("data-pp-tip", "");
    if (focusable && !el.hasAttribute("tabindex")) el.tabIndex = 0;
    return el;
  }
  show(text: string, x: number, y: number): void {
    this.el.empty();
    rich(this.el, text);
    this.el.addClass("is-on");
    const r = this.el.getBoundingClientRect(), win = this.el.win;
    const left = Math.max(8, Math.min(win.innerWidth - r.width - 8, x + 14));
    const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    this.el.setCssStyles({ left: left + "px", top: Math.max(8, top) + "px" });
  }
  hide(): void { this.el.removeClass("is-on"); }
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

/** Bars per day. Passing the same `max` to several makes their sizes comparable too. */
export function sparkBars(parent: HTMLElement, values: (number | null)[], color: string, max = Math.max(1, ...values.map((v) => v ?? 0))): void {
  if (!values.length) return;
  const w = 100 / values.length;
  const svg = parent.createSvg("svg", { cls: "pp-spark", attr: { viewBox: "0 0 100 30", preserveAspectRatio: "none", "aria-hidden": "true" } });
  values.forEach((v, i) => {
    if (v == null) return;
    const h = Math.max(0.8, v / max * 29);
    svg.createSvg("rect", { attr: { x: (i * w + w * 0.15).toFixed(2), width: (w * 0.7).toFixed(2), y: (30 - h).toFixed(2), height: h.toFixed(2), fill: color } });
  });
}

export function swatch(parent: HTMLElement, color: string): HTMLElement {
  const s = parent.createSpan({ cls: "pp-swatch" });
  s.setCssProps({ "--pp-c": color });
  return s;
}
