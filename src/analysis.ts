import type { Basis, Store } from "./types";
import { addDays, dayDiff, getPoint, LADDER_STEPS, todayUtc, versionDay } from "./data/store";
import { backtest, etaRange, forecast, steadyDailies, type Forecast } from "./forecast";

/** Milestones worth naming. */
export const NICE = [10, 25, 50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000, 500000, 750000, 1000000, 1500000, 2000000, 3000000, 5000000];

/** `stale`: a summed day where some plugin's value was carried forward from a missed day. */
export interface Pt { date: string; total: number | null; daily: number | null; rank: number | null; gap: boolean; stale?: boolean }
export interface TotalPt { date: string; total: number; daily: number | null; gap: boolean; stale: boolean; parts: Record<string, { total: number; daily: number }> }

export const mean = (a: number[]): number => a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0;

/** Below this many downloads in the earlier week, a percentage says more about chance than about change. */
export const SMALL_BASE = 30;

/** The last `days` days of downloads against the `days` before, by calendar day. */
export interface Momentum {
  days: number; from: string; to: string;
  recent: number; before: number | null;
  /** (recent − before) / before; null without an earlier window or when it had no downloads. */
  ratio: number | null;
  /** The change shrunk toward 0 when the numbers are small, so 30 → 60 doesn't outrank 400 → 520 by far. Lists sort by it. */
  score: number;
  /** The earlier window had fewer than SMALL_BASE (per week) downloads: show the change in downloads, not a percentage. */
  small: boolean;
  /** A window edge fell on a missed day, so the downloads of the gap were spread evenly over it. */
  estimated: boolean;
}

/**
 * Downloads added up day by day, at every day that has a reading. Built from the daily values rather
 * than the totals, so a plugin joining a sum without its past adds nothing (see `totalSeries`).
 */
function cumulative(full: Pt[]): { date: string; c: number }[] {
  const out: { date: string; c: number }[] = [];
  let c = 0;
  for (const p of full) {
    if (p.daily != null) c += p.daily;
    else if (out.length) continue;
    if (p.total == null || p.stale) continue;
    out.push({ date: p.date, c });
  }
  return out;
}

/** The running count at the end of a day: read, or spread evenly across a missed stretch. Null before the first reading. */
function countAt(cum: { date: string; c: number }[], date: string): { c: number; est: boolean } | null {
  let i = cum.length - 1;
  while (i >= 0 && cum[i].date > date) i--;
  if (i < 0) return null;
  if (cum[i].date === date || i === cum.length - 1) return { c: cum[i].c, est: false };
  const a = cum[i], b = cum[i + 1];
  return { c: a.c + (b.c - a.c) * dayDiff(a.date, date) / dayDiff(a.date, b.date), est: true };
}

export function momentumOf(full: Pt[], days = 7): Momentum | null {
  const cum = cumulative(full);
  if (cum.length < 2) return null;
  const end = cum[cum.length - 1], to = end.date;
  const mid = countAt(cum, addDays(to, -days)), start = countAt(cum, addDays(to, -2 * days));
  if (!mid) return null;
  const recent = Math.round(end.c - mid.c);
  const before = start ? Math.round(mid.c - start.c) : null;
  const base = SMALL_BASE * days / 7;
  return {
    days, from: addDays(to, -days + 1), to, recent, before,
    ratio: before ? (recent - before) / before : null,
    score: before == null ? 0 : (recent - before) / (before + base),
    small: before != null && before < base,
    estimated: mid.est || !!start?.est,
  };
}

/**
 * Weeks in a row the latest weeks kept rising (positive) or falling (negative), with those weeks' downloads,
 * oldest first. Calendar weeks counted back from the last reading.
 */
