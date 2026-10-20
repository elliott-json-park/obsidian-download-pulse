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

export interface Release {
  version: string;
  date: string;
  /** Times the release's main.js was downloaded. Obsidian fetches it only to install or update a plugin. */
  installs?: number;
}

/**
 * Your plugins' count per version on each day of the official file, so a day's growth can be split into
 * bots (many recent versions grow by the same amount) and the rest. `v` names the columns of every row.
 */
export interface VersionDays { v: string[]; d: Record<string, (number | null)[]> }

/**
 * Downloads of the plugins around yours in the overall ranking, on one day of the official file. `w` lists the
 * ones picked that day (a few steps above each of yours and the one just below); `d` also keeps those picked on the
 * other days still held, so a plugin's pace can be measured across the days.
 */
export interface Neighbours { date: string; w: string[]; s: Record<string, (string | null)[]>; d: Record<string, number> }

/** Which numbers the dashboard shows for your own plugins. Competitors and ranks are always official. */
export type Basis = "official" | "human";

/** One of your plugins that the newest official file no longer lists. */
export interface Delisted {
  /** Date of the last official file that still had it. */
  since: string;
  /** Its downloads in that file. */
  last: number;
}

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
  /** Official downloads, or with bots taken out. */
  basis: Basis;
}

/** The last choices in the share card dialog. */
export interface ShareOpts {
  format: "wide" | "story";
  theme: "light" | "dark";
  days: 7 | 30 | 90;
}

export interface Settings {
  /** Plugins whose growth you follow. Usually your own; any listed plugin works. */
  mine: string[];
  /** For each of `mine`, the plugins it is measured against. */
  competitors: Record<string, string[]>;
  /** Directory entries for everything tracked, so names show offline. */
  meta: Record<string, PluginMeta>;
  /** -1 checks right after Obsidian's daily publish time, 0 only by hand, otherwise every n minutes. */
  refreshMinutes: number;
  useArchive: boolean;
  catchUp: boolean;
  /** Name of an Obsidian secret holding a GitHub token. The token itself is never stored here. */
  githubSecret: string;
  motion: "auto" | "on" | "off";
  statusBar: boolean;
  milestoneNotices: boolean;
  language: LanguagePref;
  /** Folder for weekly report notes; empty means the vault root. */
  reportFolder: string;
  ui: UiState;
  share: ShareOpts;
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
  /** When Obsidian published the newest file we read (ms), to know when the next one is due. */
  publishedAt: number;
  lastChecked: number;
  /** When the archive and GitHub were last asked about each plugin (ms). */
  archivedAt: Record<string, number>;
  githubAt: Record<string, number>;
  /** Highest milestone already announced per plugin. */
  celebrated: Record<string, number>;
  /** Your plugins' main.js downloads summed over all releases, by the UTC day GitHub was read. */
  installs: Record<string, Record<string, number>>;
  /** Your plugins missing from the newest official file. */
  delisted: Record<string, Delisted>;
  /** Per-version counts by day, for your own plugins (the last 400 days). */
  vdays: Record<string, VersionDays>;
  /** The plugins a few steps above and just below yours in the ranking, over the last days read. */
  near: Neighbours[];
}

/** The interface languages to choose from; "auto" follows Obsidian. */
export const LANGUAGES = ["auto", "en", "ko", "zh"] as const;
export type LanguagePref = typeof LANGUAGES[number];

export interface PluginData {
  settings: Settings;
  store: Store;
}

export const DEFAULT_SETTINGS: Settings = {
  mine: [],
  competitors: {},
  meta: {},
  refreshMinutes: -1,
  useArchive: true,
  catchUp: true,
  githubSecret: "",
  motion: "auto",
  statusBar: false,
  milestoneNotices: true,
  language: "auto",
  reportFolder: "",
  ui: { view: "overview", range: "30", align: "date", mode: "self", basis: "official" },
  share: { format: "wide", theme: "light", days: 30 },
};

export const emptyStore = (): Store => ({
  series: {}, of: {}, versions: {}, vstart: {}, releases: {}, repos: {}, updated: {},
  market: null, lastSha: "", publishedAt: 0, lastChecked: 0, archivedAt: {}, githubAt: {}, celebrated: {},
  installs: {}, delisted: {}, vdays: {}, near: [],
});
