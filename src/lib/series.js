// Turn the raw daily-state rows from Dune into the LP-vs-HODL comparison.
//
// LP leg   : value_per_share(t) = TVL(t) / totalSupply(t)  — already nets fees,
//            impermanent loss and the LVR cost of auto-ranging (all embedded in
//            the on-chain reserves).
// HODL leg : the deposited basket. At entry t0, composition per share is
//            (res0/bpt, res1/bpt); held forward and marked with the same prices.
// Both legs are indexed to 100 at the window's entry day, so the gap between
// them is the LP's fee-minus-LVR result over that window.

const DAY_MS = 86400000
const toMs = (day) => new Date(day + 'T00:00:00Z').getTime()
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS)

/** Parse, sort, dedupe, and trim the post-suspension collapse tail. */
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

  // Cut at the first supply "cliff" (>80% single-day drop) — that's the
  // suspension mass-withdrawal / end-of-life, after which value-per-share is
  // noise. Gradual removes and the early ramp-up are preserved.
  let cut = arr.length
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].bpt < 0.2 * arr[i - 1].bpt) {
      cut = i
      break
    }
  }
  return arr.slice(0, cut)
}

/** Largest window (in days) the cleaned series can actually support. */
export function maxWindowDays(series) {
  if (series.length < 2) return 0
  return daysBetween(series[0].day, series[series.length - 1].day)
}

/** Is the pool still live (last data point within ~4 days of now)? */
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
