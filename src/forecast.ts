const mean = (a: number[]): number => a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0;

/*
 * Forecasts. The middle line keeps the last 7 days' average going. The range comes from how far such forecasts
 * missed before: on each past day, "the last 7 days' average goes on" is checked against what came 7 and 14 days
 * later, and the ratio actual / forecast is kept. The spread of those ratios around their median (the lowest and
 * highest tenth) is laid around the current pace.
 *
 * Only the spread is used, not the lean. Early on a plugin keeps speeding up and forecasts land at half the actual,
 * but that wears off: carried forward, the lean lifts the whole range above the middle line and keeps promising a
 * launch-month pace months later. Only the recent checks count, for the same reason.
 */

/** How many recent checks the range is built from (about three weeks of daily checks). */
export const RECENT_CHECKS = 21;

/** log(actual / forecast) for 7 and 14 days ahead, oldest first then sorted, from the most recent checks. */
export function backtest(dailies: number[]): { 7: number[]; 14: number[] } {
  const out: { 7: number[]; 14: number[] } = { 7: [], 14: [] };
  for (const hb of [7, 14] as const) {
    for (let i = 13; i + hb < dailies.length; i++) {
      const pace = mean(dailies.slice(i - 6, i + 1)), got = dailies.slice(i + 1, i + 1 + hb).reduce((n, x) => n + x, 0);
      if (pace > 0 && got > 0) out[hb].push(Math.log(got / (pace * hb)));
    }
    out[hb] = out[hb].slice(-RECENT_CHECKS).sort((x, y) => x - y);
  }
  return out;
}

const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];

export interface Calibration {
  /** Multipliers [low, high] for the growth h days ahead. */
  at(h: number): [number, number];
  /** Checks behind the 7-day range, how many came out above the forecast, and their median ratio. */
  n: number; above: number; median: number | null;
  /** False when the plugin's own history was too short and the range was borrowed from all of yours. */
  own: boolean;
}

/**
 * The range of the growth `h` days ahead, as multipliers of "the pace goes on". From the plugin's own checks when it
 * has five or more, else from `pool` (all your plugins' checks). With none, a wide default.
 * Past 14 days the spread widens a little more, at most 1.25× the 14-day one.
 */
export function calibrate(dailies: number[], pool: { 7: number[]; 14: number[] }): Calibration {
  const own = backtest(dailies);
  const pick = (hb: 7 | 14) => own[hb].length >= 5 ? { r: own[hb], own: true } : pool[hb].length >= 8 ? { r: pool[hb], own: false } : null;
  const c7 = pick(7), c14 = pick(14);
  const at = (h: number): [number, number] => {
    const c = h <= 7 ? c7 ?? c14 : c14 ?? c7, hb = c === c7 ? 7 : 14;
    if (!c) { const u = 0.25 * Math.sqrt(h / 7); return [Math.exp(-u), Math.exp(u)]; }
    const med = q(c.r, 0.5), f = h <= hb ? Math.sqrt(h / hb) : Math.min(1.25, Math.sqrt(h / hb));
    return [Math.exp((q(c.r, 0.1) - med) * f), Math.exp((q(c.r, 0.9) - med) * f)];
  };
  const r7 = c7?.r ?? [];
  return { at, n: r7.length, above: r7.filter((x) => x > 0).length, median: r7.length ? Math.exp(q(r7, 0.5)) : null, own: !!c7?.own };
}

export interface Forecast { pace: number; mid: number[]; lo: number[]; hi: number[]; cal: Calibration }

/** Totals 1…H days ahead: the middle line and its range. The range always holds the middle line. */
export function forecast(lastTotal: number, dailies: number[], H: number, pool: { 7: number[]; 14: number[] }): Forecast {
  const pace = mean(dailies.slice(-7)), cal = calibrate(dailies, pool);
  const mid: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let h = 1; h <= H; h++) {
    const [a, b] = cal.at(h), g = pace * h;
    mid.push(Math.round(lastTotal + g));
    lo.push(Math.round(lastTotal + Math.min(g, g * a)));
    hi.push(Math.round(lastTotal + Math.max(g, g * b)));
  }
  return { pace, mid, lo, hi, cal };
}

/** Days until `target`: soonest at the high edge, latest at the low edge. Null when it isn't reached within two years. */
export function etaRange(total: number, target: number, dailies: number[], pool: { 7: number[]; 14: number[] }): { lo: number; hi: number | null } | null {
  if (!target || target <= total) return null;
  const pace = mean(dailies.slice(-7));
  if (!(pace > 0)) return null;
  const cal = calibrate(dailies, pool);
  let lo: number | null = null, hi: number | null = null;
  for (let h = 1; h <= 730 && hi == null; h++) {
    const [a, b] = cal.at(h), g = pace * h;
    if (lo == null && total + Math.max(g, g * b) >= target) lo = h;
    if (total + Math.min(g, g * a) >= target) hi = h;
  }
  return lo == null ? null : { lo, hi };
}

/** Steady days only: a reading after missed days holds several days and would read as a spike. */
export const steadyDailies = (full: { daily: number | null; gap: boolean }[]): number[] =>
  full.filter((p) => p.daily != null && !p.gap).map((p) => p.daily as number);
