import { Events, Platform } from "obsidian";
import type { Settings, Store } from "../types";
import { addDays, fillPoint, getPoint, recordDay, sortedDownloads, todayUtc, type RawStats } from "./store";
import { NICE } from "../analysis";
import { fetchArchive, fetchPluginList, fetchReleases, fetchRepo, fetchStats, HttpError, statsCommits, type StatsCommit } from "./sources";


export interface Host {
  settings: Settings;
  store: Store;
  save(): Promise<void>;
  token(): string | undefined;
  celebrate(id: string, milestone: number): void;
}

export type StatusState = "idle" | "loading" | "ok" | "partial" | "offline";
export interface Status { state: StatusState; at: number; detail?: string }

const ARCHIVE_EVERY = 3 * 86400e3;
const GITHUB_EVERY = 12 * 3600e3;

/**
 * Keeps the local history current. One refresh costs one GitHub API call when nothing changed;
 * the 2.5 MB stats file is downloaded only when Obsidian has published a new one.
 */
export class Engine extends Events {
  status: Status = { state: "idle", at: 0 };
  /** The newest official file, kept in memory so adding a plugin does not download it again. */
  private latest: { sha: string; date: string; stats: RawStats; sorted: number[] } | null = null;
  private running: Promise<void> | null = null;
  private tried = new Set<string>();
  /** Plugins missing from the newest file (not listed yet, or removed). Not worth a fresh download each time. */
  private absent = new Set<string>();

  constructor(private host: Host) { super(); }

  get settings(): Settings { return this.host.settings; }
  get store(): Store { return this.host.store; }

  tracked(): string[] {
    const s = this.settings;
    return [...new Set([...s.mine, ...s.mine.flatMap((id) => s.competitors[id] ?? [])])];
  }

  refresh(force = false): Promise<void> {
    this.running ??= this.run(force).finally(() => { this.running = null; });
    return this.running;
  }

  get busy(): boolean { return this.running != null; }

  private setStatus(state: StatusState, detail?: string) {
    this.status = { state, at: state === "loading" ? this.status.at : Date.now(), detail };
    this.trigger("status", this.status);
  }

  private async run(force: boolean): Promise<void> {
    const ids = this.tracked();
    if (!ids.length) { this.setStatus("idle"); return; }
    this.setStatus("loading");
    const notes: string[] = [];
    let changed = false;
    try {
      changed = (await this.readOfficial(ids, force, notes)) || changed;
    } catch (e) {
      console.warn("Plugin Pulse: could not read the official stats", e);
      this.setStatus("offline", String((e as Error)?.message ?? e));
      return;
    }
    // Everything below is extra; a failure there leaves the downloads already recorded.
    await this.fillMeta(ids).catch((e) => notes.push("directory: " + (e as Error).message));
    if (this.settings.useArchive) changed = (await this.fillArchive(ids, notes)) || changed;
    changed = (await this.readGithub(ids, notes)) || changed;
    this.checkMilestones();
    this.store.lastChecked = Date.now();
    await this.host.save();
    this.setStatus(notes.length ? "partial" : "ok", notes.join("\n") || undefined);
    if (changed || force) this.trigger("changed");
  }

  /** Records the newest official day, and with catch-up on, the days missed while Obsidian was closed. */
  private async readOfficial(ids: string[], force: boolean, notes: string[]): Promise<boolean> {
    const mine = new Set(this.settings.mine);
    const token = this.host.token();
    let commits: StatsCommit[] | null = null;
    try {
      commits = await statsCommits(this.settings.catchUp ? 20 : 1, token);
    } catch (e) {
      notes.push(e instanceof HttpError && (e.status === 403 || e.status === 429) ? "github-limit" : "github: " + (e as Error).message);
    }

    if (!commits?.length) {
      // GitHub's API is unavailable (usually its hourly limit): read the file directly and date it today.
      if (!force && this.latest && Date.now() - this.store.lastChecked < 30 * 60e3) return false;
      const stats = await fetchStats();
      const sorted = sortedDownloads(stats);
      const moved = ids.some((id) => stats[id] && this.latestDownloads(id) !== stats[id].downloads);
      const date = todayUtc();
      this.latest = { sha: "", date, stats, sorted };
      if (moved || ids.some((id) => stats[id] && !getPoint(this.store, id, date))) {
        recordDay(this.store, stats, date, ids, mine, sorted);
        return true;
      }
      this.store.market = { date: this.store.market?.date ?? date, downloads: sorted };
      return false;
    }

    const head = commits[0];
    const todo: StatsCommit[] = [];
    const missingAt = (date: string) => ids.some((id) => !this.absent.has(id) && getPoint(this.store, id, date)?.rank == null);
    if (force || head.sha !== this.store.lastSha || missingAt(head.date)) todo.push(head);

    if (this.settings.catchUp) {
      const cap = Platform.isMobile ? 3 : 7;
      // Only after the first day we read ourselves: earlier days are the archive's job.
      const since = this.firstOfficialDay();
      for (const c of commits.slice(1)) {
        if (todo.length > cap || !since || c.date < since || c.date < addDays(head.date, -cap)) break;
        const key = c.sha;
        if (this.tried.has(key)) continue;
        if (this.settings.mine.some((id) => getPoint(this.store, id, c.date)?.rank == null)) { todo.push(c); this.tried.add(key); }
      }
    }

    let changed = false;
    for (const c of todo.sort((a, b) => a.date.localeCompare(b.date))) {
      const reuse = this.latest?.sha === c.sha ? this.latest : null;
      const stats = reuse?.stats ?? await fetchStats(c.sha);
      const sorted = reuse?.sorted ?? sortedDownloads(stats);
      recordDay(this.store, stats, c.date, ids, mine, sorted);
      if (c === head) {
        this.latest = { sha: c.sha, date: c.date, stats, sorted };
        this.absent = new Set(ids.filter((id) => !stats[id]));
      }
      changed = true;
    }
    this.store.lastSha = head.sha;
    return changed;
  }

