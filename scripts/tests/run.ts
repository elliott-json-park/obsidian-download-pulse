/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { emptyStore, DEFAULT_SETTINGS, LANGUAGES, type Settings, type Store } from "../../src/types";
import { setLanguage, resolveLanguage, t, loc, lang, type Dict, type Lang } from "../../src/i18n";
import { setPoint, fillPoint, getPoint, logVersions, logVersionDay, versionDay, rankOf, recordDay, importInto, prune, addDays } from "../../src/data/store";
import { Model, similarPlugins } from "../../src/analysis";
import { forecast, etaRange } from "../../src/forecast";
import { weeklyReport } from "../../src/report";
import { Engine } from "../../src/data/engine";
// @ts-expect-error -- plain JS test stub
import { requests } from "obsidian";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ---------- storage ----------
test("series grow at both ends and keep nulls for missed days", () => {
  const s = emptyStore();
  setPoint(s, "a", "2026-09-10", 100, 50);
  setPoint(s, "a", "2026-09-12", 130);
  setPoint(s, "a", "2026-09-08", 80);
  assert.equal(s.series.a.start, "2026-09-08");
  assert.deepEqual(s.series.a.d, [80, null, 100, null, 130]);
  assert.deepEqual(s.series.a.r, [null, null, 50, null, null]);
});

test("the archive fills gaps but never overwrites a reading", () => {
  const s = emptyStore();
  setPoint(s, "a", "2026-09-10", 100, 5);
  assert.equal(fillPoint(s, "a", "2026-09-10", 999), false);
  assert.equal(fillPoint(s, "a", "2026-09-11", 110), true);
  assert.equal(getPoint(s, "a", "2026-09-10")?.downloads, 100);
  assert.equal(getPoint(s, "a", "2026-09-11")?.rank, null);
});

test("version logs keep the first three days, even when days arrive out of order", () => {
  const s = emptyStore();
  logVersions(s, "a", "2026-09-11", { "1.1.0": 7 });
  logVersions(s, "a", "2026-09-12", { "1.1.0": 9 });
  logVersions(s, "a", "2026-09-10", { "1.1.0": 3 });
  logVersions(s, "a", "2026-09-20", { "1.1.0": 40 });
  assert.deepEqual(s.versions.a["1.1.0"], { first: "2026-09-10", c: [3, 7, 9], total: 40 });
  assert.equal(s.vstart.a, "2026-09-10");
});

test("rank counts plugins with more downloads", () => {
  const sorted = [500, 300, 300, 100, 10];
  assert.equal(rankOf(sorted, 600), 1);
  assert.equal(rankOf(sorted, 300), 2);
  assert.equal(rankOf(sorted, 100), 4);
  assert.equal(rankOf(sorted, 0), 6);
});

test("recordDay writes downloads, rank, update time and versions only for your own", () => {
  const s = emptyStore();
  const stats = { a: { downloads: 50, updated: 123, "1.0.0": 50 }, b: { downloads: 500, "2.0.0": 500 }, c: { downloads: 5 } };
  const n = recordDay(s, stats, "2026-09-10", ["a", "b", "missing"], new Set(["a"]));
  assert.equal(n, 2);
  assert.deepEqual(getPoint(s, "a", "2026-09-10"), { downloads: 50, rank: 2 });
  assert.equal(s.of["2026-09-10"], 3);
  assert.equal(s.updated.a, 123);
  assert.ok(s.versions.a["1.0.0"]);
  assert.equal(s.versions.b, undefined);
  assert.deepEqual(s.market?.downloads, [500, 50, 5]);
});

test("prune forgets plugins no longer followed", () => {
  const s = emptyStore();
  setPoint(s, "a", "2026-09-10", 1);
  setPoint(s, "b", "2026-09-10", 1);
  s.repos.b = { stars: 1, forks: 0, openIssues: 0, createdAt: "" };
  prune(s, new Set(["a"]));
  assert.deepEqual(Object.keys(s.series), ["a"]);
  assert.equal(s.repos.b, undefined);
});

test("imports the HTML dashboard's history.json", () => {
  const s = emptyStore();
  const n = importInto(s, {
    snapshots: {
      "2026-08-14": { x: { downloads: 7, versions: { "1.0.0": 7 }, rank: 6595, of: 6621 } },
      "2026-08-15": { x: { downloads: 12, versions: { "1.0.0": 7, "1.1.0": 5 }, rank: 6579, of: 6642 } },
    },
    releases: { x: [{ version: "1.1.0", date: "2026-08-15T01:00:00Z" }] },
  }, new Set(["x"]));
  assert.equal(n, 2);
  assert.deepEqual(s.series.x.d, [7, 12]);
  assert.deepEqual(s.series.x.r, [6595, 6579]);
  assert.equal(s.of["2026-08-15"], 6642);
  assert.equal(s.versions.x["1.1.0"].first, "2026-08-15");
  assert.equal(s.releases.x.length, 1);
});

test("an export imports back into an empty store unchanged", () => {
  const a = emptyStore();
  setPoint(a, "p", "2026-09-01", 10, 3);
  setPoint(a, "p", "2026-09-03", 30, 2);
  const b = emptyStore();
  importInto(b, JSON.parse(JSON.stringify({ format: "plugin-pulse", store: a })), new Set());
  assert.deepEqual(b.series, a.series);
});

