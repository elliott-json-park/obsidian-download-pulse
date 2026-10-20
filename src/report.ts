import { Model, semverCmp, type Analysis } from "./analysis";
import { addDays, dayDiff } from "./data/store";
import { t } from "./i18n";
import type { Settings, Store } from "./types";
import { fmt, fmt1, signed, shortDate, longDate } from "./ui/util";

/** "▲ 12%" / "▼ 3%" / "±0%" in plain text, for a note. */
const pct = (ratio: number | null | undefined): string => {
  if (ratio == null || !isFinite(ratio)) return "–";
  const p = Math.round(Math.abs(ratio) * 100);
  return p ? `${ratio > 0 ? "▲" : "▼"} ${p}%` : "±0%";
};

/**
 * The week in a Markdown note: the overview, a table by plugin, this week's releases and what's coming. Official
 * numbers, with the bots-excluded ones and installs beside them when they are known. Returns null without data.
 */
export function weeklyReport(store: Store, settings: Settings): { date: string; text: string } | null {
  const mine = settings.mine;
  if (!mine.length) return null;
  const m = new Model(store, "official", mine);
  const one = mine.length === 1;
  const total = one ? null : m.totalSeries(mine);
  const full = total ?? m.series(mine[0]);
  const A: Analysis | null = total ? m.analyzeTotal(total) : m.analyze(m.series(mine[0]));
  if (!A) return null;
  const nameOf = (id: string) => settings.meta[id]?.name ?? id;
  const human = m.canSplit(mine) ? m.withBasis("human") : null;
  const H = human ? (one ? human.analyze(human.series(mine[0])) : human.analyzeTotal(human.totalSeries(mine))) : null;
  const inst = m.installs(mine);
  const last = A.lastDate, from = addDays(last, -6);
  const L: string[] = [];
  L.push(`# ${t().rpTitle(last)}`, "");
  L.push(`> ${t().rpBasis(longDate(last), shortDate(from), shortDate(last), shortDate(addDays(last, -13)), shortDate(addDays(last, -7)))}`, "");

  L.push(`## ${t().rpGlance}`, "");
  L.push(`- ${t().rpTotal(fmt(A.total))}` + (H ? ` · ${t().rpHuman(fmt(H.total))}` : "") + (inst ? ` · ${t().rpInstalls(fmt(inst.total))}` : ""));
  L.push(`- ${t().rp7(signed(A.sum7), pct(A.mo?.ratio), fmt1(A.pace))}` + (H ? ` · ${t().rpH7(signed(H.sum7), pct(H.mo?.ratio))}` : ""));
  const months = m.months(full, A), cur = months[months.length - 1];
  if (cur?.current) {
    const prev = months[months.length - 2], day = +last.slice(8, 10);
    const same = prev ? [...prev.byDay].filter(([d]) => d <= day).reduce((n, [, x]) => n + x, 0) : null;
    L.push(`- ${t().rpMonth(t().monthName(+cur.key.slice(5, 7)), day, signed(cur.sum))}` + (same ? ` (${t().rpMonthPrev(signed(same))})` : "") + (cur.proj ? ` · ${t().rpMonthProj(fmt(cur.sum + cur.proj))}` : ""));
  }
  if (A.next) {
    const r = m.eta(A);
    const when = r ? (r.hi != null && r.hi !== r.lo ? t().between(longDate(addDays(last, r.lo)), longDate(addDays(last, r.hi))) : longDate(addDays(last, r.lo))) : A.etaDate ? t().around(longDate(A.etaDate)) : "–";
    L.push(`- ${t().rpNext(fmt(A.next), when)}`);
  }
  if (A.best) L.push(`- ${t().rpBest(signed(A.best.daily), longDate(A.best.date))}`);

  if (!one) {
    L.push("", `## ${t().rpByPlugin}`, "");
    const head = t().rpHead(!!human);
    L.push(`| ${head.join(" | ")} |`, `|${head.map((_, i) => i === 0 || i === head.length - 1 ? "---" : "---:").join("|")}|`);
    const rows = mine.map((id) => ({ id, a: m.analyze(m.series(id)), h: human?.analyze(human.series(id)) ?? null, st: m.standing(id), gone: m.delisted(id) }))
      .filter((r): r is typeof r & { a: Analysis } => !!r.a).sort((x, y) => y.a.sum7 - x.a.sum7);
    for (const r of rows) {
      const climb = r.st?.climbed7;
      const rank = r.st ? `#${fmt(r.st.rank)}` + (climb && climb > 0 ? ` (▲${fmt(climb)})` : climb && climb < 0 ? ` (▼${fmt(-climb)})` : "") : "–";
      const cells = [nameOf(r.id), fmt(r.a.total), r.gone ? t().rpStopped : signed(r.a.sum7), r.gone ? "–" : pct(r.a.mo?.ratio),
        ...(human ? [r.h ? signed(r.h.sum7) : "–"] : []), rank, r.a.next ? `${fmt(r.a.next)}${r.a.etaDate && !r.gone ? ` · ${shortDate(r.a.etaDate)}` : ""}` : "–"];
      L.push(`| ${cells.join(" | ")} |`);
    }
  }

  // This week's releases: one line per plugin and day, versions listed.
  L.push("", `## ${t().rpWeek}`, "");
  const rel: { date: string; id: string; vs: string[] }[] = [];
  for (const id of mine) for (const r of store.releases[id] ?? []) {
    const d = r.date.slice(0, 10);
    if (d < from || d > addDays(last, 1)) continue;
    const row = rel.find((x) => x.date === d && x.id === id);
    if (row) row.vs.push(r.version); else rel.push({ date: d, id, vs: [r.version] });
  }
  rel.sort((a, b) => b.date.localeCompare(a.date));
  if (rel.length) for (const r of rel) L.push(`- ${shortDate(r.date)} · ${t().rpReleased(nameOf(r.id), r.vs.sort(semverCmp).map((v) => "v" + v).join(" · "))}`);
  else L.push(`- ${t().rpNone}`);

  // Coming up: milestones within 30 days at the current pace.
  const soon = mine.map((id) => ({ id, a: m.analyze(m.series(id)) })).filter((x) => x.a?.next && x.a.etaDate && dayDiff(last, x.a.etaDate) <= 30 && !m.delisted(x.id))
    .map((x) => ({ date: (x.a as Analysis).etaDate as string, text: t().rpSoonItem(nameOf(x.id), fmt((x.a as Analysis).next)) }));
  if (!one && A.next && A.etaDate && dayDiff(last, A.etaDate) <= 30) soon.push({ date: A.etaDate, text: t().rpSoonItem(t().allPlugins, fmt(A.next)) });
  if (soon.length) {
    L.push("", `## ${t().rpSoon}`, "");
    for (const e of soon.sort((a, b) => a.date.localeCompare(b.date))) L.push(`- ${shortDate(e.date)} · ${e.text}`);
  }
  L.push("", `_${t().rpFooter}_`, "");
  return { date: last, text: L.join("\n") };
}
