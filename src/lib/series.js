// Turn the raw daily-state rows into the LP-vs-HODL comparison.
//
// LP leg   : value_per_share(t) = (res0·p0 + res1·p1) / totalSupply(t) — nets
//            fees, impermanent loss and the LVR cost of auto-ranging (all
//            embedded in the pool's true reserves).
// HODL leg : the deposited basket. At entry t0, composition per share is
//            (res0/bpt, res1/bpt); held forward and marked with the same prices.
// Both legs are indexed to 100 at the window's entry day, so the gap between
// them is the LP's fee-minus-LVR result over that window.

const DAY_MS = 86400000
const toMs = (day) => new Date(day + 'T00:00:00Z').getTime()
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS)

// A trailing run of ≥ this many days without trading means the pool is
// suspended or dormant. The run start is kept as the series endpoint; the
// tail after it carries no fee/LVR information (during a no-swap stretch the
// LP tracks its own basket exactly, so the gap is frozen by construction).
//
// "No trading" is detected on per-share composition: proportional add/remove
// (the only liquidity ops reCLAMM allows, incl. the post-suspension exits)
// leaves res/bpt unchanged, while any swap shifts it. This matters: after the
// Feb-2026 suspension, stragglers kept exiting proportionally for months — an
// identical-state test would keep that paused coda alive.
const DORMANT_RUN_DAYS = 10
const TRADE_EPS = 1e-6

function tradedBetween(a, b) {
  const d0 = Math.abs(b.res0 / b.bpt - a.res0 / a.bpt) / (Math.abs(a.res0 / a.bpt) || 1)
  const d1 = Math.abs(b.res1 / b.bpt - a.res1 / a.bpt) / (Math.abs(a.res1 / a.bpt) || 1)
  return d0 > TRADE_EPS || d1 > TRADE_EPS
}

/** Parse, sort, dedupe, and trim the trailing no-activity tail. */
export function normalizeSeries(rows) {
  const pts = (rows || [])
    .map((r) => ({
      day: String(r.day).slice(0, 10),
      sym0: r.sym0,
      sym1: r.sym1,
      res0: +r.res0,
      res1: +r.res1,
      bpt: +r.bpt,
      price0: +r.price0,
      price1: +r.price1,
      tvl: +r.tvl_usd,
    }))
    .filter((p) => p.bpt > 0 && isFinite(p.tvl) && isFinite(p.price0) && isFinite(p.price1))

  pts.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const byDay = new Map()
  for (const p of pts) byDay.set(p.day, p) // last write per day wins
  const arr = [...byDay.values()]

  // Trim the dormant tail: walk back while no trading happened vs the
  // previous day; if that run is long enough, end the series where the last
  // swap activity was.
  let runStart = arr.length - 1
  while (runStart > 0 && !tradedBetween(arr[runStart - 1], arr[runStart])) runStart--
  if (arr.length - runStart >= DORMANT_RUN_DAYS) return arr.slice(0, runStart + 1)
  return arr
}

/** Largest window (in days) the cleaned series can actually support. */
export function maxWindowDays(series) {
  if (series.length < 2) return 0
  return daysBetween(series[0].day, series[series.length - 1].day)
}

/** Is the pool still trading (last kept data point within ~4 days of now)? */
export function isLive(series, nowMs = Date.now()) {
  if (!series.length) return false
  return nowMs - toMs(series[series.length - 1].day) <= 4 * DAY_MS
}

/**
 * Build the indexed LP-vs-HODL series for a trailing window.
 * windowDays = null → full available life.
 */
export function computeWindow(series, windowDays) {
  if (!series || series.length < 2) return null
  const end = series[series.length - 1]

  let startIdx = 0
  if (windowDays != null) {
    const startMs = toMs(end.day) - windowDays * DAY_MS
    const i = series.findIndex((p) => toMs(p.day) >= startMs)
    startIdx = i < 0 ? 0 : i
  }

  const slice = series.slice(startIdx)
  const t0 = slice[0]
  const comp0 = t0.res0 / t0.bpt
  const comp1 = t0.res1 / t0.bpt
  const vps0 = t0.tvl / t0.bpt // LP and HODL coincide at entry

  const pts = slice.map((p) => {
    const lpVps = p.tvl / p.bpt
    const hodlVps = comp0 * p.price0 + comp1 * p.price1
    return {
      day: p.day,
      lp: (100 * lpVps) / vps0,
      hodl: (100 * hodlVps) / vps0,
      gap: (100 * (lpVps - hodlVps)) / vps0,
      tvl: p.tvl,
    }
  })

  const lastPt = pts[pts.length - 1]
  const availDays = daysBetween(slice[0].day, end.day)
  return {
    pts,
    sym0: t0.sym0,
    sym1: t0.sym1,
    entryDate: t0.day,
    endDate: end.day,
    lpFinal: lastPt.lp,
    hodlFinal: lastPt.hodl,
    gapFinal: lastPt.gap,
    peakTvl: Math.max(...slice.map((p) => p.tvl)),
    availDays,
    requested: windowDays,
    clamped: windowDays != null && availDays < windowDays - 1,
  }
}