// ---------- analysis ----------
function linear(s: Store, id: string, start: string, days: number, from: number, perDay: number) {
  for (let i = 0; i < days; i++) setPoint(s, id, addDays(start, i), from + perDay * i, 1000 - i);
}

test("daily values fold a missed day into the next reading", () => {
  const s = emptyStore();
  setPoint(s, "a", "2026-09-01", 10);
  setPoint(s, "a", "2026-09-03", 30);
  const ser = new Model(s).series("a");
  assert.deepEqual(ser.map((p) => p.daily), [null, null, 20]);
  assert.equal(ser[2].gap, true);
});

test("analyze finds pace, milestones and the next one", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 30, 0, 10); // 0..290
  const A = new Model(s).analyze(new Model(s).series("a"));
  assert.ok(A);
  assert.equal(A.total, 290);
  assert.equal(A.pace, 10);
  assert.equal(A.next, 500);
  assert.equal(A.etaDays, 21);
  assert.deepEqual(A.achieved.map((x) => x.m), [10, 25, 50, 100, 250]);
});

test("totalSeries sums plugins and treats days before a plugin's listing as zero", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 5, 100, 10);
  linear(s, "b", "2026-09-03", 3, 7, 1);
  const tot = new Model(s).totalSeries(["a", "b"]);
  assert.equal(tot.length, 5);
  assert.equal(tot[0].total, 100);
  assert.equal(tot[2].total, 120 + 7);
  assert.equal(tot[2].parts.b.daily, 7);
  assert.equal(tot[4].total, 140 + 9);
});

test("race: days until the one behind catches up, or null when it can't", () => {
  const s = emptyStore();
  linear(s, "me", "2026-09-01", 20, 100, 30);
  linear(s, "them", "2026-09-01", 20, 500, 10);
  const r = new Model(s).race("me", "them");
  assert.ok(r);
  assert.equal(r.gap, 500 + 190 - (100 + 570));
  assert.equal(r.days, 1);
  linear(s, "far", "2026-09-01", 20, 5000, 50);
  assert.equal(new Model(s).race("me", "far")?.days, null);
});

test("launches: an already-out version shows its first 3 observed days, a fresh one its launch count", () => {
  const s = emptyStore();
  // 1.0.0 was already out when tracking started; 1.1.0 launched the next day.
  logVersions(s, "a", "2026-09-10", { "1.0.0": 800 });
  logVersions(s, "a", "2026-09-11", { "1.0.0": 850, "1.1.0": 3 });
  logVersions(s, "a", "2026-09-12", { "1.0.0": 900, "1.1.0": 8 });
  setPoint(s, "a", "2026-09-12", 900, 1);
  const L = new Model(s).launches("a");
  const old = L.find((x) => x.version === "1.0.0");
  const fresh = L.find((x) => x.version === "1.1.0");
  assert.equal(old.known, false);
  assert.equal(old.first3, 900 - 800);
  assert.equal(fresh.known, true);
  assert.equal(fresh.first3, 8);
});

test("standing reads rank, share and the climb over 7 days", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 10, 0, 10);
  s.of["2026-09-10"] = 2000;
  s.market = { date: "2026-09-10", downloads: Array.from({ length: 2000 }, (_, i) => 2000 - i) };
  const st = new Model(s).standing("a");
  assert.ok(st);
  assert.equal(st.rank, 991);
  assert.equal(st.climbed7, 7);
  assert.equal(st.topPct, 991 / 2000 * 100);
});

test("similar plugins share rare words, not common ones", () => {
  const list = [
    { id: "me", name: "Vault Orrery", description: "3D graph of folders as stars" },
    { id: "g", name: "Galaxy View", description: "Cinematic 3D graph view" },
    { id: "t", name: "Tasks", description: "Track tasks in your notes" },
    { id: "c", name: "Constellations", description: "A 3D star map: notes are stars" },
  ];
  const ids = similarPlugins(list[0], list).map((p) => p.id);
  assert.ok(ids.includes("g") && ids.includes("c"));
  assert.ok(!ids.includes("t"));
  assert.ok(!ids.includes("me"));
});

// ---------- engine, against a fake network ----------
function host(settings: Partial<Settings>) {
  const h = {
    settings: { ...DEFAULT_SETTINGS, ...settings } as Settings,
    store: emptyStore(),
    saves: 0,
    celebrated: [] as [string, number][],
    async save() { h.saves++; },
    token: () => undefined,
    celebrate(id: string, m: number) { h.celebrated.push([id, m]); },
    delistedSeen: [] as [string, number][],
    delisted(id: string, last: number) { h.delistedSeen.push([id, last]); },
  };
  return h;
}
const API = "https://api.github.com/repos/obsidianmd/obsidian-releases/commits";
const RAW = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/";
const ARCHIVE = "https://yulei-chen.github.io/";

