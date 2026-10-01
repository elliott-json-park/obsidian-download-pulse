import {
  Chart, LineController, BarController, LineElement, BarElement, PointElement,
  CategoryScale, LinearScale, LogarithmicScale, Filler, Tooltip,
  type Plugin, type Scale, type ScriptableContext, type ScriptableLineSegmentContext, type TooltipItem,
} from "chart.js";
import { t } from "../i18n";
import { alpha, fmt, shortDate } from "./util";
import { mean } from "../analysis";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, CategoryScale, LinearScale, LogarithmicScale, Filler, Tooltip);

// Horizontal bars are wide, so the default anchor — the bar's far end — can sit far from the cursor.
// Anchoring at the cursor keeps the tooltip beside the pointer as it moves along a bar.
type CursorPositioner = (items: readonly TI[], eventPosition?: { x: number; y: number }) => { x: number; y: number } | false;
const cursorPositioner: CursorPositioner = (_items, eventPosition) => (eventPosition ? { x: eventPosition.x, y: eventPosition.y } : false);
(Tooltip.positioners as unknown as Record<string, CursorPositioner>).cursor = cursorPositioner;

export { Chart };

/** The dashboard's colors, read from the theme each render so light, dark and custom themes all fit. */
export interface Palette {
  ink1: string; ink2: string; ink3: string; grid: string; axis: string; surface: string; page: string;
  up: string; down: string; series: string[]; font: string;
}

const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/**
 * Obsidian may render a view or a code block before it is attached to the page, when none of the
 * stylesheet's variables resolve yet. Then the theme's own variables on <body> and the built-in
 * palette stand in, so nothing is drawn black.
 */