export function weekRun(full: Pt[], max = 8): { run: number; weeks: number[] } {
  const cum = cumulative(full);
  if (cum.length < 2) return { run: 0, weeks: [] };
  const to = cum[cum.length - 1].date, weeks: number[] = [];
  for (let k = 0; k < max; k++) {
    const a = countAt(cum, addDays(to, -7 * (k + 1))), b = k ? countAt(cum, addDays(to, -7 * k)) : { c: cum[cum.length - 1].c };
    if (!a || !b) break;
    weeks.unshift(Math.round(b.c - a.c));
  }
  let run = 0;
  for (let i = weeks.length - 1; i > 0; i--) {
    const step = Math.sign(weeks[i] - weeks[i - 1]);
    if (!step || (run && step !== Math.sign(run))) break;
    run += step;
  }
  return { run, weeks };
}
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
  ratio: number | null; lastRank: number | null; doubleDays: number | null;
  /** Last 7 days against the 7 before, and last 28 against the 28 before. */
  mo: Momentum | null; mo28: Momentum | null;
  /** Weeks in a row up (+) or down (−), and the weekly downloads behind it. */
  run: number; weeks: number[];
}

/**
 * Whether a series starts at the plugin's listing (a small first total) rather than partway (followed later without
 * its past). A listing's first reading counts as new downloads in sums; a partway start's would add years in a day.
 */
export function listedAtStart(s: Pt[]): boolean {
  const known = s.filter((p) => p.total != null);
  if (!known.length) return false;
  const after = known.slice(1, 8).filter((p) => !p.gap && p.daily != null).map((p) => p.daily as number);
  return (known[0].total as number) <= Math.max(50, 7 * mean(after));
}

export interface RecordItem {
  k: "bestDay" | "best7" | "rise" | "firstTo" | "quickest" | "bestRank" | "rankJump" | "bestLaunch";
  value: number; date: string; fresh: boolean;
  extra: { from?: string; now?: number; m?: number; prev?: number; version?: string };
}

export interface MonthRow {
  key: string; sum: number; from: number; to: number; parts: Record<string, number>; byDay: Map<number, number>;
  current?: boolean; proj?: number; left?: number;
}

export interface LadderRow {
  id: string; step: number | "below"; downloads: number; pace: number | null; gap: number; days: number | null; rank: number | null;
}

export interface Standing {
  id: string; rank: number; of: number; topPct: number; downloads: number;
  climbed7: number | null; need100?: number; band?: number; needBand?: number;
}

/** One day of a plugin's growth split into bots and the rest (new installs and updates). */
export interface Split { official: number; bot: number; human: number; span: number }

/** Read-only view of the stored history with the derived numbers the dashboard shows. Built per render. */
export class Model {
  private cache = new Map<string, Pt[]>();
  private splits = new Map<string, Map<string, Split>>();
  /**
   * `basis: "human"` takes bots out of your own plugins' numbers (`mine`); everything else stays official,
   * since competitors' versions aren't recorded and ranks compare with every plugin.
   */
  constructor(public store: Store, public basis: Basis = "official", private mine: string[] = []) {}

  /** The same history read on another basis. */
  withBasis(basis: Basis): Model { return basis === this.basis ? this : new Model(this.store, basis, this.mine); }

  /**
   * The series on this model's basis: with bots taken out for your own plugins on the "human" basis.
   * Days that can't be split keep their official value.
   */
  series(id: string): Pt[] {
    if (this.basis !== "human" || !this.mine.includes(id)) return this.official(id);
    const key = "human|" + id, hit = this.cache.get(key);
    if (hit) return hit;
    const split = this.split(id);
    let cum: number | null = null;
    const out = this.official(id).map((p): Pt => {
      if (p.total == null) return { ...p };
      if (cum == null) { cum = p.total; return { ...p }; }
      const daily = p.daily == null ? null : split.get(p.date)?.human ?? p.daily;
      cum += daily ?? 0;
      return { ...p, total: cum, daily };
    });
    this.cache.set(key, out);
    return out;
  }