function network(days: { date: string; sha: string; stats: Record<string, any> }[], archive: Record<string, any> = {}) {
  (globalThis as any).__routes = {
    [API]: () => ({ json: [...days].reverse().map((d) => ({ sha: d.sha, commit: { committer: { date: d.date + "T01:00:00Z" } } })) }),
    [RAW]: (url: string) => { const sha = url.slice(RAW.length).split("/")[0]; const d = days.find((x) => x.sha === sha) ?? days[days.length - 1]; return { json: d.stats }; },
    [ARCHIVE]: (url: string) => { const id = decodeURIComponent(url.split("/").pop()!.replace(".json", "")); return archive[id] ? { json: archive[id] } : { status: 404 }; },
    "https://api.github.com/repos/": () => ({ json: [] }),
  };
  requests.length = 0;
}
const rawCalls = () => requests.filter((u: string) => u.startsWith(RAW)).length;

test("engine: records the newest day, then skips the 2.5 MB download when nothing is new", async () => {
  const h = host({ mine: ["a"], competitors: { a: ["b"] }, useArchive: false, catchUp: false, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" }, b: { id: "b", name: "B", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-10", sha: "s1", stats: { a: { downloads: 90 }, b: { downloads: 400 } } }]);
  const e = new Engine(h);
  await e.refresh();
  assert.deepEqual(getPoint(h.store, "a", "2026-09-10"), { downloads: 90, rank: 2 });
  assert.deepEqual(getPoint(h.store, "b", "2026-09-10"), { downloads: 400, rank: 1 });
  assert.equal(rawCalls(), 1);
  await e.refresh();
  assert.equal(rawCalls(), 1, "same commit: no new download");
  assert.equal(e.status.state, "ok");
});

