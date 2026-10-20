import { setIcon } from "obsidian";
import type { Plugin as ChartPlugin } from "chart.js";
import type { DashboardView } from "./dashboard";
import { NICE, mean, weekdayOf, type Analysis, type Pt, type TotalPt, type RecordItem } from "../analysis";
import type { Calibration } from "../forecast";
import { addDays, dayDiff } from "../data/store";
import { cachedPluginList, fetchPluginList } from "../data/sources";
import { t } from "../i18n";
import { baseOptions, dateTick, num, type Ds, type TI } from "./charts";
import { fmt, fmt1, signed, delta, shortDate, longDate, rich, swatch, alpha } from "./util";

/*
 * Cards carried over from the standalone dashboard: the outlook, where the week's change came from, months,
 * records, the overtaking ladder, the stream of daily downloads, the race of totals, and how releases landed.
 * Each card opens with one plain sentence (its lede) saying what to look at.
 */

const pctText = (v: number) => `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };

/** "May 3–6", or one date when both ends match. */
export function dateSpan(a: string, b: string | null): string {
  if (!b) return t().after(longDate(a));
  return a === b ? longDate(a) : t().between(longDate(a), longDate(b));
}

/** What the last three weeks of forecasts did: for the note under the outlook. */
export function calibNote(cal: Calibration): string {
  if (!cal.n) return "";
  if (!cal.own) return t().calibPool(cal.n);
  const m = cal.median;
  return t().calibOwn(cal.n, cal.above, m != null ? fmt1(m) : "–", m != null && (m > 1.15 || m < 0.87));
}

// ---------- outlook ----------
/** The total a week, a month and to the year's end ahead at the last 7 days' pace, each with its range. */
export function outlookCard(v: DashboardView, A: Analysis, color: string): void {
  if (!(A.pace > 0) || A.d.length < 7) return;
  const yearEnd = `${A.lastDate.slice(0, 4)}-12-31`, toYE = dayDiff(A.lastDate, yearEnd);
  const hs: [number, string][] = [[7, t().olWeek], [30, t().ol30]];
  hs.push(toYE > 30 ? [toYE, t().olYearEnd] : [toYE + 365, t().olNextYearEnd]);
  const H = Math.max(...hs.map((h) => h[0])), f = v.m.forecast(A, H);
  const pts = hs.map(([h, label]) => ({ label, date: addDays(A.lastDate, h), mid: f.mid[h - 1], lo: f.lo[h - 1], hi: f.hi[h - 1] }));
  const min = A.total, max = Math.max(...pts.map((p) => p.hi)) * 1.02, X = (x: number) => (x - min) / (max - min) * 100;
  // Evenly spaced ticks, all named (milestones are uneven and left lines without names).
  const span = max - min, base = 10 ** Math.floor(Math.log10(span / 5));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * base).find((st) => span / st <= 6) ?? base * 10;
  const ticks: number[] = [];
  for (let x = Math.ceil(min / step) * step; x < max; x += step) if (X(x) > 3 && X(x) < 97) ticks.push(x);
  const end = pts[pts.length - 1], crossing = NICE.filter((m) => m > min && m <= end.mid);
  const lede = t().olLede(end.label, fmt(end.mid), fmt(end.lo), fmt(end.hi)) + (crossing.length ? " · " + t().olCross(crossing.map((m) => `**${fmt(m)}**`).join(" · ")) : "");
  v.domCard({ title: t().cOutlook, desc: t().dOutlook(fmt1(A.pace)), wide: true, lede }, (el) => {
    const ol = el.createDiv({ cls: "pp-ol" });
    const grid = ol.createDiv({ cls: "pp-ol-grid" });
    ticks.forEach((x, k) => {
      const tk = grid.createDiv({ cls: "pp-ol-tick" + (k % 2 ? " is-odd" : "") });
      tk.setCssStyles({ left: X(x) + "%" });
      tk.createSpan({ text: fmt(x) });
    });
    const row = (label: string, date: string, p: { mid: number; lo?: number; hi?: number }) => {
      const now = p.lo == null;
      const r = ol.createDiv({ cls: "pp-ol-row" + (now ? " is-now" : "") });
      const k = r.createDiv({ cls: "pp-ol-k", text: label });
      k.createEl("small", { text: shortDate(date) });
      const track = r.createDiv({ cls: "pp-ol-track" });
      const band = now ? null : track.createDiv({ cls: "pp-ol-band" });
      band?.setCssProps({ "--pp-c": color });
      const dot = track.createDiv({ cls: "pp-ol-mid" });
      dot.setCssProps({ "--pp-c": color });
      const val = r.createDiv({ cls: "pp-ol-v" });
      val.createEl("b", { text: fmt(p.mid) });
      if (!now) {
        val.createEl("small", { text: `${fmt(p.lo)}–${fmt(p.hi)}` });
        v.tip.bind(r, t().olTip(label, longDate(date), fmt(p.mid), fmt(p.lo), fmt(p.hi), signed(p.mid - A.total), fmt1(A.pace)));
      }
      return () => {
        if (band && p.lo != null && p.hi != null) band.setCssStyles({ left: X(p.lo) + "%", width: X(p.hi) - X(p.lo) + "%" });
        dot.setCssStyles({ left: X(p.mid) + "%" });
      };
    };
    const go = [row(t().olNow, A.lastDate, { mid: A.total }), ...pts.map((p) => row(p.label, p.date, p))];
    const note = calibNote(f.cal);
    if (note) rich(el.createEl("p", { cls: "pp-card-note" }), note);
    return () => go.forEach((g) => g());
  });
}

// ---------- where the week's change came from ----------
/** The last 7 days' total against the 7 before, split by plugin as a waterfall. */
export function breakdownCard(v: DashboardView, full: TotalPt[], ids: string[]): HTMLElement | null {
  const d = full.filter((x) => x.daily != null);
  if (!d.length) return null;
  const lastD = d[d.length - 1].date;
  if (d[0].date > addDays(lastD, -13)) return null;
  const win = (from: number, to: number) => d.filter((x) => x.date > addDays(lastD, -from) && x.date <= addDays(lastD, -to));
  const cur = win(7, 0), prev = win(14, 7);
  const part = (rows: TotalPt[], id: string) => rows.reduce((n, x) => n + (x.parts[id]?.daily ?? 0), 0);
  const P = prev.reduce((n, x) => n + (x.daily ?? 0), 0), C = cur.reduce((n, x) => n + (x.daily ?? 0), 0);
  if (!(P > 0)) return null;
  let run = P;
  const steps = ids.map((id) => { const a = part(prev, id), b = part(cur, id); return { id, a, b, d: b - a }; })
    .sort((x, y) => y.d - x.d).map((r) => { const s = { ...r, from: run, to: run + r.d }; run = s.to; return s; });
  // The changes are small next to the totals: bars start a little below the lowest value, marked with a cut on the totals.
  const all = [P, C, ...steps.flatMap((s) => [s.from, s.to])], lo = Math.min(...all), hi = Math.max(...all);
  let base = Math.max(0, lo - (hi - lo) * 0.9);
  if (base < lo * 0.35) base = 0;
  const max = hi + (hi - base) * 0.04, X = (x: number) => (x - base) / (max - base) * 100;
  const diff = C - P, losers = steps.filter((s) => s.d < 0), gainers = steps.filter((s) => s.d > 0);
  const lede = diff < 0 ? t().wfLedeDown(fmt(-diff), v.nameOf(losers[losers.length - 1].id), signed(losers[losers.length - 1].d))
    : diff > 0 ? t().wfLedeUp(fmt(diff), v.nameOf(gainers[0].id), signed(gainers[0].d)) : t().wfLedeSame;
  const span = (from: number, to: number) => `${shortDate(addDays(lastD, -from))}–${shortDate(addDays(lastD, -to))}`;
  return v.domCard({ title: t().cBreakdown, desc: t().dBreakdown, lede }, (el) => {
    const wf = el.createDiv({ cls: "pp-wf" });
    const later: (() => void)[] = [];
    const bar = (track: HTMLElement, c: string, l: number, w: number) => {
      const b = track.createDiv({ cls: "pp-wf-bar" });
      b.setCssProps({ "--pp-c": c });
      later.push(() => b.setCssStyles({ left: l + "%", width: Math.max(0.4, w) + "%" }));
    };
    const total = (k: string, sub: string, x: number, c: string, link: boolean) => {
      const r = wf.createDiv({ cls: "pp-wf-row is-total" });
      const kk = r.createDiv({ cls: "pp-wf-k", text: k });
      kk.createEl("small", { text: sub });
      const track = r.createDiv({ cls: "pp-wf-track" });
      if (link) track.createDiv({ cls: "pp-wf-link" }).setCssStyles({ left: X(x) + "%" });
      bar(track, c, 0, X(x));
      if (base) track.createDiv({ cls: "pp-wf-cut" });
      const val = r.createDiv({ cls: "pp-wf-v" });
      val.createEl("b", { text: fmt(x) });
      if (link) rich(val.createEl("small"), delta(C / P - 1)); else val.createEl("small", { text: t().wfBase });
    };
    total(t().wfPrev, span(13, 7), P, v.P.ink3, false);
    for (const s of steps) {
      const r = wf.createDiv({ cls: "pp-wf-row" });
      v.tip.bind(r, `**${v.nameOf(s.id)}** ${signed(s.d)}\n${t().wfTip(signed(s.a), signed(s.b))}` + (s.a > 0 ? ` (${pctText(s.b / s.a - 1)})` : ""));
      const k = r.createDiv({ cls: "pp-wf-k" });
      swatch(k, v.colorOf(s.id));
      k.createSpan({ text: v.nameOf(s.id) });
      const track = r.createDiv({ cls: "pp-wf-track" });
      track.createDiv({ cls: "pp-wf-link" }).setCssStyles({ left: X(s.from) + "%" });
      bar(track, v.colorOf(s.id), X(Math.min(s.from, s.to)), Math.abs(s.d) / (max - base) * 100);
      const val = r.createDiv({ cls: "pp-wf-v" });
      val.createEl("b", { cls: s.d > 0 ? "pp-up" : s.d < 0 ? "pp-down" : "", text: signed(s.d) });
      val.createEl("small", { text: `${fmt(s.a)} → ${fmt(s.b)}` });
    }
    total(t().wfCur, span(6, 0), C, v.P.ink2, true);
    const others = diff < 0 ? gainers : losers;
    if (others.length) el.createEl("p", { cls: "pp-card-note", text: (diff < 0 ? t().wfGainers : t().wfLosers) + others.map((s) => `${v.nameOf(s.id)} ${signed(s.d)}`).join(" · ") });
    return () => later.forEach((f) => f());
  });
}

// ---------- months ----------
/** Downloads per month (by plugin on the overview), the current one projected to its end, and how it compares. */
export function monthlyCard(v: DashboardView, full: (Pt | TotalPt)[], A: Analysis, o: { ids?: string[]; color?: string; wide?: boolean } = {}): HTMLElement | null {
  const list = v.m.months(full, A).slice(-12);
  if (list.length < 2) return null;
  const cur = list[list.length - 1].current ? list[list.length - 1] : null, prevM = cur ? list[list.length - 2] : null;
  const today = +A.lastDate.slice(8, 10), proj = cur?.proj ?? 0;
  const same = prevM ? [...prevM.byDay].filter(([dd]) => dd <= today).reduce((n, [, x]) => n + x, 0) : null;
  const top = Math.max(1, ...list.map((m) => m.sum + (m === cur ? proj : 0))), Hh = (x: number) => Math.max(x > 0 ? 1 : 0, x / top * 80);
  const name = (m: { key: string }) => t().monthName(+m.key.slice(5, 7));
  const best = list.filter((m) => m !== cur).reduce<typeof list[number] | null>((b, m) => !b || m.sum > b.sum ? m : b, null);
  const lede = cur && proj ? t().moLedeProj(name(cur), fmt(cur.sum + proj)) + (prevM && prevM.sum > 0 ? " · " + t().moLedeVs(name(prevM), fmt1((cur.sum + proj) / prevM.sum)) : "")
    : best ? t().moLedeBest(name(best), signed(best.sum)) : "";
  const ids = o.ids, color = o.color ?? v.P.ink2;
  return v.domCard({ title: t().cMonthly, desc: t().dMonthly, wide: o.wide ?? true, lede,
    legend: ids && ids.length > 1 ? ids.map((id) => ({ name: v.nameOf(id), color: v.colorOf(id) })) : null }, (el) => {
    const wrap = el.createDiv({ cls: "pp-mo" });
    const cols = wrap.createDiv({ cls: "pp-mo-cols" });
    cols.setCssProps({ "--pp-n": String(list.length) });
    const later: (() => void)[] = [];
    list.forEach((m, i) => {
      const isCur = m === cur, [yy] = m.key.split("-");
      const col = cols.createDiv({ cls: "pp-mo-col" + (isCur ? " is-cur" : "") });
      col.setCssProps({ "--pp-d": String(i) });
      const days = m.to - m.from + 1, prev = i ? list[i - 1] : null;
      v.tip.bind(col, `**${t().monthYear(+yy, +m.key.slice(5, 7))}**${m.from > 1 || isCur ? ` (${t().dayRange(m.from, m.to)})` : ""}\n${signed(m.sum)} · ${t().perDayN(fmt1(m.sum / days))}` +
        (prev && !isCur && prev.sum > 0 ? `\n${t().vsMonth(name(prev))} ${delta(m.sum / prev.sum - 1)}` : "") +
        (ids && ids.length > 1 ? "\n" + ids.filter((id) => (m.parts[id] ?? 0) > 0).map((id) => `${v.nameOf(id)} ${signed(m.parts[id])}`).join(" · ") : "") +
        (isCur && proj ? `\n${t().moProjTip(fmt(m.sum + proj))}` : ""));
      const plot = col.createDiv({ cls: "pp-mo-plot" });
      const val = plot.createDiv({ cls: "pp-mo-val" });
      if (isCur && proj) val.createEl("small", { text: t().expectedN(fmt(m.sum + proj)) });
      val.createEl("b", { text: fmt(m.sum) });
      const pj = isCur && proj ? plot.createDiv({ cls: "pp-mo-proj" }) : null;
      const stack = plot.createDiv({ cls: "pp-mo-stack" });
      if (ids && ids.length > 1) {
        for (const id of ids) {
          const x = m.parts[id] ?? 0;
          if (x <= 0) continue;
          const seg = stack.createDiv();
          seg.setCssStyles({ flex: `${x} 1 0px`, background: v.colorOf(id) });
        }
      } else stack.createDiv().setCssStyles({ flex: "1 1 0px", background: color });
      later.push(() => { stack.setCssStyles({ height: Hh(m.sum) + "%" }); pj?.setCssStyles({ height: Hh(proj) + "%" }); });
      const k = col.createDiv({ cls: "pp-mo-k", text: name(m) });
      if (i === 0 || m.key.endsWith("-01")) k.createEl("small", { text: yy });
      if (m.from > 1 || (isCur && (m.left ?? 0) > 0)) k.createEl("small", { text: t().dayRange(m.from, m.to) });
    });
    const side = wrap.createDiv({ cls: "pp-mo-side" });
    const stat = (label: string, value: string, sub: string) => {
      const s = side.createDiv({ cls: "pp-mo-stat" });
      s.createSpan({ text: label });
      rich(s.createEl("b"), value);
      rich(s.createEl("small"), sub);
    };
    if (cur) stat(t().moThis(name(cur), cur.from, cur.to), signed(cur.sum), t().perDayN(fmt1(cur.sum / (cur.to - cur.from + 1))));
    if (cur && prevM && same) stat(t().moSame(name(prevM), today), signed(same), `${t().moThisMonth} ${delta(cur.sum / same - 1)}`);
    if (cur && proj) stat(t().moProj(name(cur)), t().aboutN(fmt(cur.sum + proj)), t().moProjSub(cur.left ?? 0, fmt1(A.pace)));
    if (side.childElementCount < 3 && best) stat(t().moBest, `${name(best)} ${signed(best.sum)}`, t().perDayN(fmt1(best.sum / (best.to - best.from + 1))));
    return () => later.forEach((f) => f());
  });
}

// ---------- records ----------
/** Bests so far: the best day and week, the longest rise, the quickest climb, the best rank, the best release start. */
export function recordsCard(v: DashboardView, A: Analysis, id?: string): void {
  const recs = v.m.records(A, id);
  if (!recs.length) return;
  const W = t().weekdays;
  const view = (r: RecordItem): { k: string; value: string; sub: string } => {
    const x = r.extra;
    switch (r.k) {
      case "bestDay": return { k: t().rBestDay, value: signed(r.value), sub: `${longDate(r.date)} · ${t().weekdayLong(W[weekdayOf(r.date)])}` };
      case "best7": return { k: t().rBest7, value: signed(r.value), sub: `${shortDate(x.from ?? r.date)}–${shortDate(r.date)}` };
      case "rise": return { k: t().rRise, value: t().daysN(fmt(r.value)), sub: x.now ? t().rRiseNow(x.now) : t().rRiseSub };
      case "firstTo": return { k: t().rFirstTo(fmt(x.m)), value: t().daysN(fmt(r.value)), sub: t().rFromFirst(shortDate(x.from ?? r.date)) };
      case "quickest": return { k: t().rQuickest, value: `${fmt(x.prev)}→${fmt(x.m)}`, sub: t().rQuickSub(r.value, fmt1(((x.m ?? 0) - (x.prev ?? 0)) / r.value)) };
      case "bestRank": return { k: t().rBestRank, value: t().rankTick(fmt(r.value)), sub: t().rRankFrom(fmt(Number(x.from)), fmt(Number(x.from) - r.value)) };
      case "rankJump": return { k: t().rRankJump, value: `▲ ${fmt(r.value)}`, sub: t().rRankJumpSub };
      case "bestLaunch": return { k: t().rBestLaunch, value: `v${x.version ?? ""}`, sub: t().rFirst3(fmt(r.value)) };
    }
  };
  const latest = recs.reduce((b, r) => r.date > b.date ? r : b), fresh = recs.filter((r) => r.fresh).length, lv = view(latest);
  const lede = t().recLede(lv.k, lv.value, shortDate(latest.date)) + (fresh ? " · " + t().recFresh(fresh) : "");
  v.domCard({ title: t().cRecords, desc: t().dRecords, wide: true, lede }, (el) => {
    const grid = el.createDiv({ cls: "pp-recs" });
    for (const r of recs) {
      const x = view(r), c = grid.createDiv({ cls: "pp-rec" });
      const k = c.createDiv({ cls: "pp-rec-k", text: x.k });
      if (r.fresh) k.createSpan({ cls: "pp-new", text: t().newBadge });
      c.createDiv({ cls: "pp-rec-v", text: x.value });
      c.createDiv({ cls: "pp-rec-d", text: r.k === "bestDay" ? x.sub : `${longDate(r.date)} · ${x.sub}` });
    }
  });
}

// ---------- overtaking ladder ----------
let namesAsked = false;
/** The plugins 1,000 · 500 · 250 · 100 · 50 · 10 · 1 places above in the overall ranking, and the one just below. */
export function ladderCard(v: DashboardView, id: string): void {
  const off = v.m.withBasis("official"), A = off.analyze(off.series(id));
  if (!A) return;
  const rows = off.ladder(id, A.pace);
  if (!rows) return;
  const list = cachedPluginList();
  if (!list && !namesAsked) { namesAsked = true; void fetchPluginList().then(() => v.render(), () => undefined); }
  const nameOf = (x: string) => v.plugin.settings.meta[x]?.name ?? list?.find((p) => p.id === x)?.name ?? x;
  const ups = rows.filter((r) => r.step !== "below" && r.gap > 0 && r.days != null && r.days <= 730);
  const week = ups.filter((r) => (r.days as number) <= 7), chaser = rows.find((r) => r.step === "below");
  const reach = week.length ? week.reduce((b, r) => (r.step as number) > (b.step as number) ? r : b) : [...ups].sort((a, b) => (a.days as number) - (b.days as number) || a.gap - b.gap)[0];
  const lede = (reach ? (week.length ? t().ladLedeWeek(fmt(reach.step as number), nameOf(reach.id), fmt(reach.days)) : t().ladLedeNext(nameOf(reach.id), fmt(reach.days))) : t().ladLedeNone) +
    (chaser ? " · " + (chaser.gap >= 0 ? t().ladPassed(nameOf(chaser.id)) : chaser.days != null ? t().ladChaser(nameOf(chaser.id), chaser.days > 730 ? t().overYear : t().daysN(fmt(chaser.days))) : t().ladSafe) : "");
  const st = off.standing(id);
  v.domCard({ title: t().cLadder, desc: t().dLadder, wide: true, lede }, (el) => {
    const box = el.createDiv({ cls: "pp-lad" });
    const maxDays = Math.max(30, ...rows.filter((r) => r.days != null && r.days <= 730).map((r) => r.days as number));
    const later: (() => void)[] = [];
    const line = (r: typeof rows[number] | null) => {
      const me = !r, row = box.createDiv({ cls: "pp-lad-row" + (me ? " is-me" : "") });
      row.createDiv({ cls: "pp-lad-step", text: me ? t().you : r.step === "below" ? t().ladBelow : r.step === 1 ? t().ladAbove : t().ladStepsUp(fmt(r.step)) });
      const nm = row.createDiv({ cls: "pp-lad-name", text: me ? v.nameOf(id) : nameOf(r.id) });
      const rank = me ? st?.rank : r.rank;
      if (rank) nm.createEl("small", { text: t().rankTick(fmt(rank)) });
      row.createDiv({ cls: "pp-lad-num", text: fmt(me ? A.total : r.downloads) });
      row.createDiv({ cls: "pp-lad-gap", text: me ? t().perDayN(fmt1(A.pace)) : `${signed(r.gap)} · ${t().perDayN(r.pace == null ? "–" : fmt1(r.pace))}` });
      const eta = row.createDiv({ cls: "pp-lad-eta" });
      if (me || !r) return;
      const below = r.step === "below", passed = !below && r.gap <= 0, caught = below && r.gap >= 0;
      if (passed) eta.createSpan({ cls: "pp-up", text: t().ladDone });
      else if (caught) eta.createSpan({ cls: "pp-down", text: t().ladCaught });
      else if (r.days == null) eta.createSpan({ cls: "pp-muted", text: below ? t().ladNotGaining : r.pace == null ? t().ladNoPace : t().ladPulling });
      else {
        const b = eta.createDiv({ cls: "pp-lad-bar" });
        b.setCssProps({ "--pp-c": below ? v.P.down : v.colorOf(id) });
        later.push(() => b.setCssStyles({ width: Math.max(4, Math.sqrt(Math.min(r.days as number, maxDays) / maxDays) * 100) * 0.62 + "%" }));
        eta.createSpan({ cls: below ? "pp-down" : "", text: (r.days) > 730 ? t().overYear : t().inDays(fmt(r.days)) });
      }
      v.tip.bind(row, `**${nameOf(r.id)}** ${r.rank ? t().rankTick(fmt(r.rank)) + " · " : ""}${fmt(r.downloads)}\n${t().ladTip(r.pace == null ? "–" : fmt1(r.pace), fmt1(A.pace))}` +
        (r.days != null && !passed && !caught ? `\n${t().ladTipWhen(longDate(addDays(A.lastDate, r.days)))}` : ""));
    };
    rows.filter((r) => r.step !== "below").forEach(line);
    line(null);
    rows.filter((r) => r.step === "below").forEach(line);
    if (!list) el.createEl("p", { cls: "pp-card-note", text: t().ladNames });
    return () => later.forEach((f) => f());
  });
}

// ---------- stream of daily downloads ----------
/** Names each stream at its thickest point, and a scale bar for the thickness. */
function streamLabels(P: DashboardView["P"], unit: number): ChartPlugin {
  return {
    id: "streamLabels",
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { y } } = c, ds = c.data.datasets;
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `600 11.5px ${P.font}`;
      for (let k = 1; k < ds.length; k++) {
        const top = c.getDatasetMeta(k).data, bot = c.getDatasetMeta(k - 1).data, label = ds[k].label ?? "", w = ctx.measureText(label).width;
        let best: { x: number; y: number; th: number } | null = null;
        top.forEach((p, i) => {
          const th = bot[i].y - p.y;
          if (p.x - w / 2 - 8 < a.left || p.x + w / 2 + 8 > a.right) return;
          if (!best || th > best.th) best = { x: p.x, y: (p.y + bot[i].y) / 2, th };
        });
        const b = best as { x: number; y: number; th: number } | null;
        if (!b || b.th < 17) continue;
        ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.95;
        ctx.fillText(label, b.x, b.y);
        ctx.globalAlpha = 1;
      }
      const h = Math.abs(y.getPixelForValue(0) - y.getPixelForValue(unit)), x = a.left + 3, yb = a.bottom - 4;
      if (h > 6) {
        ctx.strokeStyle = P.ink3; ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(x, yb); ctx.lineTo(x, yb - h); ctx.moveTo(x - 3, yb); ctx.lineTo(x + 3, yb); ctx.moveTo(x - 3, yb - h); ctx.lineTo(x + 3, yb - h); ctx.stroke();
        ctx.fillStyle = P.ink3; ctx.font = `11px ${P.font}`; ctx.textAlign = "left";
        ctx.fillText(t().streamUnit(fmt(unit)), x + 8, yb - h / 2);
      }
      ctx.restore();
    },
  };
}

const NICE_UNITS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/** Each plugin's daily downloads (3-day smoothed) stacked around a middle line: thickness is that day's pace. */
export function streamCard(v: DashboardView, ids: string[], labels: string[]): void {
  if (labels.length < 10) return;
  const series = new Map(ids.map((id) => [id, new Map(v.m.series(id).map((p) => [p.date, p]))]));
  const sm = (id: string) => labels.map((d, i) => {
    const w: number[] = [];
    for (let k = -3; k <= 3; k++) { const p = series.get(id)?.get(addDays(d, k)); if (p?.daily != null && !p.gap) w.push(p.daily); }
    return w.length && i >= 0 ? Math.round(mean(w) * 10) / 10 : null;
  });
  const vals = new Map(ids.map((id) => [id, sm(id)]));
  const live = ids.filter((id) => (vals.get(id) ?? []).some((x) => (x ?? 0) > 0));
  if (live.length < 2) return;
  const onset = (id: string) => (vals.get(id) ?? []).findIndex((x) => (x ?? 0) > 0), order: string[] = [];
  [...live].sort((a, b) => onset(a) - onset(b) || ids.indexOf(a) - ids.indexOf(b)).forEach((id, k) => k % 2 ? order.push(id) : order.unshift(id));
  const tot = labels.map((_, i) => live.reduce((n, id) => n + ((vals.get(id) ?? [])[i] ?? 0), 0));
  const unit = [...NICE_UNITS].reverse().find((u) => u <= Math.max(...tot) * 0.4) ?? 1;
  // Lede: the thickest stream now, and the one whose share grew most since the start of the range.
  const shareIn = (i0: number, i1: number) => {
    const s = live.map((id) => (vals.get(id) ?? []).slice(i0, i1).reduce<number>((n, x) => n + (x ?? 0), 0)), sum = s.reduce((a, b) => a + b, 0) || 1;
    return new Map(live.map((id, k) => [id, s[k] / sum]));
  };
  const s0 = shareIn(0, 7), s1 = shareIn(labels.length - 7, labels.length), pc = (x: number) => Math.round(x * 100);
  const thick = live.reduce((b, id) => (s1.get(id) ?? 0) > (s1.get(b) ?? 0) ? id : b);
  const grew = live.reduce((b, id) => (s1.get(id) ?? 0) - (s0.get(id) ?? 0) > (s1.get(b) ?? 0) - (s0.get(b) ?? 0) ? id : b);
  const lede = t().stLede(v.nameOf(thick), pc(s1.get(thick) ?? 0)) +
    (grew !== thick && (s1.get(grew) ?? 0) - (s0.get(grew) ?? 0) >= 0.03 ? " · " + t().stLedeGrew(v.nameOf(grew), pc(s0.get(grew) ?? 0), pc(s1.get(grew) ?? 0)) : "");
  const P = v.P;
  v.chartCard({ title: t().cStream, desc: t().dStream, wide: true, height: 300, lede }, () => {
    const o = baseOptions(P, v.plugin.motion(), { stacked: true });
    o.layout = { padding: { top: 4, right: 4 } };
    // Negative (the base that centres the stack) and positive values stack as one, or the lower streams would swell.
    o.scales.y.stacked = "single" as unknown as boolean;
    const half = Math.max(...tot) / 2 * 1.05 || 1;
    o.scales.y.beginAtZero = false;
    (o.scales.y as unknown as Record<string, unknown>).min = -half;
    o.scales.y.max = half;
    (o.scales.y as unknown as Record<string, unknown>).display = false;
    o.scales.x.ticks.callback = dateTick;
    o.plugins.tooltip.filter = (it: TI) => !(it.dataset as unknown as Ds).isBase;
    o.plugins.tooltip.itemSort = (a: TI, b: TI) => (num(b.raw) ?? 0) - (num(a.raw) ?? 0);
    o.plugins.tooltip.callbacks = {
      title: (it: TI[]) => `${it[0].label} · ${t().streamTitle}`,
      label: (it: TI) => ` ${it.dataset.label ?? ""} ${fmt1(num(it.raw))}`,
      footer: (it: TI[]) => it.length ? t().sumLine(fmt1(tot[it[0].dataIndex])) : "",
    };
    const curve = { pointRadius: 0, pointHoverRadius: 0, cubicInterpolationMode: "monotone", spanGaps: true };
    return {
      type: "line",
      data: { labels, datasets: [
        { ...curve, label: "", isBase: true, data: tot.map((x) => -x / 2), borderWidth: 0, fill: false, backgroundColor: "transparent", borderColor: "transparent" },
        ...order.map((id) => ({ ...curve, label: v.nameOf(id), data: vals.get(id) ?? [], fill: "-1", backgroundColor: v.colorOf(id), borderColor: P.surface, borderWidth: 1.5 })),
      ] },
      options: o, plugins: [streamLabels(P, unit)],
    };
  });
}

// ---------- race of totals ----------
/** Each plugin's total as a bar race from the first day: bars swap places as one passes another. Plays once, then by hand. */
export function raceCard(v: DashboardView, ids: string[]): void {
  const rows = ids.map((id) => ({ id, s: v.m.series(id).filter((p) => p.total != null) })).filter((x) => x.s.length);
  if (rows.length < 2) return;
  const start = rows.map((x) => x.s[0].date).sort()[0], end = rows.map((x) => x.s[x.s.length - 1].date).sort().reverse()[0];
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  if (dates.length < 7) return;
  const vals = rows.map((x) => { const m = new Map(x.s.map((p) => [p.date, p.total as number])); let last = 0; return dates.map((d) => (last = m.get(d) ?? last)); });
  const N = dates.length, RH = 40, fin = vals.map((a) => a[N - 1]);
  const leadAt = (i: number) => vals.reduce((b, a, k) => a[i] > vals[b][i] ? k : b, 0), L1 = leadAt(N - 1);
  let since = N - 1;
  while (since > 0 && leadAt(since - 1) === L1) since--;
  const second = fin.reduce((b, x, k) => k !== L1 && (b < 0 || x > fin[b]) ? k : b, -1);
  const lede = t().rcLede(v.nameOf(rows[L1].id), fmt(fin[L1] - fin[second])) + " · " + (since > 0 ? t().rcSince(shortDate(dates[since]), v.nameOf(rows[leadAt(since - 1)].id)) : t().rcAlways);
  v.domCard({ title: t().cRace, desc: t().dRace(longDate(start)), wide: true, lede }, (el) => {
    const rc = el.createDiv({ cls: "pp-rc" });
    rc.setCssStyles({ height: rows.length * RH - 8 + "px" });
    const dateBox = rc.createDiv({ cls: "pp-rc-date" });
    const dateB = dateBox.createEl("b"), dateS = dateBox.createEl("small");
    const rowEls = rows.map((x) => {
      const r = rc.createDiv({ cls: "pp-rc-row" });
      r.setCssProps({ "--pp-c": v.colorOf(x.id) });
      const n = r.createDiv({ cls: "pp-rc-n" });
      swatch(n, v.colorOf(x.id));
      n.appendText(v.nameOf(x.id));
      if (v.plugin.settings.mine.includes(x.id)) { r.addClass("is-link"); r.addEventListener("click", () => v.setView(x.id)); }
      const tr = r.createDiv({ cls: "pp-rc-track" });
      tr.createDiv({ cls: "pp-rc-bar" });
      return { r, val: tr.createEl("b", { cls: "pp-rc-v" }) };
    });
    const ctl = el.createDiv({ cls: "pp-rc-ctl" });
    const btn = ctl.createEl("button", { cls: "pp-icon-btn clickable-icon pp-rc-play", attr: { type: "button" } });
    const scrub = ctl.createEl("input", { cls: "pp-rc-scrub", attr: { type: "range", min: "0", max: String(N - 1), step: "any", "aria-label": t().rcScrub } });
    scrub.value = String(N - 1);
    ctl.createSpan({ cls: "pp-muted", text: `${shortDate(start)} – ${shortDate(end)}` });
    const y = rows.map((_, i) => i * RH);
    const DUR = Math.max(4500, Math.min(11000, N * 120));
    let tt = N - 1, playing = false, raf = 0, prevNow = 0, t0 = 0;
    const icon = (k: "play" | "pause" | "rotate-ccw") => { setIcon(btn, k); btn.setAttr("aria-label", k === "play" ? t().rcPlay : k === "pause" ? t().rcPause : t().rcReplay); };
    const paint = (k: number): boolean => {
      const i0 = Math.floor(tt), i1 = Math.min(N - 1, i0 + 1), f = tt - i0;
      const cur = vals.map((a) => a[i0] + (a[i1] - a[i0]) * f), max = Math.max(...cur, 1);
      const order = cur.map((_, i) => i).sort((a, b) => cur[b] - cur[a] || a - b);
      let settling = false;
      order.forEach((ri, r) => {
        const target = r * RH;
        y[ri] += (target - y[ri]) * k;
        if (Math.abs(target - y[ri]) > 0.3) settling = true; else y[ri] = target;
        rowEls[ri].r.setCssStyles({ transform: `translateY(${y[ri].toFixed(2)}px)` });
        rowEls[ri].r.setCssProps({ "--pp-w": (cur[ri] / max).toFixed(4) });
        rowEls[ri].val.setText(fmt(cur[ri]));
      });
      dateB.setText(longDate(dates[Math.round(tt)]));
      dateS.setText(t().sumLine(fmt(cur.reduce((a, b) => a + b, 0))));
      return settling;
    };
    const tick = (now: number) => {
      raf = 0;
      if (!el.isConnected) return;
      const dt = Math.min(0.05, Math.max(0, (now - prevNow) / 1000) || 0.016); prevNow = now;
      if (playing) {
        tt = Math.min(N - 1, (now - t0) / DUR * (N - 1)); scrub.value = String(tt);
        if (tt >= N - 1) { playing = false; icon("rotate-ccw"); }
      }
      if (paint(1 - Math.exp(-dt * 11)) || playing) raf = window.requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) { prevNow = performance.now(); raf = window.requestAnimationFrame(tick); } };
    const play = () => {
      if (!v.plugin.motion()) { tt = N - 1; scrub.value = String(tt); paint(1); return; }
      if (tt >= N - 1) { tt = 0; paint(1); }
      t0 = performance.now() - tt / (N - 1) * DUR; playing = true; icon("pause"); kick();
    };
    btn.addEventListener("click", () => { if (playing) { playing = false; icon(tt >= N - 1 ? "rotate-ccw" : "play"); } else play(); });
    scrub.addEventListener("input", () => { playing = false; tt = +scrub.value; icon(tt >= N - 1 ? "rotate-ccw" : "play"); kick(); });
    icon("rotate-ccw"); paint(1);
    // Runs once from the start when the card comes into view.
    return () => { if (v.plugin.motion()) { tt = 0; paint(1); window.setTimeout(play, 350); } };
  });
}

// ---------- releases ----------
/** The last 8 releases: the daily average of the 3 days before (grey) and the 3 from release day on (colour). */
export function impactCard(v: DashboardView, id: string, full: Pt[], color: string): void {
  const list = v.m.releaseImpact(id, full).slice(0, 8);
  if (list.length < 2) return;
  const max = Math.max(1, ...list.flatMap((x) => [x.before, x.after])) * 1.08, X = (x: number) => x / max * 100;
  const lifts = list.filter((x) => x.before > 0).map((x) => x.after / x.before - 1);
  const med = median(lifts), ups = lifts.filter((x) => x > 0.005).length;
  const lede = med != null ? t().riLede(lifts.length, ups, pctText(med)) : "";
  v.domCard({ title: t().cImpact, desc: t().dImpact, wide: true, lede, legend: [{ name: t().riBefore, color: v.P.axis }, { name: t().riAfter, color }] }, (el) => {
    const box = el.createDiv({ cls: "pp-ri" });
    const later: (() => void)[] = [];
    list.forEach((x, i) => {
      const ch = x.before > 0 ? x.after / x.before - 1 : null;
      const r = box.createDiv({ cls: "pp-ri-row" });
      r.setCssProps({ "--pp-d": String(i) });
      v.tip.bind(r, `**v${x.version}** · ${longDate(x.date)}\n${t().riTip(fmt1(x.before), fmt1(x.after))}`);
      const k = r.createDiv({ cls: "pp-ri-k", text: "v" + x.version });
      k.createEl("small", { text: shortDate(x.date) });
      const tr = r.createDiv({ cls: "pp-ri-track" });
      const ln = tr.createDiv({ cls: "pp-ri-line" + (x.after >= x.before ? "" : " is-down") });
      ln.setCssProps({ "--pp-c": color });
      tr.createDiv({ cls: "pp-ri-dot" }).setCssStyles({ left: X(x.before) + "%" });
      const after = tr.createDiv({ cls: "pp-ri-dot is-after" });
      after.setCssProps({ "--pp-c": color });
      after.setCssStyles({ left: X(x.before) + "%" });
      later.push(() => {
        ln.setCssStyles({ left: X(Math.min(x.before, x.after)) + "%", width: Math.abs(X(x.after) - X(x.before)) + "%" });
        after.setCssStyles({ left: X(x.after) + "%" });
      });
      rich(r.createDiv({ cls: "pp-ri-v" }), ch == null ? "–" : delta(ch));
    });
    const ax = box.createDiv({ cls: "pp-ri-axis" });
    ax.createSpan({ text: "0" });
    ax.createSpan({ text: t().perDayN(fmt(max / 1.08)) });
    return () => later.forEach((f) => f());
  });
}

/** For each plugin: releases, how often, and the median change from the 3 days before a release to the 3 after. */
export function scoreCard(v: DashboardView, ids: string[]): void {
  const rows = ids.map((id) => {
    const lifts = v.m.releaseImpact(id, v.m.series(id)).filter((x) => x.before > 0).map((x) => x.after / x.before - 1);
    return { id, n: (v.plugin.store.releases[id] ?? []).length, k: lifts.length, ups: lifts.filter((x) => x > 0.005).length, cad: v.m.cadence(id), med: median(lifts) };
  }).filter((r) => r.n).sort((a, b) => (b.med ?? -9) - (a.med ?? -9));
  const scored = rows.filter((r) => r.med != null);
  if (scored.length < 2) return;
  const lim = Math.max(0.2, ...scored.map((r) => Math.abs(r.med as number))) * 1.15, X = (x: number) => Math.abs(x) / lim * 50;
  const hi = scored[0], lo = scored[scored.length - 1];
  const lede = t().rsLede(v.nameOf(hi.id), pctText(hi.med as number), hi.ups, hi.k) + (lo !== hi ? " · " + t().rsLedeLow(v.nameOf(lo.id), pctText(lo.med as number)) : "");
  v.domCard({ title: t().cScore, desc: t().dScore, wide: true, lede }, (el) => {
    const box = el.createDiv({ cls: "pp-rs" });
    const head = box.createDiv({ cls: "pp-rs-row is-head" });
    [t().hPlugin, t().rsReleases, t().rsChange, ""].forEach((h) => head.createSpan({ text: h }));
    const later: (() => void)[] = [];
    rows.forEach((r, i) => {
      const c = v.colorOf(r.id), row = box.createDiv({ cls: "pp-rs-row" });
      row.setCssProps({ "--pp-d": String(i) });
      v.tip.bind(row, `**${v.nameOf(r.id)}** ${t().rsTipN(r.n)}${r.cad != null ? " · " + t().everyDays(fmt1(r.cad)).replace(/^ · /, "") : ""}\n` +
        (r.med != null ? t().rsTip(r.k, r.ups, pctText(r.med)) : t().rsTipNone));
      const k = row.createDiv({ cls: "pp-rs-k" });
      swatch(k, c);
      k.createSpan({ text: v.nameOf(r.id) });
      const n = row.createDiv({ cls: "pp-rs-n", text: t().relCount(r.n) });
      n.createEl("small", { text: r.cad != null ? t().everyN(fmt1(r.cad)) : "–" });
      const tr = row.createDiv({ cls: "pp-rs-track" });
      const b = tr.createDiv({ cls: "pp-rs-bar" });
      b.setCssProps({ "--pp-c": c });
      if (r.med != null) { const w = X(r.med), l = r.med >= 0 ? 50 : 50 - w; later.push(() => b.setCssStyles({ left: l + "%", width: w + "%" })); }
      const val = row.createDiv({ cls: "pp-rs-v" });
      if (r.med == null) val.createEl("small", { text: "–" });
      else {
        val.createEl("b", { cls: r.med > 0.005 ? "pp-up" : r.med < -0.005 ? "pp-down" : "", text: pctText(r.med) });
        val.createEl("small", { text: t().rsUps(r.ups, r.k) });
      }
    });
    const ax = box.createDiv({ cls: "pp-rs-row pp-rs-axis" });
    ax.createSpan(); ax.createSpan();
    const scale = ax.createDiv();
    [pctText(-lim), "0", pctText(lim)].forEach((x) => scale.createSpan({ text: x }));
    ax.createSpan();
    return () => later.forEach((f) => f());
  });
}

/** A faint tint for plugin-coloured fills on cards. */
export const tint = (c: string, a = 0.16) => alpha(c, a);
