/** One entry of the community directory (community-plugins.json). */
export interface PluginMeta {
  id: string;
  name: string;
  author: string;
  repo: string;
  description: string;
}

/**
 * A plugin's cumulative downloads, one slot per UTC day starting at `start`.
 * Dense arrays keep a 2,000-day history to a few kilobytes; `null` is a day with no reading.
 */
export interface Series {
  start: string;
  d: (number | null)[];
  /** Rank among all community plugins. Only days read from the official file carry it. */
  r: (number | null)[];
}

/** How a release did in its first days, kept per version as the official file reports it. */
export interface VersionLog {
  /** First day this version appeared in the stats. */
  first: string;
  /** Count on day 0, 1 and 2 after `first`. */
  c: (number | null)[];
  /** Latest known count. */
  total: number;
}

export interface Release { version: string; date: string }

export interface RepoInfo {
  stars: number;
  forks: number;
  openIssues: number;
  createdAt: string;
}

/** "overview", "compare", or the id of one of your plugins. */
export type View = string;
export type Range = "7" | "30" | "90" | "365" | "all";

export interface UiState {
  view: View;
  range: Range;
  align: "date" | "age";
  /** Inside a plugin's page: its own numbers, or side by side with its competitors. */
  mode: "self" | "rivals";
}

export interface Settings {
  /** Plugins whose growth you follow. Usually your own; any listed plugin works. */
  mine: string[];
  /** For each of `mine`, the plugins it is measured against. */
  competitors: Record<string, string[]>;
  /** Directory entries for everything tracked, so names show offline. */
  meta: Record<string, PluginMeta>;
  refreshMinutes: number;
  useArchive: boolean;
  catchUp: boolean;
  /** Name of an Obsidian secret holding a GitHub token. The token itself is never stored here. */
  githubSecret: string;
  motion: "auto" | "on" | "off";
  statusBar: boolean;
  milestoneNotices: boolean;
  language: "auto" | "en" | "ko";
  ui: UiState;
}

export interface Store {
  series: Record<string, Series>;
  /** Number of community plugins on each day, for "top x%". */
  of: Record<string, number>;
  versions: Record<string, Record<string, VersionLog>>;
  /** First day versions were read for a plugin; versions already out then have no known launch day. */
  vstart: Record<string, string>;
  releases: Record<string, Release[]>;
  repos: Record<string, RepoInfo>;
  /** When the official file says each plugin was last updated (ms). */
  updated: Record<string, number>;
  /** Every plugin's downloads on the latest day, largest first. */
  market: { date: string; downloads: number[] } | null;
  lastSha: string;
  lastChecked: number;
  /** When the archive and GitHub were last asked about each plugin (ms). */
  archivedAt: Record<string, number>;
  githubAt: Record<string, number>;
  /** Highest milestone already announced per plugin. */
  celebrated: Record<string, number>;
}

export interface PluginData {
  settings: Settings;
  store: Store;
}

export const DEFAULT_SETTINGS: Settings = {
  mine: [],
  competitors: {},
  meta: {},
  refreshMinutes: 30,
  useArchive: true,
  catchUp: true,
  githubSecret: "",
  motion: "auto",
  statusBar: false,
  milestoneNotices: true,
  language: "auto",
  ui: { view: "overview", range: "30", align: "date", mode: "self" },
};

export const emptyStore = (): Store => ({
  series: {}, of: {}, versions: {}, vstart: {}, releases: {}, repos: {}, updated: {},
  market: null, lastSha: "", lastChecked: 0, archivedAt: {}, githubAt: {}, celebrated: {},
});