test("engine: catches up days missed while closed, oldest first", async () => {
  const h = host({ mine: ["a"], useArchive: false, catchUp: true, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-10", sha: "s1", stats: { a: { downloads: 10, "1.0.0": 10 } } }]);
  const e = new Engine(h);
  await e.refresh();
  network([
    { date: "2026-09-10", sha: "s1", stats: { a: { downloads: 10, "1.0.0": 10 } } },
    { date: "2026-09-11", sha: "s2", stats: { a: { downloads: 15, "1.0.0": 10, "1.1.0": 5 } } },
    { date: "2026-09-12", sha: "s3", stats: { a: { downloads: 22, "1.0.0": 10, "1.1.0": 12 } } },
  ]);
  await e.refresh();
  assert.deepEqual(h.store.series.a.d, [10, 15, 22]);
  assert.ok(h.store.series.a.r.every((r) => r === 1));
  assert.deepEqual(h.store.versions.a["1.1.0"].c, [5, 12, null]);
});

test("engine: the archive fills the past without touching official readings", async () => {
  const h = host({ mine: ["a"], useArchive: true, catchUp: false, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-12", sha: "s1", stats: { a: { downloads: 30 } } }],
    { a: { startDate: "2026-09-09", totals: [5, null, 20, 29] } });
  await new Engine(h).refresh();
  assert.equal(h.store.series.a.start, "2026-09-09");
  assert.deepEqual(h.store.series.a.d, [5, null, 20, 30]);
});

test("engine: a milestone is announced when crossed, not on the first reading", async () => {
  const h = host({ mine: ["a"], useArchive: false, catchUp: false, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-10", sha: "s1", stats: { a: { downloads: 120 } } }]);
  const e = new Engine(h);
  await e.refresh();
  assert.deepEqual(h.celebrated, []);
  network([{ date: "2026-09-11", sha: "s2", stats: { a: { downloads: 260 } } }]);
  await e.refresh();
  assert.deepEqual(h.celebrated, [["a", 250]]);
});

test("engine: goes offline gracefully when nothing answers", async () => {
  const h = host({ mine: ["a"], meta: {} });
  (globalThis as any).__routes = {};
  const e = new Engine(h);
  await e.refresh();
  assert.equal(e.status.state, "offline");
});

test("engine: a plugin missing from the newest file is marked once, and cleared when it is back", async () => {
  const meta = { a: { id: "a", name: "A", author: "", repo: "", description: "" } };
  const h = host({ mine: ["a"], useArchive: false, catchUp: false, meta });
  network([{ date: "2026-10-15", sha: "s1", stats: { a: { downloads: 300 }, z: { downloads: 9 } } }]);
  const e = new Engine(h);
  await e.refresh();
  assert.deepEqual(h.store.delisted, {});
  network([{ date: "2026-10-16", sha: "s2", stats: { z: { downloads: 9 } } }]);
  await e.refresh();
  assert.deepEqual(h.store.delisted, { a: { since: "2026-10-15", last: 300 } });
  network([{ date: "2026-10-17", sha: "s3", stats: { z: { downloads: 9 } } }]);
  await e.refresh();
  assert.deepEqual(h.delistedSeen, [["a", 300]], "said once, not every day it stays missing");
  const m = new Model(h.store);
  assert.deepEqual(m.delisted("a"), { date: "2026-10-14", since: "2026-10-15", last: 300 });
  network([{ date: "2026-10-18", sha: "s4", stats: { a: { downloads: 330 }, z: { downloads: 9 } } }]);
  await e.refresh();
  assert.deepEqual(h.store.delisted, {});
});

test("engine: main.js downloads of your releases are summed per day read", async () => {
  const meta = { a: { id: "a", name: "A", author: "", repo: "me/a", description: "" }, b: { id: "b", name: "B", author: "", repo: "you/b", description: "" } };
  const h = host({ mine: ["a"], competitors: { a: ["b"] }, useArchive: false, catchUp: false, meta });
  network([{ date: "2026-10-15", sha: "s1", stats: { a: { downloads: 30 }, b: { downloads: 50 } } }]);
  const rel = [
    { tag_name: "1.1.0", published_at: "2026-10-10T00:00:00Z", draft: false, assets: [{ name: "main.js", download_count: 40 }, { name: "manifest.json", download_count: 900 }] },
    { tag_name: "1.0.0", published_at: "2026-10-01T00:00:00Z", draft: false, assets: [{ name: "main.js", download_count: 25 }] },
    { tag_name: "1.2.0", published_at: null, draft: true, assets: [{ name: "main.js", download_count: 99 }] },
  ];
  (globalThis as any).__routes["https://api.github.com/repos/"] = (url: string) => url.endsWith("/releases?per_page=100") ? { json: rel } : { json: { stargazers_count: 1, forks_count: 0, open_issues_count: 0, created_at: "" } };
  await new Engine(h).refresh();
  assert.deepEqual(h.store.releases.a.map((r) => r.installs), [40, 25]);
  assert.deepEqual(Object.values(h.store.installs.a), [65]);
  assert.equal(h.store.installs.b, undefined, "competitors' installs are not kept");
});

test("installs: pace against the record nearest a week before, and the gain since a day", () => {
  const s = emptyStore();
  s.installs.a = { "2026-10-01": 100, "2026-10-08": 170, "2026-10-14": 220, "2026-10-15": 230 };
  s.installs.b = { "2026-10-08": 10, "2026-10-15": 24 };
  const m = new Model(s);
  assert.deepEqual(m.installs(["a"]), { date: "2026-10-15", total: 230, prev: 170, span: 7, pace: 60 / 7 });
  assert.deepEqual(m.installs(["a", "b"]), { date: "2026-10-15", total: 254, prev: 180, span: 7, pace: 74 / 7 });
  assert.deepEqual(m.installsSince("a", "2026-10-14"), { from: "2026-10-14", to: "2026-10-15", gain: 10 });
  assert.equal(m.installsSince("a", "2026-09-30"), null);
  assert.equal(m.installs(["none"]), null);
});

test("prune and import keep installs and the delisted mark with their plugins", () => {
  const s = emptyStore();
  s.installs = { a: { "2026-10-15": 5 }, gone: { "2026-10-15": 1 } };
  s.delisted = { a: { since: "2026-10-15", last: 3 }, gone: { since: "2026-10-15", last: 1 } };
  prune(s, new Set(["a"]));
  assert.deepEqual(Object.keys(s.installs), ["a"]);
  assert.deepEqual(Object.keys(s.delisted), ["a"]);
  const t2 = emptyStore();
  importInto(t2, { snapshots: { "2026-10-15": { a: { downloads: 3 } } }, installs: { "2026-10-15": { a: { total: 7, versions: {} } } } }, new Set(["a"]));
  assert.deepEqual(t2.installs, { a: { "2026-10-15": 7 } });
});

// ---------- 1.2: days, missed days, late-followed plugins, the publish schedule ----------
test("a reading in the file of day D is dated D − 1, the day the downloads happened", () => {
  const s = emptyStore();
  setPoint(s, "a", "2026-10-07", 100); // file published Wednesday 00:25 UTC
  setPoint(s, "a", "2026-10-08", 130); // Thursday's file: Wednesday's downloads
  const ser = new Model(s).series("a");
  assert.deepEqual(ser.map((p) => p.date), ["2026-10-06", "2026-10-07"]);
  assert.equal(ser[1].daily, 30);
  assert.equal(new Model(s).analyze(ser)?.lastDate, "2026-10-07");
});

test("weekday averages use the day of the downloads", () => {
  const s = emptyStore();
  // 28 files; the ones published on Thursdays carry 100, the rest 10 — so Wednesdays are busiest.
  let total = 0;
  for (let i = 0; i < 28; i++) {
    const file = addDays("2026-09-07", i); // a Monday
    total += new Date(file + "T00:00:00Z").getUTCDay() === 4 ? 100 : 10;
    setPoint(s, "a", file, total);
  }
  const A = new Model(s).analyze(new Model(s).series("a"));
  assert.ok(A);
  const best = A.weekday.reduce((b, x) => (x.avg ?? 0) > (b.avg ?? 0) ? x : b);
  assert.equal(best.i, 2, "Wednesday (Monday = 0)");
});

test("a reading after missed days counts in sums but not in daily averages or records", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 10, 0, 10); // 10 a day
  setPoint(s, "a", "2026-09-14", 90 + 40); // four days in one reading
  const A = new Model(s).analyze(new Model(s).series("a"));
  assert.ok(A);
  assert.equal(A.last?.gap, true);
  assert.equal(A.pace, 10);
  assert.equal(A.ratio, null);
  assert.equal(A.lastRank, null);
  assert.equal(A.best?.daily, 10);
});

test("totalSeries: a big plugin followed later without its past does not count as one day's downloads", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 10, 100, 10);
  linear(s, "big", "2026-09-06", 5, 10000, 30);
  const tot = new Model(s).totalSeries(["a", "big"]);
  const day = tot.find((x) => x.parts.big.total === 10000);
  assert.ok(day);
  assert.equal(day.parts.big.daily, 0);
  assert.equal(day.daily, 10);
  assert.ok(Math.max(...tot.map((x) => x.daily ?? 0)) < 100);
});

test("release effect compares the three days before a release with the three from its day on", () => {
  const s = emptyStore();
  const daily = [5, 5, 5, 20, 20, 20]; // downloads on Oct 2..7
  let total = 0;
  daily.forEach((v, i) => { total += v; setPoint(s, "a", addDays("2026-10-03", i), total); });
  setPoint(s, "a", "2026-10-02", 0);
  s.releases.a = [{ version: "1.1.0", date: "2026-10-05T08:00:00Z" }];
  const m = new Model(s);
  const [imp] = m.releaseImpact("a", m.series("a"));
  assert.deepEqual(imp, { version: "1.1.0", date: "2026-10-05", before: 5, after: 20 });
});

test("schedule: the next look is just after tomorrow's file, or in 30 minutes while it is late", () => {
  const h = host({ mine: ["a"] });
  const e = new Engine(h);
  const now = Date.parse("2026-10-08T03:00:00Z");
  assert.equal(new Date(e.nextPublish(now)).toISOString(), "2026-10-09T00:25:00.000Z", "nothing read yet: the usual time");
  h.store.publishedAt = Date.parse("2026-10-08T00:27:00Z");
  assert.equal(new Date(e.nextCheck(now)).toISOString(), "2026-10-09T00:42:00.000Z");
  const late = Date.parse("2026-10-09T01:00:00Z");
  assert.equal(e.nextCheck(late), late + 30 * 60e3);
  h.store.publishedAt = Date.parse("2026-10-01T00:27:00Z"); // an old reading: expect the usual time
  assert.equal(new Date(e.nextPublish(now)).toISOString(), "2026-10-09T00:25:00.000Z");
});

test("engine: remembers when the newest file was published", async () => {
  const h = host({ mine: ["a"], useArchive: false, catchUp: false, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-10", sha: "s1", stats: { a: { downloads: 9 } } }]);
  await new Engine(h).refresh();
  assert.equal(h.store.publishedAt, Date.parse("2026-09-10T01:00:00Z"));
});

test("engine: a day that failed to download is tried again", async () => {
  const h = host({ mine: ["a"], useArchive: false, catchUp: true, meta: { a: { id: "a", name: "A", author: "", repo: "", description: "" } } });
  network([{ date: "2026-09-10", sha: "s1", stats: { a: { downloads: 10 } } }]);
  const e = new Engine(h);
  await e.refresh();
  const days = [
    { date: "2026-09-10", sha: "s1", stats: { a: { downloads: 10 } } },
    { date: "2026-09-11", sha: "s2", stats: { a: { downloads: 15 } } },
    { date: "2026-09-12", sha: "s3", stats: { a: { downloads: 22 } } },
  ];
  network(days);
  const routes = (globalThis as any).__routes, raw = routes[RAW];
  routes[RAW] = (url: string) => url.includes("/s2/") ? { status: 500 } : raw(url);
  await e.refresh();
  assert.equal(getPoint(h.store, "a", "2026-09-11"), null);
  routes[RAW] = raw;
  await e.refresh();
  assert.equal(getPoint(h.store, "a", "2026-09-11")?.downloads, 15);
});

// ---------- 1.3: momentum ----------
/** One reading per file day; `daily[i]` downloads happen on file day i (the first value is the opening total). */
function byDay(s: Store, id: string, start: string, daily: number[], from = 100) {
  let total = from;
  daily.forEach((v, i) => { total += v; setPoint(s, id, addDays(start, i), total); });
}

test("momentum compares the last 7 calendar days with the 7 before", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-09-01", [...Array(7).fill(0), ...Array(7).fill(4), ...Array(7).fill(6)]);
  const mo = new Model(s).analyze(new Model(s).series("a"))?.mo;
  assert.ok(mo);
  assert.equal(mo.recent, 42);
  assert.equal(mo.before, 28);
  assert.equal(mo.small, true, "28 < 30 a week: a count, not a percentage");
  assert.equal(Math.round((mo.ratio as number) * 100), 50);
  assert.equal(mo.estimated, false);
});

test("momentum spreads a missed day on a window edge evenly and says so", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-09-01", Array(21).fill(10));
  s.series.a.d[s.series.a.d.length - 8] = null; // the reading exactly on the edge between the two weeks
  const mo = new Model(s).analyze(new Model(s).series("a"))?.mo;
  assert.ok(mo);
  assert.equal(mo.recent, 70);
  assert.equal(mo.before, 70);
  assert.equal(mo.estimated, true);
  assert.equal(mo.ratio, 0);
});

test("momentum needs two full weeks; the 7-day sum still shows with one", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-09-01", Array(10).fill(5));
  const A = new Model(s).analyze(new Model(s).series("a"));
  assert.ok(A);
  assert.equal(A.mo?.before, null);
  assert.equal(A.sum7, 35);
});