  /**
   * Bots fetch many recent versions at once, so on such a day several older versions grow by the same count k.
   * Each version's growth up to k is taken as bots; the rest is new installs and updates. k is the median growth
   * of the versions other than the newest, and a day with fewer than three of them growing had no bots.
   * Bots fetching only the newest version can't be told apart, so `human` is an upper bound.
   * Keyed like the series: by the day the downloads happened (the file's date - 1).
   */
  split(id: string): Map<string, Split> {
    const hit = this.splits.get(id);
    if (hit) return hit;
    const out = new Map<string, Split>(), vd = this.store.vdays[id];
    const dates = Object.keys(vd?.d ?? {}).sort();
    for (let i = 1; i < dates.length; i++) {
      const a = versionDay(vd, dates[i - 1]), b = versionDay(vd, dates[i]);
      const pa = getPoint(this.store, id, dates[i - 1]), pb = getPoint(this.store, id, dates[i]);
      if (!a || !b || !pa || !pb) continue;
      const vs = Object.keys(b).sort(semverCmp), inc = (v: string) => Math.max(0, b[v] - (a[v] ?? 0));
      const old = vs.slice(0, -1).map(inc).filter((x) => x > 0).sort((x, y) => x - y);
      const k = old.length >= 3 ? old[Math.floor((old.length - 1) / 2)] : 0;
      const official = Math.max(0, pb.downloads - pa.downloads);
      const bot = Math.min(official, vs.reduce((n, v) => n + Math.min(inc(v), k), 0));
      out.set(addDays(dates[i], -1), { official, bot, human: official - bot, span: dayDiff(dates[i - 1], dates[i]) });
    }
    this.splits.set(id, out);
    return out;
  }

  /** Whether any of these plugins has enough split days to show the bots-excluded numbers. */
  canSplit(ids: string[]): boolean {
    return ids.some((id) => this.split(id).size >= 3);
  }

