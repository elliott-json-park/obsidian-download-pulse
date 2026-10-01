import type { Palette } from "./charts";
import { fmt, signed } from "./util";
import type { Tip } from "./util";
import { t } from "../i18n";

export interface Body { id: string; name: string; total: number; daily: number; pace: number; color: string; rank: number | null }
interface Planet extends Body { i: number; angle: number; size: number; r: number; speed: number; x: number; y: number }

const TAU = Math.PI * 2;

/**
 * Plugins as planets seen from above: size is the total, orbit speed is the last 7 days' pace.
 * Clicking a planet opens that plugin.
 */
export class Orrery {
  private ctx: CanvasRenderingContext2D;
  private W = 0; private H = 0;
  private planets: Planet[] = [];
  private hover: Planet | null = null;
  private raf = 0; private last = 0; private visible = true; private dial = 0;
  private focus: string | null = null;
  private ro: ResizeObserver; private io: IntersectionObserver;

  constructor(private cv: HTMLCanvasElement, private P: () => Palette, private motion: () => boolean, private tip: Tip, private onPick: (id: string) => void) {
    this.ctx = cv.getContext("2d") as CanvasRenderingContext2D;
    cv.addEventListener("pointermove", (e) => {
      this.hover = this.hit(e);
      cv.toggleClass("is-pointing", !!this.hover);
      const h = this.hover;
      if (h) this.tip.show(`**${h.name}** ${fmt(h.total)}\n${t().latestShort} ${signed(h.daily)}` + (h.rank ? ` · ${t().rankChip(fmt(h.rank))}` : ""), e.clientX, e.clientY);
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

  sync(bodies: Body[], focus: string | null): void {
    const old = new Map(this.planets.map((p) => [p.id, p.angle]));
    const maxT = Math.max(1, ...bodies.map((b) => b.total)), maxP = Math.max(1, ...bodies.map((b) => b.pace));
    // sqrt keeps a plugin a thousand times smaller than its neighbour still visible.
    this.planets = bodies.map((b, i) => ({ ...b, i, angle: old.get(b.id) ?? (i * 2.2 - 0.9), size: Math.sqrt(b.total / maxT), r: 0, speed: 0.07 + 0.2 * b.pace / maxP, x: 0, y: 0 }));
    this.focus = focus;
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
    this.planets.forEach((p) => p.r = (4 + 7 * p.size) * k);
    this.cv.width = Math.max(1, this.W * dpr); this.cv.height = Math.max(1, this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private outer() { return Math.max(50, Math.min(this.W, this.H) / 2 - 22); }
  private orbit(i: number) { const n = this.planets.length; return (this.outer() - 26) * (n > 1 ? 0.36 + 0.64 * i / (n - 1) : 0.66); }

  private draw(dt: number) {
    const { ctx, W, H } = this, P = this.P();
    const cx = W / 2, cy = H / 2, R = this.outer();
    ctx.clearRect(0, 0, W, H);
    // The outer dial turns very slowly.
    this.dial += dt * 0.03;
    ctx.lineWidth = 1;
    for (let k = 0; k < 120; k++) {
      const a = this.dial + k / 120 * TAU, major = k % 10 === 0, r0 = R - (major ? 7 : 3);
      ctx.strokeStyle = major ? P.ink3 : P.axis;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    }
    ctx.strokeStyle = P.grid;
    this.planets.forEach((p) => { ctx.beginPath(); ctx.arc(cx, cy, this.orbit(p.i), 0, TAU); ctx.stroke(); });
    ctx.strokeStyle = P.axis; ctx.beginPath(); ctx.arc(cx, cy, 9, 0, TAU); ctx.stroke();
    ctx.fillStyle = P.ink1; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, TAU); ctx.fill();
    for (const p of this.planets) {
      p.angle += p.speed * dt;
      const ro = this.orbit(p.i), dim = this.focus && this.focus !== p.id;
      p.x = cx + Math.cos(p.angle) * ro; p.y = cy + Math.sin(p.angle) * ro;
      // The path behind it, fading out.
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.lineCap = "butt";
      const N = 28, span = 1.5;
      for (let k = 0; k < N; k++) {
        ctx.globalAlpha = (dim ? 0.25 : 0.9) * (1 - k / N) ** 2;
        ctx.beginPath(); ctx.arc(cx, cy, ro, p.angle - (k + 1) * span / N, p.angle - k * span / N + 0.004); ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.fillStyle = P.page; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 3, 0, TAU); ctx.fill();
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      if (this.hover === p || this.focus === p.id) { ctx.strokeStyle = P.ink1; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5, 0, TAU); ctx.stroke(); }
      // Name on the outside of the orbit, flipped inward if it would leave the canvas.
      const right = Math.cos(p.angle) >= 0, lx = p.x + (right ? p.r + 9 : -p.r - 9);
      ctx.textAlign = right ? "left" : "right"; ctx.textBaseline = "middle";
      ctx.font = `600 12px ${P.font}`;
      const w = ctx.measureText(p.name).width;
      const flip = right ? lx + w > W - 2 : lx - w < 2;
      const tx = flip ? p.x + (right ? -p.r - 9 : p.r + 9) : lx;
      if (flip) ctx.textAlign = right ? "right" : "left";
      ctx.fillStyle = P.ink1; ctx.fillText(p.name, tx, p.y - 6);
      ctx.font = `11px ${P.font}`; ctx.fillStyle = P.ink3; ctx.fillText(fmt(p.total), tx, p.y + 8);
      ctx.globalAlpha = 1;
    }
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (!this.motion() || !this.visible || document.hidden || !this.cv.isConnected) return;
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0); this.last = now;
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