test("small numbers are flagged as counts and shrunk toward 0 for sorting", () => {
  const s = emptyStore();
  byDay(s, "tiny", "2026-09-01", [0, ...Array(7).fill(1), ...Array(7).fill(3)]);
  byDay(s, "few", "2026-09-01", [0, ...Array(7).fill(5), ...Array(7).fill(10)]);
  byDay(s, "big", "2026-09-01", [0, ...Array(7).fill(60), ...Array(7).fill(78)]);
  const m = new Model(s);
  const [tiny, few, big] = ["tiny", "few", "big"].map((id) => m.analyze(m.series(id))?.mo);
  assert.ok(tiny && few && big);
  assert.equal(tiny.small, true, "7 the week before: shown as a count");
  assert.ok(!few.small && !big.small);
  assert.ok(tiny.score < (tiny.ratio as number) / 4, "200% shrinks well below");
  assert.ok((few.ratio as number) > (big.ratio as number) && few.score > big.score * 0.9, "35 → 70 still reads as strong");
});

test("a plugin joining a sum without its past adds nothing to the sum's momentum or 30 days", () => {
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 30, 100, 10);
  linear(s, "big", "2026-09-25", 6, 10000, 30);
  const m = new Model(s), tot = m.totalSeries(["a", "big"]), A = m.analyzeTotal(tot);
  assert.ok(A?.mo);
  assert.ok(A.mo.recent < 1000, `recent ${A.mo.recent}`);
  assert.ok((m.gainOver(A.full, 30) ?? 0) < 1000);
});

