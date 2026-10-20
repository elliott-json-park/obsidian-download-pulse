import type { Palette } from "./charts";
import { fmt, signed } from "./util";
import type { Tip } from "./util";
import { t } from "../i18n";

export interface Body { id: string; name: string; total: number; daily: number; pace: number; sum7: number; color: string; rank: number | null; stars: number }
interface Planet extends Body { angle: number; size: number; r: number; speed: number; tail: number; x: number; y: number; ring: number }

const TAU = Math.PI * 2;

/**
 * Plugins as planets seen from above: size is the total, orbit speed and the length of the trail behind it are the
 * last 7 days' pace, and the small dots circling a planet are its GitHub stars. The biggest plugin orbits innermost;
 * the middle shows the sum. Pointing at a planet steps the others back; clicking it opens that plugin.
 */
export class Orrery {
  private ctx: CanvasRenderingContext2D;
  private W = 0; private H = 0;
  private planets: Planet[] = [];
  private hover: Planet | null = null;
  private raf = 0; private last = 0; private visible = true; private clock = 0;
  private focus: string | null = null;
  private centre = "";
  private ro: ResizeObserver; private io: IntersectionObserver;

  constructor(private cv: HTMLCanvasElement, private P: () => Palette, private motion: () => boolean, private tip: Tip, private onPick: (id: string) => void) {
    this.ctx = cv.getContext("2d") as CanvasRenderingContext2D;
    cv.addEventListener("pointermove", (e) => {
      this.hover = this.hit(e);
      cv.toggleClass("is-pointing", !!this.hover);
      const h = this.hover;
      if (h) this.tip.show(`**${h.name}** ${fmt(h.total)}\n${t().latestShort} ${signed(h.daily)} · ${t().days7} ${signed(h.sum7)}` + (h.rank ? ` · ${t().rankChip(fmt(h.rank))}` : "") + (h.stars ? `\n${t().starsN(fmt(h.stars))}` : ""), e.clientX, e.clientY, cv);
      else this.tip.hide();
      if (!this.motion()) this.draw(0);
    });
    cv.addEventListener("pointerleave", () => { this.hover = null; this.tip.hide(); if (!this.motion()) this.draw(0); });
    cv.addEventListener("click", (e) => { const p = this.hit(e); if (p) { this.tip.hide(); this.onPick(p.id); } });
    this.ro = new ResizeObserver(() => { this.resize(); if (!this.motion()) this.draw(0); });
    this.ro.observe(cv);
    this.io = new IntersectionObserver((es) => { this.visible = es[0].isIntersecting; this.kick(); });
    this.io.observe(cv);
  }

  /** `centre` names the sum written in the middle ("All plugins", "Group"). */
  sync(bodies: Body[], focus: string | null, centre = ""): void {
    const old = new Map(this.planets.map((p) => [p.id, p.angle]));
    const maxT = Math.max(1, ...bodies.map((b) => b.total)), maxP = Math.max(1, ...bodies.map((b) => b.pace));
    // The biggest orbits innermost. sqrt keeps a plugin a thousand times smaller than its neighbour still visible.
    const byTotal = [...bodies].sort((a, b) => b.total - a.total);
    this.planets = bodies.map((b, i) => ({
      ...b, angle: old.get(b.id) ?? (i * 2.2 - 0.4), size: Math.sqrt(b.total / maxT), r: 0,
      speed: 0.05 + 0.18 * b.pace / maxP, tail: 0.25 + 1.4 * b.pace / maxP, x: 0, y: 0, ring: byTotal.indexOf(b),
    }));
    this.focus = focus;
    this.centre = centre;
    this.resize();
    if (!this.motion()) this.draw(0);
    this.kick();
  }

  destroy(): void {
    window.cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
  }

