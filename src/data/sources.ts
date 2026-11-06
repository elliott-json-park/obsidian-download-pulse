import { requestUrl } from "obsidian";
import type { PluginMeta, Release, RepoInfo } from "../types";
import type { RawStats } from "./store";

/*
 * Every request this plugin makes is in this file. All are anonymous GETs of public data;
 * nothing about the vault or the user is sent anywhere. See "Network use" in the README.
 */

const RELEASES_REPO = "obsidianmd/obsidian-releases";
const STATS_FILE = "community-plugin-stats.json";
const LIST_FILE = "community-plugins.json";
const RAW = `https://raw.githubusercontent.com/${RELEASES_REPO}`;
/** Third-party archive of the official file's daily history, one small JSON per plugin. Optional. */
export const ARCHIVE_URL = "https://yulei-chen.github.io/obsidian-plugin-download-stats";

export class HttpError extends Error {
  constructor(public status: number, url: string) { super(`${status} — ${url}`); }
}

type AuthOrder = "anonymous-first" | "token-first";

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson<T>(url: string, token?: string, order: AuthOrder = "token-first"): Promise<T> {
  // Only GitHub's REST API cares about (and benefits from) authentication.
  // raw.githubusercontent.com and the archive are public and stay anonymous.
  if (!url.startsWith("https://api.github.com/")) {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const res = await requestUrl({ url, headers, throw: false });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url);
    return res.json as T;
  }

  const baseHeaders = { Accept: "application/vnd.github+json" };
  // Build the attempt list from the chosen order, dropping duplicates (e.g. no token).
  const attempts: (string | undefined)[] = order === "anonymous-first"
    ? [undefined, token]
    : [token, undefined];
  const seen = new Set<string>();
  const unique: (string | undefined)[] = [];
  for (const t of attempts) {
    const key = t ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  let last: HttpError | null = null;
  for (const t of unique) {
    const headers = { ...baseHeaders, ...authHeaders(t) };
    const res = await requestUrl({ url, headers, throw: false });
    if (res.status >= 200 && res.status < 300) return res.json as T;
    last = new HttpError(res.status, url);
    // A missing resource won't be fixed by switching credentials.
    if (res.status === 404) throw last;
    // Other client/server errors: stop trying.
    if (res.status !== 401 && res.status !== 403 && res.status !== 429) throw last;
    // Otherwise try the next credential (anonymous <-> token).
  }
  throw last ?? new HttpError(0, url);
}

/** `at` is when the commit was made (ms), which is when Obsidian published that day's numbers. */
export interface StatsCommit { date: string; sha: string; at: number }

/** Latest commit of the stats file per UTC day, newest first. One API call. */
export async function statsCommits(count: number, token?: string, order: AuthOrder = "token-first"): Promise<StatsCommit[]> {
  const list = await getJson<{ sha: string; commit: { committer: { date: string } } }[]>(
    `https://api.github.com/repos/${RELEASES_REPO}/commits?path=${STATS_FILE}&per_page=${Math.min(100, count)}`, token, order);
  const byDate = new Map<string, StatsCommit>();
  for (const c of list) {
    const date = c.commit.committer.date.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { date, sha: c.sha, at: Date.parse(c.commit.committer.date) });
  }
  return [...byDate.values()];
}

/** The official stats file (about 2.5 MB) at a commit, or at the tip of the branch. */
export function fetchStats(ref = "HEAD"): Promise<RawStats> {
  return getJson<RawStats>(`${RAW}/${ref}/${STATS_FILE}`);
}

let listCache: { at: number; list: PluginMeta[] } | null = null;
let listPending: Promise<PluginMeta[]> | null = null;

const cleanDescription = (d: string) => d.replace(/\s*-\s*This plugin has not been manually reviewed by Obsidian staff\.?\s*$/i, "").trim();

/** Every listed plugin. Kept in memory for six hours. */
export async function fetchPluginList(): Promise<PluginMeta[]> {
  if (listCache && Date.now() - listCache.at < 6 * 3600e3) return listCache.list;
  listPending ??= getJson<PluginMeta[]>(`${RAW}/HEAD/${LIST_FILE}`)
    .then((list) => {
      const clean = list.map((p) => ({ id: p.id, name: p.name, author: p.author, repo: p.repo, description: cleanDescription(p.description || "") }));
      listCache = { at: Date.now(), list: clean };
      return clean;
    })
    .finally(() => { listPending = null; });
  return listPending;
}

export function cachedPluginList(): PluginMeta[] | null {
  return listCache?.list ?? null;
}

export interface ArchiveHistory { startDate: string; totals: (number | null)[] }

/** A plugin's full daily history from the archive, or null if the archive does not know it. */
export async function fetchArchive(id: string): Promise<ArchiveHistory | null> {
  try {
    const h = await getJson<ArchiveHistory>(`${ARCHIVE_URL}/data/plugins/${encodeURIComponent(id)}.json`);
    return h && typeof h.startDate === "string" && Array.isArray(h.totals) ? h : null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** Releases with how often each one's main.js was downloaded — the same call, no extra request. */
export async function fetchReleases(repo: string, token?: string, order: AuthOrder = "token-first"): Promise<Release[]> {
  const list = await getJson<{ tag_name: string; published_at: string | null; draft: boolean; assets?: { name: string; download_count: number }[] }[]>(
    `https://api.github.com/repos/${repo}/releases?per_page=100`, token, order);
  return list
    .filter((r) => !r.draft && r.published_at)
    .map((r) => {
      const main = r.assets?.find((a) => a.name === "main.js");
      return { version: r.tag_name.replace(/^v/i, ""), date: r.published_at as string, ...(main ? { installs: main.download_count } : {}) };
    });
}

export async function fetchRepo(repo: string, token?: string, order: AuthOrder = "token-first"): Promise<RepoInfo> {
  const r = await getJson<{ stargazers_count: number; forks_count: number; open_issues_count: number; created_at: string }>(
    `https://api.github.com/repos/${repo}`, token, order);
  return { stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, createdAt: r.created_at };
}