test("weekRun counts weeks in a row going the same way", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-08-01", [0, ...[10, 10, 20, 30, 40].flatMap((w) => Array(7).fill(w / 7))]);
  const A = new Model(s).analyze(new Model(s).series("a"));
  assert.ok(A);
  assert.deepEqual(A.weeks, [10, 10, 20, 30, 40]);
  assert.equal(A.run, 3);
});

test("cadence counts the quiet time since the last release", () => {
  const s = emptyStore();
  const today = new Date().toISOString().slice(0, 10);
  s.releases.a = [0, 2, 4].map((n, i) => ({ version: `1.0.${i}`, date: addDays(today, -90 + n) + "T00:00:00Z" }));
  assert.equal(new Model(s).cadence("a"), 30, "three releases in a burst 90 days ago: every 30 days, not every 2");
});

// ---------- 1.4: interface languages ----------
const dicts = (): Record<Lang, Dict> => {
  const out = {} as Record<Lang, Dict>;
  for (const l of ["en", "ko", "zh"] as const) { setLanguage(l); out[l] = t(); }
  setLanguage("en");
  return out;
};

test("every language has every English key, in the same shape", () => {
  const all = dicts(), en = all.en as Record<string, unknown>;
  for (const l of ["ko", "zh"] as const) {
    const d = all[l] as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).filter((k) => !(k in en)), [], `${l} has keys English doesn't`);
    for (const [k, v] of Object.entries(en)) {
      assert.ok(k in d, `${l} is missing ${k}`);
      assert.equal(typeof d[k], typeof v, `${l}.${k} is a ${typeof d[k]}, not a ${typeof v}`);
      if (typeof v === "function") assert.equal((d[k] as () => unknown).length, v.length, `${l}.${k} takes ${v.length} arguments`);
      if (Array.isArray(v)) assert.equal((d[k] as unknown[]).length, v.length, `${l}.${k} has ${v.length} items`);
      if (k === "ranges") assert.deepEqual(Object.keys(d[k] as object).sort(), Object.keys(v as object).sort());
    }
  }
});

/** Every text a dictionary entry can give: strings as they are, functions called with sample arguments. */
const rendered = (v: unknown): unknown[] => {
  const out = typeof v === "function" ? (v as (...a: string[]) => unknown)(...Array<string>(v.length).fill("3")) : v;
  return Array.isArray(out) ? out : typeof out === "object" && out ? Object.values(out) : [out];
};

test("every string renders, with balanced **bold** markup", () => {
  for (const [l, d] of Object.entries(dicts())) {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      for (const s of rendered(v)) {
        assert.equal(typeof s, "string", `${l}.${k}`);
        assert.ok(!(s as string).includes("undefined"), `${l}.${k}: ${s as string}`);
        assert.equal(((s as string).match(/\*\*/g) ?? []).length % 2, 0, `${l}.${k} has unbalanced **: ${s as string}`);
      }
    }
  }
});

test("the Chinese interface is translated, not English or Korean left over", () => {
  const { en, zh } = dicts();
  const same = Object.keys(en).filter((k) => typeof (en as any)[k] === "string" && (en as any)[k] === (zh as any)[k]);
  assert.deepEqual(same, ["appName", "glanceTitle"]);
  const hangul = Object.entries(zh).filter(([, v]) => rendered(v).some((s) => /[\uac00-\ud7af]/.test(String(s)))).map(([k]) => k);
  assert.deepEqual(hangul, []);
  assert.equal(zh.longDate(10, 6), "10月6日");
  assert.equal(zh.weekdayLong(zh.weekdays[0]), "星期一");
});