  /**
   * Continuous daily series from the first to the last reading. Missed days carry `total: null`.
   * Obsidian publishes the file shortly after midnight UTC, so a reading stored under day D holds the
   * downloads made on day D - 1. Points here are dated by that day, the day the downloads happened.
   */
  official(id: string): Pt[] {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const s = this.store.series[id];
    const out: Pt[] = [];
    if (s) {
      let first = s.d.findIndex((v) => v != null), last = s.d.length - 1;
      while (last >= 0 && s.d[last] == null) last--;
      let prev: { date: string; total: number } | null = null;
      for (let i = Math.max(0, first); first >= 0 && i <= last; i++) {
        const date = addDays(s.start, i - 1), total = s.d[i];
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

  /**
   * One of your plugins the newest official file no longer lists. `date` is its last reading as the dashboard dates
   * it (the day of the downloads), `since` the date of that file, and `last` the total it stopped at.
   */
  delisted(id: string): { date: string; since: string; last: number } | null {
    const d = this.store.delisted[id], latest = this.latest(id);
    return d && latest ? { date: latest.date, since: d.since, last: d.last } : null;
  }

  /**
   * main.js downloads summed over the plugins' releases: the latest record, and the pace against the record
   * nearest to a week before it. Only days every plugin has a record for count.
   */
  installs(ids: string[]): { date: string; total: number; prev: number | null; span: number; pace: number | null } | null {
    const sum = (d: string) => ids.every((id) => this.store.installs[id]?.[d] != null) ? ids.reduce((n, id) => n + this.store.installs[id][d], 0) : null;
    const dates = [...new Set(ids.flatMap((id) => Object.keys(this.store.installs[id] ?? {})))].sort().filter((d) => sum(d) != null);
    if (!dates.length) return null;
    const date = dates[dates.length - 1], total = sum(date) as number;
    const base = dates.filter((d) => d < date).reduce<string | null>((b, d) => !b || Math.abs(dayDiff(d, date) - 7) < Math.abs(dayDiff(b, date) - 7) ? d : b, null);
    const prev = base ? sum(base) : null, span = base ? dayDiff(base, date) : 0;
    return { date, total, prev, span, pace: prev != null && span > 0 ? Math.max(0, total - prev) / span : null };
  }

  /** main.js downloads added since a day: from the last record on or before it to the newest. */
  installsSince(id: string, date: string): { from: string; to: string; gain: number } | null {
    const rec = this.store.installs[id] ?? {}, dates = Object.keys(rec).sort();
    const from = dates.filter((d) => d <= date).pop(), to = dates[dates.length - 1];
    return from && to && to > from ? { from, to, gain: rec[to] - rec[from] } : null;
  }

  /** Several plugins summed per day. Before a plugin's first reading it counts as 0, after a missed day as its last value. */
  totalSeries(ids: string[]): TotalPt[] {
    const all = ids.map((id) => [id, this.series(id)] as const).filter(([, s]) => s.length);
    if (!all.length) return [];
    const first = all.map(([, s]) => s[0].date).sort()[0], end = all.map(([, s]) => s[s.length - 1].date).sort().reverse()[0];
    const maps = new Map(all.map(([id, s]) => [id, new Map(s.map((p) => [p.date, p.total]))]));
    // A plugin whose history starts at its listing brings its first reading in as new downloads. One followed
    // later without its past (archive off or missing) would add its whole total in a day, so it starts at 0.
    const listed = new Set(all.filter(([, s]) => listedAtStart(s)).map(([id]) => id));
    const last: Record<string, number | undefined> = {}, carried = new Set<string>(), out: TotalPt[] = [];
    for (let d = first; d <= end; d = addDays(d, 1)) {
      const parts: TotalPt["parts"] = {};
      let total = 0, daily = 0, gap = false, stale = false;
      for (const [id] of all) {
        const prev = last[id];
        const v = maps.get(id)?.get(d);
        const cur = v ?? prev ?? 0;
        parts[id] = { total: cur, daily: prev == null ? (v != null && d !== first && listed.has(id) ? cur : 0) : cur - prev };
        daily += parts[id].daily;
        // A reading after carried-forward days holds several days' downloads.
        if (v != null && carried.has(id)) gap = true;
        if (v == null && prev != null) { carried.add(id); stale = true; } else if (v != null) carried.delete(id);
        if (v != null || prev != null) last[id] = cur;
        total += cur;
      }
      out.push({ date: d, total, daily: out.length ? daily : null, gap, stale, parts });
    }
    return out;
  }

  analyze(full: Pt[]): Analysis | null {
    const known = full.filter((x) => x.total != null);
    if (!known.length) return null;
    const d = full.filter((x): x is Pt & { daily: number } => x.daily != null);
    const vals = (a: { daily: number }[]) => a.map((x) => x.daily);
    const last = d.length ? d[d.length - 1] : null;
    // Readings after missed days hold several days' downloads: they count in sums, not in daily averages.
    const one = (a: (Pt & { daily: number })[]) => a.filter((x) => !x.gap);
    const prev7 = one(d.slice(-8, -1)), last7 = d.slice(-7), before7 = d.slice(-14, -7);
    const avgPrev = prev7.length >= 3 ? mean(vals(prev7)) : null;
    const pace = mean(vals(one(last7)));
    // By calendar day, with missed days spread evenly; a history shorter than a week falls back to what there is.
    const mo = momentumOf(full, 7), mo28 = momentumOf(full, 28), { run, weeks } = weekRun(full);
    const sum7 = mo ? mo.recent : last7.reduce((n, x) => n + x.daily, 0);
    const sumBefore7 = mo ? mo.before : before7.length === 7 ? before7.reduce((n, x) => n + x.daily, 0) : null;
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
    const lastOne = last && !last.gap ? last : null;

    // Weekday averages use the last four weeks so the overall trend does not drown the pattern.
    const recent = one(d.slice(-28));
    const wd: number[][] = Array.from({ length: 7 }, () => []);
    recent.forEach((x) => wd[weekdayOf(x.date)].push(x.daily));
    const weekday = wd.map((a, i) => ({ i, avg: a.length ? mean(a) : null, n: a.length }));

    return {
      full, d, last, avgPrev, pace, sum7, sumBefore7, best, total, lastDate, achieved, next, prevM, etaDays, streak, weekday, mo, mo28, run, weeks,
      ratio: lastOne && avgPrev ? lastOne.daily / avgPrev : null,
      lastRank: lastOne ? 1 + d.filter((x) => !x.gap && x.daily > lastOne.daily).length : null,
      etaDate: etaDays != null ? addDays(lastDate, etaDays) : null,
      doubleDays: half && (half.total as number) > 0 ? dayDiff(half.date, lastDate) : null,
      weekdayReady: recent.length >= 14,
    };
  }

  /** Where a plugin sits among every community plugin. */
  standing(id: string): Standing | null {
    const s = this.official(id).filter((x) => x.rank != null);
    if (!s.length) return null;
    const latest = s[s.length - 1];
    const of = this.store.of[addDays(latest.date, 1)] ?? this.store.market?.downloads.length ?? 0;
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
    // Version logs are kept by the file's date; series points are a day earlier (see `series`).
    const latest = this.latest(id)?.date, lastFile = latest ? addDays(latest, 1) : null;
    return Object.entries(log).map(([version, e]) => {
      const known = !!start && e.first > start;
      const days = lastFile ? Math.min(3, dayDiff(e.first, lastFile) + 1) : 1;
      const c = e.c.slice(0, days).filter((x): x is number => x != null);
      // A version watched from its launch shows the count it had after its first 3 days;
      // one already out when tracking started shows the downloads it gained over its first 3 observed days.
      const first3 = c.length ? (known ? c[c.length - 1] : c[c.length - 1] - c[0]) : e.total;
      return { version, first: addDays(e.first, -1), total: e.total, first3, partial: days < 3, known, days };
    }).sort((a, b) => semverCmp(a.version, b.version));
  }

  /** Average daily downloads in the three days before a release and the three from its day on. */
  releaseImpact(id: string, full: Pt[]): { version: string; date: string; before: number; after: number }[] {
    const byDate = new Map(full.map((x) => [x.date, x.daily]));
    const seen = new Set<string>(), out: { version: string; date: string; before: number; after: number }[] = [];
    for (const r of [...(this.store.releases[id] ?? [])].sort((a, b) => b.date.localeCompare(a.date))) {
      const day = r.date.slice(0, 10);
      if (seen.has(day)) continue;
      seen.add(day);
      const before = [-3, -2, -1].map((n) => byDate.get(addDays(day, n)));
      const after = [0, 1, 2].map((n) => byDate.get(addDays(day, n)));
      if ([...before, ...after].some((v) => v == null)) continue;
      out.push({ version: r.version, date: day, before: mean(before as number[]), after: mean(after as number[]) });
    }
    return out;
  }

  /**
   * Average days per release over the last 180 days, counted from the first of them up to today — so a burst of
   * releases months ago followed by silence doesn't read as "every 2 days". Null with fewer than two.
   */
  cadence(id: string): number | null {
    const today = todayUtc(), since = addDays(today, -180);
    const ds = [...new Set((this.store.releases[id] ?? []).map((r) => r.date.slice(0, 10)).filter((d) => d >= since))].sort();
    return ds.length > 1 ? Math.max(dayDiff(ds[0], ds[ds.length - 1]) / (ds.length - 1), dayDiff(ds[0], today) / ds.length) : null;
  }

  /** Downloads over the last `days` calendar days (or since the first reading, if that's sooner). */
  gainOver(series: Pt[], days: number): number | null {
    const cum = cumulative(series);
    if (cum.length < 2) return null;
    const end = cum[cum.length - 1];
    const base = countAt(cum, addDays(end.date, -days));
    // A plugin listed inside the window brings its first reading in as new downloads, as `totalSeries` counts it;
    // leaving it out made the plugins' gains add up to less than their sum's.
    const first = series.find((p) => p.total != null);
    const launch = !base && first && listedAtStart(series) ? (first.total as number) : 0;
    return Math.round(end.c - (base?.c ?? 0) + launch);
  }

  /** All your plugins' forecast checks together, for plugins too new to have enough of their own. */
  private poolCache: { 7: number[]; 14: number[] } | null = null;
  pool(): { 7: number[]; 14: number[] } {
    if (this.poolCache) return this.poolCache;
    const p: { 7: number[]; 14: number[] } = { 7: [], 14: [] };
    for (const id of this.mine) { const b = backtest(steadyDailies(this.series(id))); p[7].push(...b[7]); p[14].push(...b[14]); }
    p[7].sort((a, b) => a - b); p[14].sort((a, b) => a - b);
    return (this.poolCache = p);
  }

  /** Totals 1…H days past the last reading, with the range past forecasts missed by. */
  forecast(A: Analysis, H: number): Forecast {
    return forecast(A.total, steadyDailies(A.full), H, this.pool());
  }

  /** When the next milestone comes: soonest and latest days from the last reading. */
  eta(A: Analysis): { lo: number; hi: number | null } | null {
    return A.next ? etaRange(A.total, A.next, steadyDailies(A.full), this.pool()) : null;
  }

  /**
   * Records for the records card. Each carries a key, the value, the day it was set and what it adds.
   * `fresh` is a record set on the latest day or the one before.
   */
  records(A: Analysis, id?: string): RecordItem[] {
    const d = A.d, out: RecordItem[] = [];
    if (d.length < 7) return out;
    const push = (k: RecordItem["k"], value: number, date: string, extra: RecordItem["extra"] = {}) =>
      out.push({ k, value, date, extra, fresh: dayDiff(date, A.lastDate) <= 1 });
    if (A.best) push("bestDay", A.best.daily, A.best.date);
    let best7: { n: number; date: string } | null = null;
    for (let i = 6; i < d.length; i++) {
      if (dayDiff(d[i - 6].date, d[i].date) !== 6) continue;
      const n = d.slice(i - 6, i + 1).reduce((s, x) => s + x.daily, 0);
      if (!best7 || n > best7.n) best7 = { n, date: d[i].date };
    }
    if (best7) push("best7", best7.n, best7.date, { from: addDays(best7.date, -6) });
    // The longest run of days the 7-day average kept rising.
    const ma = d.map((_, i) => i >= 6 ? mean(d.slice(i - 6, i + 1).map((x) => x.daily)) : null);
    let run = 0, bestRun = { n: 0, date: "" };
    for (let i = 1; i < ma.length; i++) {
      const a = ma[i - 1], b = ma[i];
      if (a != null && b != null && b > a) { if (++run > bestRun.n) bestRun = { n: run, date: d[i].date }; } else run = 0;
    }
    if (bestRun.n >= 2) push("rise", bestRun.n, bestRun.date, { now: run });
    const first = A.full.find((x) => x.total != null);
    const firstM = [100000, 10000, 5000, 1000, 500, 100].map((m) => A.achieved.find((x) => x.m === m)).find(Boolean);
    if (firstM && first) push("firstTo", dayDiff(first.date, firstM.date), firstM.date, { m: firstM.m, from: first.date });
    // The stretch between milestones climbed fastest, per download.
    const legs = A.achieved.slice(1).map((x, i) => ({ ...x, prev: A.achieved[i].m, took: dayDiff(A.achieved[i].date, x.date) })).filter((x) => x.took > 0);
    const quick = legs.reduce<typeof legs[number] | null>((b, x) => !b || x.took / (x.m - x.prev) < b.took / (b.m - b.prev) ? x : b, null);
    if (quick && legs.length > 1) push("quickest", quick.took, quick.date, { m: quick.m, prev: quick.prev });
    if (id) {
      const r = this.official(id).filter((x) => x.rank != null);
      if (r.length > 1) {
        const top = r.reduce((b, x) => (x.rank as number) < (b.rank as number) ? x : b);
        push("bestRank", top.rank as number, top.date, { from: String(r[0].rank) });
        let jump: { n: number; date: string } | null = null;
        for (let i = 1; i < r.length; i++) {
          const j = (r[i - 1].rank as number) - (r[i].rank as number);
          if (dayDiff(r[i - 1].date, r[i].date) === 1 && (!jump || j > jump.n)) jump = { n: j, date: r[i].date };
        }
        if (jump && jump.n > 0) push("rankJump", jump.n, jump.date);
      }
      const bv = this.launches(id).filter((v) => v.known && !v.partial).reduce<ReturnType<Model["launches"]>[number] | null>((b, v) => !b || v.first3 > b.first3 ? v : b, null);
      if (bv) push("bestLaunch", bv.first3, bv.first, { version: bv.version });
    }
    return out;
  }

  /**
   * Downloads per calendar month, with each plugin's part when `parts` is given. The current month is projected to
   * its end at the last 7 days' pace. A month the history starts in partway says from which day.
   */
  months(full: { date: string; daily: number | null; parts?: Record<string, { daily: number }> }[], A: Analysis): MonthRow[] {
    const byKey = new Map<string, MonthRow>();
    for (const x of full) {
      if (x.daily == null) continue;
      const key = x.date.slice(0, 7), day = +x.date.slice(8, 10);
      const m = byKey.get(key) ?? { key, sum: 0, from: day, to: day, parts: {}, byDay: new Map<number, number>() };
      m.sum += x.daily; m.from = Math.min(m.from, day); m.to = Math.max(m.to, day);
      m.byDay.set(day, (m.byDay.get(day) ?? 0) + x.daily);
      if (x.parts) for (const [id, p] of Object.entries(x.parts)) m.parts[id] = (m.parts[id] ?? 0) + p.daily;
      byKey.set(key, m);
    }
    const list = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    const cur = list[list.length - 1];
    if (cur && cur.key === A.lastDate.slice(0, 7)) {
      const [y, mo] = cur.key.split("-").map(Number), dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const left = dim - +A.lastDate.slice(8, 10);
      cur.current = true;
      cur.proj = left > 0 && A.pace > 0 ? Math.round(A.pace * left) : 0;
      cur.left = left;
    }
    return list;
  }

  /**
   * The plugins a few steps above `id` in the overall ranking (and the one just below), their downloads and
   * daily pace over the days noted, and in how many days `id` would pass them (or they it) at both paces.
   */
  ladder(id: string, myPace: number): LadderRow[] | null {
    const near = this.store.near;
    if (!near.length) return null;
    const last = near[near.length - 1], mine = last.d[id];
    if (mine == null) return null;
    const paceOf = (x: string): number | null => {
      const old = near.find((n) => n.d[x] != null && dayDiff(n.date, last.date) >= 1);
      return old && old !== last ? Math.max(0, (last.d[x] - old.d[x]) / dayDiff(old.date, last.date)) : null;
    };
    const rank = this.standing(id)?.rank ?? null;
    const rows: LadderRow[] = [];
    const add = (x: string, step: number | "below") => {
      const v = last.d[x], pace = paceOf(x), gap = v - mine;
      const closing = pace == null ? null : step === "below" ? pace - myPace : myPace - pace;
      const days = closing != null && closing > 0 ? Math.ceil(Math.abs(gap) / closing) : null;
      rows.push({ id: x, step, downloads: v, pace, gap, days, rank: rank != null && typeof step === "number" ? rank - step : rank != null ? rank + 1 : null });
    };
    // Who sat at each step that day was noted when it was read (see recordNeighbours).
    const at = last.s?.[id] ?? [];
    LADDER_STEPS.forEach((k, n) => { const x = at[n]; if (x && last.d[x] != null) add(x, k); });
    const below = at[LADDER_STEPS.length];
    if (below && last.d[below] != null) add(below, "below");
    return rows.length ? rows : null;
  }

  /** Several plugins summed per day, analysed like one. */
  analyzeTotal(total: TotalPt[]): Analysis | null {
    return this.analyze(total.map((x) => ({ date: x.date, total: x.total, daily: x.daily, rank: null, gap: x.gap, stale: x.stale })));
  }

  /**
   * How a plugin stands against another: the download gap, and at the last 14 days' paces
   * how many days until the one behind catches up (null when it is not gaining).
   */
  race(me: string, other: string): { gap: number; myPace: number; theirPace: number; days: number | null } | null {
    const a = this.analyze(this.official(me)), b = this.analyze(this.official(other));
    if (!a || !b) return null;
    const pace = (x: Analysis) => mean(x.d.slice(-14).filter((p) => !p.gap).map((p) => p.daily));
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