  /**
   * Explicit, user-started backfill from the official history — about 2.5 MB per day,
   * for people who keep the archive off.
   */
  async backfillOfficial(days: number, onProgress: (done: number, total: number) => void): Promise<number> {
    const ids = this.tracked();
    const mine = new Set(this.settings.mine);
    const commits = (await statsCommits(Math.min(100, days + 5), this.host.token())).slice(0, days);
    const todo = commits.filter((c) => ids.some((id) => getPoint(this.store, id, c.date)?.rank == null));
    let done = 0;
    for (const c of todo) {
      const stats = await fetchStats(c.sha);
      const found = recordDay(this.store, stats, c.date, ids, mine);
      onProgress(++done, todo.length);
      if (!found) break; // older than every tracked plugin
    }
    await this.host.save();
    this.trigger("changed");
    return done;
  }

  private firstOfficialDay(): string | null {
    let first: string | null = null;
    for (const id of this.settings.mine) {
      const s = this.store.series[id];
      if (!s) continue;
      const i = s.r.findIndex((v) => v != null);
      if (i >= 0) { const d = addDays(s.start, i); if (!first || d < first) first = d; }
    }
    return first;
  }

  latestDownloads(id: string): number | null {
    const s = this.store.series[id];
    if (!s) return null;
    for (let i = s.d.length - 1; i >= 0; i--) if (s.d[i] != null) return s.d[i];
    return null;
  }

  /** Total downloads of any listed plugin, once the latest file is in memory. */
  downloadsOf(id: string): number | null {
    return this.latest?.stats[id]?.downloads ?? this.latestDownloads(id);
  }

  private loading: Promise<void> | null = null;
  /** Loads the newest official file into memory (for search and suggestions) if a refresh hasn't already. */
  ensureLatest(): Promise<void> {
    if (this.latest) return Promise.resolve();
    this.loading ??= fetchStats().then((stats) => {
      this.latest ??= { sha: "", date: this.store.market?.date ?? todayUtc(), stats, sorted: sortedDownloads(stats) };
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Records a newly added plugin straight from memory when the latest file is already loaded. */
  recordFromMemory(ids: string[]): boolean {
    // Only a file read by a refresh has a trustworthy date; one loaded for search may be newer than the last refresh.
    if (!this.latest?.sha) return false;
    recordDay(this.store, this.latest.stats, this.latest.date, ids, new Set(this.settings.mine), this.latest.sorted);
    return true;
  }

  private async fillMeta(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.settings.meta[id]);
    if (!missing.length) return;
    const list = await fetchPluginList();
    for (const id of missing) {
      const m = list.find((p) => p.id === id);
      if (m) this.settings.meta[id] = m;
    }
  }

  private async fillArchive(ids: string[], notes: string[]): Promise<boolean> {
    const due = ids.filter((id) => Date.now() - (this.store.archivedAt[id] ?? 0) > ARCHIVE_EVERY);
    let changed = false;
    await pool(due, 4, async (id) => {
      try {
        const h = await fetchArchive(id);
        if (h) h.totals.forEach((v, i) => { if (v != null && fillPoint(this.store, id, addDays(h.startDate, i), v)) changed = true; });
        this.store.archivedAt[id] = Date.now();
      } catch (e) {
        notes.push("archive: " + (e as Error).message);
      }
    });
    return changed;
  }

  /** Release dates and stars. GitHub allows 60 anonymous calls an hour, so this runs twice a day at most. */
  private async readGithub(ids: string[], notes: string[]): Promise<boolean> {
    const token = this.host.token();
    const due = ids.filter((id) => this.settings.meta[id]?.repo && Date.now() - (this.store.githubAt[id] ?? 0) > GITHUB_EVERY);
    // Your own plugins first: if the hourly limit runs out, it runs out on competitors.
    const mine = new Set(this.settings.mine);
    due.sort((a, b) => Number(mine.has(b)) - Number(mine.has(a)));
    let limited = false, changed = false;
    await pool(due, 3, async (id) => {
      if (limited) return;
      const repo = this.settings.meta[id].repo;
      try {
        const [releases, info] = await Promise.all([fetchReleases(repo, token), fetchRepo(repo, token)]);
        this.store.releases[id] = releases;
        this.store.repos[id] = info;
        this.store.githubAt[id] = Date.now();
        changed = true;
      } catch (e) {
        if (e instanceof HttpError && (e.status === 403 || e.status === 429)) limited = true;
        else if (e instanceof HttpError && e.status === 404) this.store.githubAt[id] = Date.now();
        else notes.push("github: " + (e as Error).message);
      }
    });
    if (limited && !notes.includes("github-limit")) notes.push("github-limit");
    return changed;
  }

  private checkMilestones(): void {
    for (const id of this.settings.mine) {
      const total = this.latestDownloads(id);
      if (total == null) continue;
      const reached = [...NICE].reverse().find((m) => m <= total) ?? 0;
      const before = this.store.celebrated[id];
      this.store.celebrated[id] = Math.max(before ?? 0, reached);
      // The first reading only sets the bar; a notice is for crossing one while you watch.
      if (before != null && reached > before && this.settings.milestoneNotices) this.host.celebrate(id, reached);
    }
  }
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