test("auto follows Obsidian's language, and an unknown setting falls back to it", () => {
  assert.equal(resolveLanguage("auto", "zh"), "zh");
  assert.equal(resolveLanguage("auto", "zh-TW"), "zh");
  assert.equal(resolveLanguage("auto", "ko"), "ko");
  assert.equal(resolveLanguage("auto", "fr"), "en");
  assert.equal(resolveLanguage("auto", ""), "en");
  assert.equal(resolveLanguage("zh", "ko"), "zh");
  assert.equal(resolveLanguage("en", "zh"), "en");
  assert.equal(resolveLanguage("ja", "zh-TW"), "zh");
  assert.equal(resolveLanguage("constructor", "en"), "en");
  setLanguage("zh");
  assert.equal(lang(), "zh");
  assert.equal(loc(), "zh-CN");
  setLanguage("en");
  assert.equal(loc(), "en-US");
  assert.deepEqual([...LANGUAGES], ["auto", "en", "ko", "zh"]);
  assert.ok(LANGUAGES.includes(DEFAULT_SETTINGS.language));
});

// ---------- 1.6: bots, forecast range, ladder, records, months, report ----------
test("version days keep counts by version and forget the oldest past 400 days", () => {
  const s = emptyStore();
  for (let i = 0; i < 405; i++) logVersionDay(s, "a", addDays("2025-01-01", i), { "1.0.0": i, ...(i > 400 ? { "1.1.0": 1 } : {}) });
  const days = Object.keys(s.vdays.a.d).sort();
  assert.equal(days.length, 400);
  assert.equal(days[0], addDays("2025-01-01", 5));
  assert.deepEqual(versionDay(s.vdays.a, days[399]), { "1.0.0": 404, "1.1.0": 1 });
  assert.deepEqual(versionDay(s.vdays.a, days[0]), { "1.0.0": 5 });
  assert.equal(versionDay(s.vdays.a, "2020-01-01"), null);
  prune(s, new Set());
  assert.equal(s.vdays.a, undefined);
});

test("the dashboard's history.json brings version days with it", () => {
  const s = emptyStore();
  importInto(s, { snapshots: {
    "2026-08-14": { x: { downloads: 7, versions: { "1.0.0": 7 } } },
    "2026-08-15": { x: { downloads: 12, versions: { "1.0.0": 7, "1.1.0": 5 } } },
  } }, new Set(["x"]));
  assert.deepEqual(versionDay(s.vdays.x, "2026-08-15"), { "1.0.0": 7, "1.1.0": 5 });
});

/** Four file days of a plugin with four versions: bots add 5 to each, people add to the newest. */
function botDays(s: Store) {
  const days = [[100, 100, 100, 100], [105, 105, 105, 135], [110, 110, 110, 165], [110, 110, 110, 175]];
  days.forEach((c, i) => {
    const raw: Record<string, number> = { downloads: c.reduce((a, b) => a + b, 0) };
    c.forEach((n, k) => { raw[`1.${k}.0`] = n; });
    recordDay(s, { a: raw }, addDays("2026-09-01", i), ["a"], new Set(["a"]));
  });
}

test("bots: equal growth across older versions is taken out, the rest is people", () => {
  const s = emptyStore();
  botDays(s);
  const m = new Model(s, "official", ["a"]), sp = m.split("a");
  assert.deepEqual(sp.get("2026-09-01"), { official: 50, bot: 20, human: 30, span: 1 });
  assert.deepEqual(sp.get("2026-09-02"), { official: 45, bot: 20, human: 25, span: 1 });
  // Fewer than three older versions grew: no bots that day.
  assert.deepEqual(sp.get("2026-09-03"), { official: 10, bot: 0, human: 10, span: 1 });
  assert.equal(m.canSplit(["a"]), true);
});

test("bots: the human series adds up the human days and leaves others official", () => {
  const s = emptyStore();
  botDays(s);
  setPoint(s, "b", "2026-09-01", 10); setPoint(s, "b", "2026-09-04", 40);
  const off = new Model(s, "official", ["a"]), hum = off.withBasis("human");
  assert.deepEqual(off.series("a").map((p) => p.total), [400, 450, 495, 505]);
  assert.deepEqual(hum.series("a").map((p) => p.total), [400, 430, 455, 465]);
  assert.deepEqual(hum.series("a").map((p) => p.daily), [null, 30, 25, 10]);
  assert.deepEqual(hum.series("b"), off.series("b"));
  assert.equal(new Model(s, "official", ["b"]).canSplit(["b"]), false);
});

