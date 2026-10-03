import type { Store } from "./types";
import { addDays, dayDiff } from "./data/store";

/** Milestones worth naming. */
export const NICE = [10, 25, 50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000, 500000, 750000, 1000000, 1500000, 2000000, 3000000, 5000000];

export interface Pt { date: string; total: number | null; daily: number | null; rank: number | null; gap: boolean }
export interface TotalPt { date: string; total: number; daily: number | null; gap: boolean; parts: Record<string, { total: number; daily: number }> }

export const mean = (a: number[]): number => a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0;
export const weekdayOf = (d: string): number => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday = 0

export function semverCmp(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => +x || 0), pb = b.split(/[.-]/).map((x) => +x || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export interface Analysis {
  full: Pt[]; d: (Pt & { daily: number })[];
  last: (Pt & { daily: number }) | null;
  avgPrev: number | null; pace: number; sum7: number; sumBefore7: number | null;
  best: (Pt & { daily: number }) | null; total: number; lastDate: string;
  achieved: { m: number; date: string }[]; next: number | null; prevM: number;
  etaDays: number | null; etaDate: string | null; streak: number;
  weekday: { i: number; avg: number | null; n: number }[]; weekdayReady: boolean;
  ratio: number | null; lastRank: number | null; momentum: number | null; doubleDays: number | null;
}

export interface Standing {
  id: string; rank: number; of: number; topPct: number; downloads: number;
  climbed7: number | null; need100?: number; band?: number; needBand?: number;
}

/** Read-only view of the stored history with the derived numbers the dashboard shows. Built per render. */
export class Model {
  private cache = new Map<string, Pt[]>();
  constructor(public store: Store) {}

  /** Continuous daily series from the first to the last reading. Missed days carry `total: null`. */
  series(id: string): Pt[] {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const s = this.store.series[id];
    const out: Pt[] = [];
    if (s) {
      let first = s.d.findIndex((v) => v != null), last = s.d.length - 1;
      while (last >= 0 && s.d[last] == null) last--;
      let prev: { date: string; total: number } | null = null;
      for (let i = Math.max(0, first); first >= 0 && i <= last; i++) {
        const date = addDays(s.start, i), total = s.d[i];
        let daily: number | null = null;
        if (total != null && prev) daily = Math.max(0, total - prev.total);
        // A missed day folds its downloads into the next reading.
        out.push({ date, total, daily, rank: s.r[i] ?? null, gap: total != null && prev != null && prev.date !== addDays(date, -1) });
        if (total != null) prev = { date, total };
      }
    }
    this.cache.set(id, out);
    return out;
  }

  latest(id: string): { date: string; downloads: number; rank: number | null } | null {
    const s = this.series(id);
    for (let i = s.length - 1; i >= 0; i--) if (s[i].total != null) return { date: s[i].date, downloads: s[i].total as number, rank: s[i].rank };
    return null;
  }

  /** Several plugins summed per day. Before a plugin's first reading it counts as 0, after a missed day as its last value. */
  totalSeries(ids: string[]): TotalPt[] {
    const all = ids.map((id) => [id, this.series(id)] as const).filter(([, s]) => s.length);
    if (!all.length) return [];
    const first = all.map(([, s]) => s[0].date).sort()[0], end = all.map(([, s]) => s[s.length - 1].date).sort().reverse()[0];
    const maps = new Map(all.map(([id, s]) => [id, new Map(s.map((p) => [p.date, p.total]))]));
    const last: Record<string, number | undefined> = {}, carried = new Set<string>(), out: TotalPt[] = [];
    for (let d = first; d <= end; d = addDays(d, 1)) {
      const parts: TotalPt["parts"] = {};
      let total = 0, gap = false;
      for (const [id] of all) {
        const prev = last[id];
        const v = maps.get(id)?.get(d);
        const cur = v ?? prev ?? 0;
        parts[id] = { total: cur, daily: prev == null ? (v != null && d !== first ? cur : 0) : cur - prev };
        // A reading after carried-forward days holds several days' downloads.
        if (v != null && carried.has(id)) gap = true;
        if (v == null && prev != null) carried.add(id); else if (v != null) carried.delete(id);
        if (v != null || prev != null) last[id] = cur;
        total += cur;
      }
      out.push({ date: d, total, daily: out.length ? total - out[out.length - 1].total : null, gap, parts });
    }
    return out;
  }

  analyze(full: Pt[]): Analysis | null {
    const known = full.filter((x) => x.total != null);
    if (!known.length) return null;
    const d = full.filter((x): x is Pt & { daily: number } => x.daily != null);
    const vals = (a: { daily: number }[]) => a.map((x) => x.daily);
    const last = d.length ? d[d.length - 1] : null;
    const prev7 = d.slice(-8, -1), last7 = d.slice(-7), before7 = d.slice(-14, -7);
    const avgPrev = prev7.length >= 3 ? mean(vals(prev7)) : null;
    const pace = mean(vals(last7));
    const sum7 = last7.reduce((n, x) => n + x.daily, 0);
    const sumBefore7 = before7.length === 7 ? before7.reduce((n, x) => n + x.daily, 0) : null;
    // Readings after missed days hold several days' downloads; they can't be anyone's best day.
    const best = d.reduce<(Pt & { daily: number }) | null>((b, x) => !x.gap && (!b || x.daily > b.daily) ? x : b, null);
    const total = known[known.length - 1].total as number, lastDate = known[known.length - 1].date;

    const achieved: { m: number; date: string }[] = [];
    for (const m of NICE) {
      if (m > total) break;
      const hit = known.find((x) => (x.total as number) >= m);
      if (hit && hit !== known[0]) achieved.push({ m, date: hit.date });
    }
    const next = NICE.find((m) => m > total) ?? null;
    const prevM = [...NICE].reverse().find((m) => m <= total) ?? 0;
    const etaDays = next && pace > 0 ? Math.ceil((next - total) / pace) : null;
    const half = [...known].reverse().find((x) => (x.total as number) <= total / 2);
    let streak = 0;
    for (let i = d.length - 1; i >= 0 && d[i].daily > 0; i--) streak++;

    // Weekday averages use the last four weeks so the overall trend does not drown the pattern.
    const recent = d.slice(-28);
    const wd: number[][] = Array.from({ length: 7 }, () => []);
    recent.forEach((x) => wd[weekdayOf(x.date)].push(x.daily));
    const weekday = wd.map((a, i) => ({ i, avg: a.length ? mean(a) : null, n: a.length }));

    return {
      full, d, last, avgPrev, pace, sum7, sumBefore7, best, total, lastDate, achieved, next, prevM, etaDays, streak, weekday,
      ratio: last && avgPrev ? last.daily / avgPrev : null,
      lastRank: last ? 1 + d.filter((x) => !x.gap && x.daily > last.daily).length : null,
      momentum: sumBefore7 ? (sum7 - sumBefore7) / sumBefore7 : null,
      etaDate: etaDays != null ? addDays(lastDate, etaDays) : null,
      doubleDays: half && (half.total as number) > 0 ? dayDiff(half.date, lastDate) : null,
      weekdayReady: recent.length >= 14,
    };
  }

  /** Where a plugin sits among every community plugin. */
  standing(id: string): Standing | null {
    const s = this.series(id).filter((x) => x.rank != null);
    if (!s.length) return null;
    const latest = s[s.length - 1];
    const of = this.store.of[latest.date] ?? this.store.market?.downloads.length ?? 0;
    if (!of) return null;
    const rank = latest.rank as number, downloads = latest.total as number;
    const weekAgo = [...s].reverse().find((x) => x.date <= addDays(latest.date, -7)) ?? s[0];
    const out: Standing = { id, rank, of, topPct: rank / of * 100, downloads, climbed7: weekAgo !== latest ? (weekAgo.rank as number) - rank : null };
    const arr = this.store.market?.downloads;
    if (arr?.length) {
      if (rank > 100) out.need100 = arr[rank - 101] - downloads + 1;
      const band = [50, 40, 30, 25, 20, 15, 10, 5, 1].find((b) => b < out.topPct);
      if (band) { out.band = band; out.needBand = arr[Math.ceil(arr.length * band / 100) - 1] - downloads + 1; }
    }
    return out;
  }

  /** Each version's first three days, from the version counts in the official file. */
  launches(id: string): { version: string; first: string; total: number; first3: number; partial: boolean; known: boolean; days: number }[] {
    const log = this.store.versions[id] ?? {};
    const start = this.store.vstart[id];
    const lastDate = this.latest(id)?.date;
    return Object.entries(log).map(([version, e]) => {
      const known = !!start && e.first > start;
      const days = lastDate ? Math.min(3, dayDiff(e.first, lastDate) + 1) : 1;
      const c = e.c.slice(0, days).filter((x): x is number => x != null);
      // A version watched from its launch shows the count it had after its first 3 days;
      // one already out when tracking started shows the downloads it gained over its first 3 observed days.
      const first3 = c.length ? (known ? c[c.length - 1] : c[c.length - 1] - c[0]) : e.total;
      return { version, first: e.first, total: e.total, first3, partial: days < 3, known, days };
    }).sort((a, b) => semverCmp(a.version, b.version));
  }

  /** Average daily downloads in the three days before and after each release. */
  releaseImpact(id: string, full: Pt[]): { version: string; date: string; before: number; after: number }[] {
    const byDate = new Map(full.map((x) => [x.date, x.daily]));
    const seen = new Set<string>(), out: { version: string; date: string; before: number; after: number }[] = [];
    for (const r of [...(this.store.releases[id] ?? [])].sort((a, b) => b.date.localeCompare(a.date))) {
      const day = r.date.slice(0, 10);
      if (seen.has(day)) continue;
      seen.add(day);
      const before = [-2, -1, 0].map((n) => byDate.get(addDays(day, n)));
      const after = [1, 2, 3].map((n) => byDate.get(addDays(day, n)));
      if ([...before, ...after].some((v) => v == null)) continue;
      out.push({ version: r.version, date: day, before: mean(before as number[]), after: mean(after as number[]) });
    }
    return out;
  }

  /** Average days between releases over the last 180 days, or null with fewer than two. */
  cadence(id: string): number | null {
    const since = addDays(new Date().toISOString().slice(0, 10), -180);
    const ds = [...new Set((this.store.releases[id] ?? []).map((r) => r.date.slice(0, 10)).filter((d) => d >= since))].sort();
    return ds.length > 1 ? dayDiff(ds[0], ds[ds.length - 1]) / (ds.length - 1) : null;
  }

  gainOver(series: Pt[], days: number): number | null {
    const known = series.filter((s) => s.total != null);
    if (known.length < 2) return null;
    const last = known[known.length - 1];
    const cutoff = addDays(last.date, -days);
    const base = [...known].reverse().find((s) => s.date <= cutoff) ?? known[0];
    return (last.total as number) - (base.total as number);
  }

  /**
   * How a plugin stands against another: the download gap, and at the last 14 days' paces
   * how many days until the one behind catches up (null when it is not gaining).
   */
  race(me: string, other: string): { gap: number; myPace: number; theirPace: number; days: number | null } | null {
    const a = this.analyze(this.series(me)), b = this.analyze(this.series(other));
    if (!a || !b) return null;
    const pace = (x: Analysis) => mean(x.d.slice(-14).map((p) => p.daily));
    const myPace = pace(a), theirPace = pace(b);
    const gap = b.total - a.total;
    const closing = gap > 0 ? myPace - theirPace : theirPace - myPace;
    return { gap, myPace, theirPace, days: closing > 0 ? Math.ceil(Math.abs(gap) / closing) : null };
  }
}

/** Plugins most like the given one, by shared words in name and description, weighted by rarity. */
export function similarPlugins<T extends { id: string; name: string; description: string }>(target: T, list: T[], limit = 8): T[] {
  const STOP = new Set("a an and are as at be by for from in into is it its of on or that the this to with your you plugin plugins obsidian note notes vault use using".split(" "));
  const words = (p: T) => new Set((p.name + " " + p.description).toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const df = new Map<string, number>();
  const bags = list.map((p) => { const w = words(p); w.forEach((x) => df.set(x, (df.get(x) ?? 0) + 1)); return w; });
  const mine = words(target);
  const idf = (w: string) => Math.log(list.length / (1 + (df.get(w) ?? 0)));
  return list
    .map((p, i) => ({ p, score: p.id === target.id ? -1 : [...bags[i]].reduce((n, w) => n + (mine.has(w) ? idf(w) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}
