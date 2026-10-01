import type { Series, Store, VersionLog } from "../types";

export const DAY = 86400000;
export const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Raw entry of community-plugin-stats.json: `downloads`, `updated`, and one count per version. */
export type RawStats = Record<string, Record<string, number>>;

function ensure(store: Store, id: string, date: string): { s: Series; i: number } {
  let s = store.series[id];
  if (!s) s = store.series[id] = { start: date, d: [], r: [] };
  let i = dayDiff(s.start, date);
  if (i < 0) {
    // An earlier day than anything known: grow the arrays at the front.
    const pad = new Array<null>(-i).fill(null);
    s.d = [...pad, ...s.d];
    s.r = [...pad, ...s.r];
    s.start = date;
    i = 0;
  }
  while (s.d.length <= i) s.d.push(null);
  while (s.r.length <= i) s.r.push(null);
  return { s, i };
}

export function setPoint(store: Store, id: string, date: string, downloads: number, rank?: number | null): void {
  const { s, i } = ensure(store, id, date);
  s.d[i] = downloads;
  if (rank != null) s.r[i] = rank;
}

/** Fills a day only when nothing better is there — the archive never overwrites a reading of our own. */
export function fillPoint(store: Store, id: string, date: string, downloads: number): boolean {
  const s = store.series[id];
  if (s) {
    const i = dayDiff(s.start, date);
    if (i >= 0 && i < s.d.length && s.d[i] != null) return false;
  }
  setPoint(store, id, date, downloads);
  return true;
}

export function getPoint(store: Store, id: string, date: string): { downloads: number; rank: number | null } | null {
  const s = store.series[id];
  if (!s) return null;
  const i = dayDiff(s.start, date);
  const v = s.d[i];
  return v == null ? null : { downloads: v, rank: s.r[i] ?? null };
}

export function lastDateOf(store: Store, id: string): string | null {
  const s = store.series[id];
  if (!s) return null;
  for (let i = s.d.length - 1; i >= 0; i--) if (s.d[i] != null) return addDays(s.start, i);
  return null;
}

export function versionsOf(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== "downloads" && k !== "updated") out[k] = v;
  return out;
}

/** Keeps the first three days of each version. Days may arrive out of order (catch-up, imports). */
export function logVersions(store: Store, id: string, date: string, versions: Record<string, number>): void {
  const log = (store.versions[id] ??= {});
  if (!store.vstart[id] || date < store.vstart[id]) store.vstart[id] = date;
  for (const [v, n] of Object.entries(versions)) {
    const e: VersionLog | undefined = log[v];
    if (!e) { log[v] = { first: date, c: [n, null, null], total: n }; continue; }
    if (date < e.first) {
      const shift = dayDiff(date, e.first);
      const c: (number | null)[] = [n, null, null];
      e.c.forEach((x, k) => { if (k + shift <= 2) c[k + shift] = x; });
      e.first = date; e.c = c;
    } else {
      const k = dayDiff(e.first, date);
      if (k <= 2) e.c[k] = n;
    }
    e.total = Math.max(e.total, n);
  }
}

/** Largest first. */
export function sortedDownloads(stats: RawStats): number[] {
  return Object.values(stats).map((s) => s.downloads || 0).sort((a, b) => b - a);
}

/** Rank = plugins with more downloads + 1. */
export function rankOf(sorted: number[], downloads: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] > downloads) lo = mid + 1; else hi = mid; }
  return lo + 1;
}

/** Writes one day of the official file for the given plugins. `withVersions` limits version logs to your own. */
export function recordDay(store: Store, stats: RawStats, date: string, ids: string[], withVersions: Set<string>, sorted = sortedDownloads(stats)): number {
  let found = 0;
  store.of[date] = sorted.length;
  for (const id of ids) {
    const s = stats[id];
    if (!s) continue;
    setPoint(store, id, date, s.downloads || 0, rankOf(sorted, s.downloads || 0));
    if (s.updated) store.updated[id] = s.updated;
    if (withVersions.has(id)) logVersions(store, id, date, versionsOf(s));
    found++;
  }
  if (!store.market || date >= store.market.date) store.market = { date, downloads: sorted };
  return found;
}

/** Drops what is no longer tracked, so the data file does not grow forever. */
export function prune(store: Store, keep: Set<string>): void {
  for (const key of ["series", "versions", "vstart", "releases", "repos", "updated", "archivedAt", "githubAt", "celebrated"] as const) {
    const rec = store[key] as Record<string, unknown>;
    for (const id of Object.keys(rec)) if (!keep.has(id)) delete rec[id];
  }
}

/**
 * Accepts this plugin's own export, or the `history.json` written by the standalone HTML dashboard
 * this plugin grew out of (`snapshots[date][id] = { downloads, versions, rank, of }`).
 */
export function importInto(store: Store, data: unknown, mine: Set<string>): number {
  const o = data as Record<string, unknown>;
  let n = 0;
  if (o && typeof o === "object" && o.snapshots && typeof o.snapshots === "object") {
    const snaps = o.snapshots as Record<string, Record<string, { downloads: number; versions?: Record<string, number>; rank?: number; of?: number }>>;
    for (const date of Object.keys(snaps).sort()) {
      for (const [id, p] of Object.entries(snaps[date])) {
        if (typeof p?.downloads !== "number") continue;
        setPoint(store, id, date, p.downloads, p.rank ?? null);
        if (p.of) store.of[date] = p.of;
        if (p.versions && mine.has(id)) logVersions(store, id, date, p.versions);
        n++;
      }
    }
    const rel = o.releases as Store["releases"] | undefined;
    if (rel) for (const [id, list] of Object.entries(rel)) if (!store.releases[id]?.length) store.releases[id] = list;
    const repos = o.repos as Store["repos"] | undefined;
    if (repos) for (const [id, r] of Object.entries(repos)) store.repos[id] ??= r;
    return n;
  }
  const st = (o?.store ?? o) as Partial<Store>;
  if (st && st.series) {
    for (const [id, s] of Object.entries(st.series)) {
      s.d.forEach((v, i) => { if (v != null) { setPoint(store, id, addDays(s.start, i), v, s.r?.[i] ?? null); n++; } });
    }
    for (const [d, c] of Object.entries(st.of ?? {})) store.of[d] ??= c;
    for (const [id, log] of Object.entries(st.versions ?? {})) store.versions[id] ??= log;
    for (const [id, d] of Object.entries(st.vstart ?? {})) if (!store.vstart[id] || d < store.vstart[id]) store.vstart[id] = d;
    for (const [id, r] of Object.entries(st.releases ?? {})) if (!store.releases[id]?.length) store.releases[id] = r;
    for (const [id, r] of Object.entries(st.repos ?? {})) store.repos[id] ??= r;
    if (st.market && (!store.market || st.market.date > store.market.date)) store.market = st.market;
  }
  return n;
}