test("forecast: the range holds the expected total and widens with time", () => {
  const dailies = Array.from({ length: 60 }, (_, i) => 20 + ((i * 7) % 11) - 5);
  const f = forecast(1000, dailies, 60, { 7: [], 14: [] });
  for (let h = 0; h < 60; h++) assert.ok(f.lo[h] <= f.mid[h] && f.mid[h] <= f.hi[h], `day ${h + 1}`);
  assert.equal(Math.round(f.mid[6]), Math.round(1000 + 7 * f.pace));
  assert.ok(f.hi[59] - f.lo[59] > f.hi[6] - f.lo[6]);
  assert.ok(f.cal.own && f.cal.n > 0);
  const eta = etaRange(1000, 2000, dailies, { 7: [], 14: [] });
  assert.ok(eta && eta.hi != null && eta.lo <= Math.ceil(1000 / f.pace) && Math.ceil(1000 / f.pace) <= eta.hi);
});

test("gainOver counts a plugin listed inside the window from zero", () => {
  const s = emptyStore();
  byDay(s, "b", "2026-09-20", [0, 10, 10, 10, 10, 10], 30);
  const m = new Model(s);
  assert.equal(m.gainOver(m.series("b"), 30), 80);
});

test("ladder: neighbours a few steps above and the one below, and when each is passed", () => {
  const s = emptyStore();
  for (const [day, mineUp, otherUp] of [["2026-09-01", 0, 0], ["2026-09-02", 20, 5]] as const) {
    const stats: Record<string, { downloads: number }> = {};
    for (let i = 0; i < 20; i++) stats["p" + i] = { downloads: 2000 - 100 * i + (i === 15 ? mineUp : otherUp) };
    recordDay(s, stats, day, ["p15"], new Set(["p15"]));
  }
  assert.deepEqual(s.near[1].s.p15, [null, null, null, null, null, "p5", "p14", "p16"]);
  const rows = new Model(s, "official", ["p15"]).ladder("p15", 20);
  assert.ok(rows);
  const one = rows.find((r) => r.step === 1), below = rows.find((r) => r.step === "below");
  assert.deepEqual(one && { id: one.id, gap: one.gap, pace: one.pace, days: one.days }, { id: "p14", gap: 85, pace: 5, days: 6 });
  assert.deepEqual(below && { id: below.id, gap: below.gap, days: below.days }, { id: "p16", gap: -115, days: null });
  assert.equal(rows.find((r) => r.step === 10)?.id, "p5");
});

test("records: best day and week, and how long the first milestone took", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-09-01", [0, 10, 10, 10, 10, 10, 10, 40, 10, 10, 10, 10, 10, 10, 10], 0);
  const m = new Model(s), A = m.analyze(m.series("a"));
  assert.ok(A);
  const r = new Map(m.records(A).map((x) => [x.k, x]));
  assert.equal(r.get("bestDay")?.value, 40);
  assert.equal(r.get("best7")?.value, 100);
  assert.equal(r.get("firstTo")?.extra.m, 100);
});

test("months: sums by calendar month, projects the current one at the week's pace", () => {
  const s = emptyStore();
  byDay(s, "a", "2026-09-20", Array(20).fill(10), 100);
  const m = new Model(s), ser = m.series("a"), A = m.analyze(ser);
  assert.ok(A);
  const rows = m.months(ser, A);
  assert.deepEqual(rows.map((x) => [x.key, x.sum, x.from, x.to]), [["2026-09", 110, 20, 30], ["2026-10", 80, 1, 8]]);
  assert.equal(rows[1].current, true);
  assert.equal(rows[1].left, 23);
  assert.equal(rows[1].proj, 230);
});

test("weekly report: overview, a table by plugin, and what's coming", () => {
  setLanguage("en");
  const s = emptyStore();
  linear(s, "a", "2026-09-01", 30, 100, 10);
  linear(s, "b", "2026-09-01", 30, 400, 3);
  s.releases.a = [{ version: "1.2.0", date: "2026-09-28T10:00:00Z" }] as any;
  const r = weeklyReport(s, { ...DEFAULT_SETTINGS, mine: ["a", "b"] });
  assert.ok(r);
  assert.equal(r.date, "2026-09-29");
  assert.ok(r.text.startsWith("# "));
  assert.match(r.text, /\| a \| 390 \|/);
  assert.match(r.text, /v1\.2\.0/);
  assert.equal(weeklyReport(s, { ...DEFAULT_SETTINGS, mine: [] }), null);
});

// ---------- optional: the real dashboard history on this machine ----------
const real = process.env.DASHBOARD_HISTORY;
if (real && existsSync(real)) {
  test("imports the real dashboard history", () => {
    const data = JSON.parse(readFileSync(real, "utf8"));
    const s = emptyStore();
    const n = importInto(s, data, new Set(Object.keys(Object.values(data.snapshots).at(-1) as object)));
    assert.ok(n > 10);
    const m = new Model(s);
    for (const date of Object.keys(data.snapshots)) {
      for (const [id, p] of Object.entries<any>(data.snapshots[date])) {
        assert.equal(getPoint(s, id, date)?.downloads, p.downloads, `${id} ${date}`);
      }
    }
    console.log("    readings:", n, "· plugins:", Object.keys(s.series).join(", "), "· latest:", Object.keys(s.series).map((id) => `${id} ${m.latest(id)?.downloads}`).join(", "));
  });
}

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n", e); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