export function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el), body = getComputedStyle(activeDocument.body);
  const dark = activeDocument.body.hasClass("theme-dark");
  const v = (n: string, theme: string, fallback = "") => cs.getPropertyValue(n).trim() || body.getPropertyValue(theme).trim() || fallback;
  return {
    ink1: v("--pp-ink-1", "--text-normal", "#222"), ink2: v("--pp-ink-2", "--text-muted", "#5c5c5c"), ink3: v("--pp-ink-3", "--text-faint", "#ababab"),
    grid: v("--pp-grid", "--background-modifier-border", "#e3e3e3"), axis: v("--pp-axis", "--background-modifier-border-hover", "#c9c9c9"),
    surface: v("--pp-surface", "--background-primary", "#fff"), page: v("--pp-page", "--background-primary", "#fff"),
    up: v("--pp-up", "", dark ? "#0ca30c" : "#006300"), down: v("--pp-down", "", dark ? "#e66767" : "#b3261e"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--pp-s${i}`, "", (dark ? SERIES_DARK : SERIES_LIGHT)[i - 1])),
    font: cs.fontFamily || body.fontFamily,
  };
}

// ---------- the slice of Chart.js options this dashboard uses ----------
export type TI = TooltipItem<"line" | "bar">;
export type Tick = (this: Scale, value: number | string) => string;
export interface Axis {
  type?: "linear" | "logarithmic";
  beginAtZero?: boolean; reverse?: boolean; stacked?: boolean; max?: number;
  grid?: Record<string, unknown>; border?: Record<string, unknown>; title?: Record<string, unknown>;
  ticks: { color: string; padding?: number; precision?: number; maxRotation?: number; autoSkipPadding?: number; autoSkip?: boolean; callback?: Tick };
}
export interface Opts {
  responsive: boolean; maintainAspectRatio: boolean;
  animation: false | Record<string, unknown>;
  indexAxis: "x" | "y";
  interaction: Record<string, unknown>;
  layout?: { padding: { top?: number; right?: number } };
  scales: { x: Axis; y: Axis };
  plugins: {
    legend: { display: boolean };
    tooltip: Record<string, unknown> & {
      itemSort?: (a: TI, b: TI) => number;
      callbacks?: {
        title?: (items: TI[]) => string;
        label?: (it: TI) => string | string[];
        afterLabel?: (it: TI) => string;
        footer?: (items: TI[]) => string | string[];
      };
    };
  };
}
/** A dataset as this dashboard writes it: Chart.js properties plus a few flags of its own. */
export interface Ds { label?: string; data: (number | null)[]; isMA?: boolean; noEndLabel?: boolean; [k: string]: unknown }
export interface Cfg { type: "line" | "bar"; data: { labels: (string | number)[]; datasets: Ds[] }; options: Opts; plugins?: Plugin[] }

export function makeChart(cv: HTMLCanvasElement, cfg: Cfg): Chart {
  return new Chart(cv, cfg);
}

/** Tooltip values arrive untyped; every series here holds numbers. */
export const num = (v: unknown): number | null => typeof v === "number" ? v : null;
export const dateTick: Tick = function (v) { return shortDate(this.getLabelForValue(Number(v))); };
export const versionTick: Tick = function (v) { return "v" + this.getLabelForValue(Number(v)); };
export const dayTick: Tick = function (v) { return t().dayN(Number(this.getLabelForValue(Number(v)))); };

export function baseOptions(P: Palette, motion: boolean, o: { stacked?: boolean; indexAxis?: "x" | "y"; xTitle?: string; grow?: boolean; log?: boolean } = {}): Opts {
  const { stacked = false, indexAxis = "x", xTitle, grow = true, log = false } = o;
  const valueAxis: Axis = {
    type: log ? "logarithmic" : "linear",
    beginAtZero: !log, stacked,
    grid: { color: P.grid, drawTicks: false }, border: { display: false },
    ticks: { color: P.ink3, padding: 6, precision: 0, callback: (v) => log && !/^[125]/.test(String(v)) ? "" : fmt(Number(v)) },
  };
  const catAxis: Axis = {
    stacked, grid: { display: false }, border: { color: P.axis },
    ticks: { color: P.ink3, maxRotation: 0, autoSkipPadding: 14 },
    title: xTitle ? { display: true, text: xTitle, color: P.ink3, font: { size: 11 } } : undefined,
  };
  return {
    responsive: true, maintainAspectRatio: false,
    // Bars grow in turn from the bottom; lines are drawn left to right by the wipe plugin.
    animation: motion && grow ? { duration: 900, easing: "easeOutQuart", delay: (c: { type: string; mode: string; dataIndex: number }) => c.type === "data" && c.mode === "default" ? Math.min(c.dataIndex * 16, 700) : 0 } : false,
    indexAxis,
    interaction: { mode: indexAxis === "y" ? "nearest" : "index", intersect: false, axis: indexAxis === "y" ? "y" : "x" },
    plugins: {
      legend: { display: false },
      tooltip: {
        position: indexAxis === "y" ? "cursor" : "average",
        backgroundColor: P.surface, titleColor: P.ink1, bodyColor: P.ink1, footerColor: P.ink2, borderColor: P.axis, borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true, titleFont: { weight: "600" }, footerFont: { weight: "400" }, cornerRadius: 10,
      },
    },
    scales: indexAxis === "y" ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

// ---------- plugins ----------
/** How far each chart's wipe-in has got (0–1), shared with the labels that wait for it. */
const wiping = new WeakMap<Chart, number>();

/** Draws lines and areas as if wiped on from left to right. */
export function wipe(motion: boolean): Plugin {
  let t0: number | null = null;
  return {
    id: "wipe",
    beforeDatasetsDraw(c) {
      if (!motion) { wiping.set(c, 1); return; }
      t0 ??= performance.now();
      const k = Math.min(1, (performance.now() - t0) / 1300), e = 1 - Math.pow(1 - k, 3), a = c.chartArea;
      wiping.set(c, k);
      c.ctx.save(); c.ctx.beginPath(); c.ctx.rect(a.left - 6, 0, (a.width + 12) * e, c.height); c.ctx.clip();
    },
    afterDatasetsDraw(c) {
      if (!motion) return;
      c.ctx.restore();
      if ((wiping.get(c) ?? 1) < 1) window.requestAnimationFrame(() => { if (c.canvas?.isConnected) c.draw(); });
    },
  };
}

export const crosshair = (P: Palette): Plugin => ({
  id: "crosshair",
  afterDatasetsDraw(c) {
    const act = c.getActiveElements();
    if (!act.length || c.options.indexAxis === "y") return;
    const { ctx, chartArea: a } = c, x = act[0].element.x;
    ctx.save(); ctx.strokeStyle = P.ink3; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); ctx.restore();
  },
});

/** Writes each line's name and last value at its end. */
export function endLabels(P: Palette, val: (v: number) => string, rightPad: number): Plugin {
  return {
    id: "endLabels",
    afterDraw(c) {
      if ((wiping.get(c) ?? 1) < 1) return;
      const { ctx, chartArea: a } = c, items: { x: number; y: number; py: number; text: string; color: string }[] = [];
      c.data.datasets.forEach((ds, i) => {
        const d = ds as unknown as Ds;
        if (d.noEndLabel || !c.isDatasetVisible(i)) return;
        let j = d.data.length - 1;
        while (j >= 0 && d.data[j] == null) j--;
        if (j < 0) return;
        const pt = c.getDatasetMeta(i).data[j];
        items.push({ x: pt.x, y: pt.y, py: pt.y, text: `${d.label ?? ""} ${val(d.data[j] as number)}`, color: String(d.borderColor) });
      });
      items.sort((p, q) => p.y - q.y);
      for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 15) items[i].y = items[i - 1].y + 15;
      ctx.save(); ctx.font = `600 11.5px ${P.font}`; ctx.textBaseline = "middle";
      for (const it of items) {
        ctx.fillStyle = it.color; ctx.strokeStyle = P.surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(it.x, it.py, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        const w = ctx.measureText(it.text).width, left = it.x + 10 + w > a.right + rightPad;
        ctx.fillStyle = P.ink1; ctx.textAlign = left ? "right" : "left";
        ctx.fillText(it.text, left ? it.x - 10 : it.x + 10, left ? it.y - 12 : it.y);
      }
      ctx.restore();
    },
  };
}

export interface Marker { date: string; label: string; color: string; id: string }

/** Dotted vertical line on each release day. */
export function releaseMarkers(P: Palette, entries: Marker[], showLabels = true): Plugin {
  return {
    id: "releaseMarkers",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      const labels = chart.data.labels ?? [];
      ctx.save();
      ctx.font = `11px ${P.font}`;
      ctx.textAlign = "left";
      let lastLabelX = -Infinity;
      for (const r of entries) {
        const i = labels.indexOf(r.date);
        if (i < 0) continue;
        const px = x.getPixelForValue(i);
        ctx.strokeStyle = r.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
        if (showLabels && px - lastLabelX > 38 && px + 30 < a.right + 20) {
          ctx.fillStyle = P.ink3;
          ctx.fillText(r.label, px + 3, a.top + 10);
          lastLabelX = px;
        }
      }
      ctx.restore();
    },
  };
}

/** Shades the forecast part and draws the next milestone. */
export function forecastZone(P: Palette, lastIdx: number, milestone: number | null): Plugin {
  return {
    id: "forecastZone",
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x, y } } = c;
      if (lastIdx >= (c.data.labels?.length ?? 0) - 1) return;
      const px = x.getPixelForValue(lastIdx);
      ctx.save();
      const g = ctx.createLinearGradient(px, 0, a.right, 0);
      g.addColorStop(0, alpha(P.ink3, 0.15)); g.addColorStop(1, alpha(P.ink3, 0.02));
      ctx.fillStyle = g; ctx.fillRect(px, a.top, a.right - px, a.height);
      ctx.fillStyle = P.ink3; ctx.font = `11px ${P.font}`; ctx.textAlign = "left";
      ctx.fillText(t().forecastArrow, px + 6, a.bottom - 8);
      if (milestone && milestone <= y.max) {
        const py = y.getPixelForValue(milestone);
        ctx.strokeStyle = P.ink3; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText(t().goal(fmt(milestone)), a.left + 6, py - 6);
      }
      ctx.restore();
    },
  };
}

/** Labels the tallest bar. */
export function peakLabel(P: Palette, index: number, text: string, skip?: (ds: Ds) => boolean): Plugin {
  return {
    id: "peakLabel",
    afterDatasetsDraw(c) {
      if (index < 0) return;
      const metas = c.data.datasets.map((d, i) => skip?.(d as unknown as Ds) ? null : c.getDatasetMeta(i).data[index]).filter((m) => m != null);
      if (!metas.length) return;
      const a = c.chartArea;
      c.ctx.save(); c.ctx.font = `600 11.5px ${P.font}`; c.ctx.fillStyle = P.ink1;
      if (c.options.indexAxis === "y") {
        const m = metas[0], right = m.x, flip = right + 10 + c.ctx.measureText(text).width > a.right;
        c.ctx.textBaseline = "middle";
        c.ctx.textAlign = flip ? "right" : "left";
        c.ctx.fillText(text, flip ? right - 10 : right + 10, m.y);
      } else {
        const top = Math.min(...metas.map((m) => m.y)), x = metas[0].x, edge = x > a.right - 40;
        c.ctx.textAlign = edge ? "right" : "center";
        c.ctx.fillText(text, edge ? a.right : x, top - 7);
      }
      c.ctx.restore();
    },
  };
}

// ---------- datasets ----------
export function areaFill(color: string, top = 0.33, bottom = 0.02): (c: ScriptableContext<"line">) => CanvasGradient | string {
  return (c) => {
    const a = c.chart.chartArea;
    if (!a) return alpha(color, top);
    const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, alpha(color, top)); g.addColorStop(1, alpha(color, bottom));
    return g;
  };
}

export function lineDataset(P: Palette, data: (number | null)[], color: string, fill = false): Ds {
  return {
    data, borderColor: color, backgroundColor: fill ? areaFill(color) : color, fill,
    borderWidth: 2, cubicInterpolationMode: "monotone", spanGaps: true,
    pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: P.surface,
    pointBackgroundColor: color, pointHoverBackgroundColor: color,
  };
}

export const forecastSegment = (lastIdx: number, color: string): Record<string, (c: ScriptableLineSegmentContext) => unknown> => ({
  borderDash: (c) => c.p0DataIndex >= lastIdx ? [5, 5] : undefined,
  backgroundColor: (c) => c.p0DataIndex >= lastIdx ? alpha(color, 0.11) : undefined,
});

/** Continues the last 7 days' average pace for `h` days. */
export function project(lastTotal: number, dailies: (number | null)[], h: number): number[] {
  const pace = mean(dailies.filter((v): v is number => v != null).slice(-7));
  return Array.from({ length: h }, (_, i) => Math.round(lastTotal + pace * (i + 1)));
}
