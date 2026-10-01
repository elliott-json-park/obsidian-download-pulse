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