  private resize() {
    const r = this.cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    const k = Math.max(0.7, Math.min(1, Math.min(this.W, this.H) / 320));
    this.planets.forEach((p) => p.r = (4 + 8 * p.size) * k);
    this.cv.width = Math.max(1, this.W * dpr); this.cv.height = Math.max(1, this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private outer() { return Math.max(50, Math.min(this.W, this.H) / 2 - 22); }
  private orbit(ring: number) { const n = this.planets.length; return (this.outer() - 10) * (n > 1 ? 0.4 + 0.6 * ring / (n - 1) : 0.66); }

  private draw(dt: number) {
    const { ctx, W, H } = this, P = this.P();
    const cx = W / 2, cy = H / 2;
    this.clock += dt;
    ctx.clearRect(0, 0, W, H);
    // Thin orbits only.
    ctx.lineWidth = 1; ctx.strokeStyle = P.grid;
    this.planets.forEach((p) => { ctx.beginPath(); ctx.arc(cx, cy, this.orbit(p.ring), 0, TAU); ctx.stroke(); });
    // The sum in the middle.
    const sum = this.planets.reduce((n, p) => n + p.total, 0);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(Math.min(22, Math.max(15, this.outer() * 0.13)))}px ${P.font}`; ctx.fillStyle = P.ink1;
    ctx.fillText(fmt(sum), cx, cy - 5);
    if (this.centre) { ctx.font = `11px ${P.font}`; ctx.fillStyle = P.ink3; ctx.fillText(this.centre, cx, cy + 13); }

    for (const p of this.planets) {
      p.angle += p.speed * dt;
      const ro = this.orbit(p.ring), dim = (this.focus && this.focus !== p.id) || (this.hover && this.hover !== p);
      p.x = cx + Math.cos(p.angle) * ro; p.y = cy + Math.sin(p.angle) * ro;
      // The trail behind it: as long as its pace is fast, fading out.
      ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.lineCap = "butt";
      const N = 28;
      for (let k = 0; k < N; k++) {
        ctx.globalAlpha = (dim ? 0.15 : 0.6) * (1 - k / N);
        ctx.beginPath(); ctx.arc(cx, cy, ro, p.angle - (k + 1) * p.tail / N, p.angle - k * p.tail / N + 0.004); ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.fillStyle = P.page; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 2.5, 0, TAU); ctx.fill();
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      // GitHub stars: small moons circling the planet (up to 8).
      const moons = Math.min(8, p.stars);
      ctx.fillStyle = P.ink3;
      for (let j = 0; j < moons; j++) {
        const a = this.clock * (0.9 + j * 0.06) + j * TAU / moons, mr = p.r + 5.5 + (j % 2) * 2.5;
        ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * mr, p.y + Math.sin(a) * mr, 1.3, 0, TAU); ctx.fill();
      }
      if (this.hover === p || this.focus === p.id) { ctx.strokeStyle = P.ink1; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (moons ? 11 : 5), 0, TAU); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    this.labels(cx, cy, P);
  }

  /**
   * Names and numbers next to each planet, biggest first: outside the orbit when there is room, else the other side or
   * a step up or down, so no label covers another, a planet or the sum in the middle.
   */
  private labels(cx: number, cy: number, P: Palette) {
    const { ctx, W, H } = this;
    const boxes = [{ x0: cx - 38, x1: cx + 38, y0: cy - 20, y1: cy + 22 }];
    const clash = (b: { x0: number; x1: number; y0: number; y1: number }) => b.x0 < 2 || b.x1 > W - 2 || b.y0 < 0 || b.y1 > H ||
      boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) ||
      this.planets.some((q) => { const nx = Math.max(b.x0, Math.min(q.x, b.x1)), ny = Math.max(b.y0, Math.min(q.y, b.y1)); return Math.hypot(q.x - nx, q.y - ny) < q.r + 2; });
    for (const p of [...this.planets].sort((a, b) => b.total - a.total)) {
      const dim = (this.focus && this.focus !== p.id) || (this.hover && this.hover !== p);
      const sub = `${fmt(p.total)} · ${t().days7} ${signed(p.sum7)}`;
      ctx.font = `600 12px ${P.font}`;
      const w1 = ctx.measureText(p.name).width;
      ctx.font = `11px ${P.font}`;
      const w = Math.max(w1, ctx.measureText(sub).width), off = p.r + 9 + (Math.min(8, p.stars) ? 5 : 0);
      const pref = Math.cos(p.angle) >= 0;
      let pick: { x0: number; x1: number; y0: number; y1: number; dy: number } | null = null;
      for (const side of [pref, !pref]) for (const dy of [0, -18, 18, -32, 32]) {
        if (pick) break;
        const x0 = side ? p.x + off : p.x - off - w, b = { x0, x1: x0 + w, y0: p.y + dy - 15, y1: p.y + dy + 15, dy };
        if (!clash(b)) pick = b;
      }
      if (!pick) { const x0 = Math.max(2, Math.min(W - w - 2, pref ? p.x + off : p.x - off - w)); pick = { x0, x1: x0 + w, y0: p.y - 15, y1: p.y + 15, dy: 0 }; }
      boxes.push(pick);
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `${this.hover === p ? 700 : 600} 12px ${P.font}`; ctx.fillStyle = P.ink1; ctx.fillText(p.name, pick.x0, p.y + pick.dy - 7);
      ctx.font = `11px ${P.font}`; ctx.fillStyle = P.ink3; ctx.fillText(sub, pick.x0, p.y + pick.dy + 8);
      ctx.globalAlpha = 1;
    }
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (!this.motion() || !this.visible || document.hidden || !this.cv.isConnected) return;
    // The frame's time can come before the time noted when the loop started; never step backwards.
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000 || 0)); this.last = now;
    this.draw(dt);
    this.raf = window.requestAnimationFrame(this.loop);
  };

  kick(): void {
    if (!this.raf && this.motion()) { this.last = performance.now(); this.raf = window.requestAnimationFrame(this.loop); }
    else if (!this.motion()) this.draw(0);
  }

  private hit(e: MouseEvent): Planet | null {
    const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return this.planets.find((p) => Math.hypot(p.x - x, p.y - y) < p.r + 10) ?? null;
  }
}
