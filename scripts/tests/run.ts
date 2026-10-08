/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { emptyStore, DEFAULT_SETTINGS, type Settings, type Store } from "../../src/types";
import { setPoint, fillPoint, getPoint, logVersions, rankOf, recordDay, importInto, prune, addDays } from "../../src/data/store";
import { Model, similarPlugins } from "../../src/analysis";
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
