// Turn daily raw-state rows into the LP-vs-HODL comparison.
//
// Works for any Balancer v3 pool with any number of tokens:
//   LP leg   : value_per_share(t) = Σ(amount_i(t)·price_i(t)) / totalSupply(t)
//              — nets swap fees, impermanent loss and (for reCLAMM) the LVR
//              cost of auto-ranging, since all of it lands in the reserves.
//   HODL leg : the deposited basket. At entry t0 the composition per share is
//              (amount_i/bpt for every i); held forward and marked with the
//              same daily prices.
// Both legs are indexed to 100 at the window's entry day, so the gap between
// them is the LP's fee-minus-divergence result over that window.
//
// Note on yield-bearing (boosted) tokens: both legs hold the same wrapped
// assets, so the underlying yield lifts BOTH and cancels out of the gap.

const DAY_MS = 86400000
const toMs = (day) => new Date(day + 'T00:00:00Z').getTime()
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS)

// A trailing run of ≥ this many days without trading means the pool is
// suspended or dormant. The run start is kept as the series endpoint; the
// tail after it carries no fee/divergence information (during a no-swap
// stretch the LP tracks its own basket exactly, so the gap is frozen by
// construction).
//
// "No trading" is detected on per-share composition: a proportional
// add/remove leaves amount_i/bpt unchanged for every token, while any swap
// shifts it. This matters — after the Feb-2026 reCLAMM suspension stragglers
// kept exiting proportionally for months, and an identical-state test would
// keep that paused coda alive.
const DORMANT_RUN_DAYS = 10
const TRADE_EPS = 1e-6

function tradedBetween(a, b) {
  for (let i = 0; i < a.amounts.length; i++) {
    const pa = a.amounts[i] / a.bpt
    const pb = b.amounts[i] / b.bpt
    if (Math.abs(pb - pa) / (Math.abs(pa) || 1) > TRADE_EPS) return true
  }
  return false
}

/**
 * Parse, sort, dedupe and trim a raw daily series.
 * Rows in: {day, symbols[], amounts[], prices[], bpt, tvl}
 */
export function normalizeSeries(rows) {
  const pts = (rows || [])
    .map((r) => ({
      day: String(r.day).slice(0, 10),
      symbols: r.symbols,
      amounts: r.amounts.map(Number),
      prices: r.prices.map(Number),
      bpt: +r.bpt,
      tvl: +r.tvl,
      fees: +r.fees || 0,
      // The API's own TVL for the same day, carried through so callers can
      // reconcile our reconstructed value against it. Must survive this
      // mapping — dropping it silently made every reconciliation check
      // vacuous, which in turn let a pool with a 373x price glitch through.
      apiTvl: +r.apiTvl,
    }))
    .filter(
      (p) =>
        p.bpt > 0 &&
        isFinite(p.tvl) &&
        p.tvl > 0 &&
        p.amounts.every(isFinite) &&
        p.prices.every((x) => isFinite(x) && x > 0)
    )

  pts.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const byDay = new Map()
  for (const p of pts) byDay.set(p.day, p) // last write per day wins
  let arr = [...byDay.values()]

  // Supply-collapse guard: a pool drained to dust shares makes the
  // value-per-share denominator degenerate (a seeded-then-drained test pool
  // showed a 2.5e15x fake "LP return"). Cut at the first day supply falls
  // below 1e-6 of its running max — real mass exits never go that deep (the
  // Feb-2026 withdrawal left 0.9% of max supply).
  let maxBpt = 0
  for (let i = 0; i < arr.length; i++) {
    maxBpt = Math.max(maxBpt, arr[i].bpt)
    if (arr[i].bpt < 1e-6 * maxBpt) {
      arr = arr.slice(0, i)
      break
    }
  }

  // Trim the dormant tail.
  let runStart = arr.length - 1
  while (runStart > 0 && !tradedBetween(arr[runStart - 1], arr[runStart])) runStart--
  if (arr.length - runStart >= DORMANT_RUN_DAYS) return arr.slice(0, runStart + 1)
  return arr
}

/** Largest window (in days) the cleaned series can actually support. */
export function maxWindowDays(series) {
  if (!series || series.length < 2) return 0
  return daysBetween(series[0].day, series[series.length - 1].day)
}

/** Is the pool still trading (last kept data point within ~4 days of now)? */
export function isLive(series, nowMs = Date.now()) {
  if (!series || !series.length) return false
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
  if (slice.length < 2) return null

  const t0 = slice[0]
  const comp = t0.amounts.map((a) => a / t0.bpt) // entry basket, per share
  const vps0 = t0.tvl / t0.bpt // LP and HODL coincide at entry
  const hodlVps = (p) => comp.reduce((acc, c, i) => acc + c * p.prices[i], 0)

  const pts = slice.map((p) => {
    const lp = p.tvl / p.bpt
    const hodl = hodlVps(p)
    return {
      day: p.day,
      lp: (100 * lp) / vps0,
      hodl: (100 * hodl) / vps0,
      gap: (100 * (lp - hodl)) / vps0,
      tvl: p.tvl,
    }
  })

  const lastPt = pts[pts.length - 1]
  const availDays = daysBetween(slice[0].day, end.day)
  const feeSum = slice.reduce((a, p) => a + (p.fees || 0), 0)
  const avgTvl = slice.reduce((a, p) => a + p.tvl, 0) / slice.length
  const feePct = avgTvl > 0 ? (100 * feeSum) / avgTvl : 0

  return {
    pts,
    symbols: t0.symbols,
    label: t0.symbols.join(' / '),
    // convenience for the 2-token case (most pools)
    sym0: t0.symbols[0],
    sym1: t0.symbols[1],
    nTokens: t0.symbols.length,
    entryDate: t0.day,
    endDate: end.day,
    lpFinal: lastPt.lp,
    hodlFinal: lastPt.hodl,
    gapFinal: lastPt.gap,
    feePct,
    // gap minus fees ≈ the impermanent-loss / LVR component
    dragPct: lastPt.gap - feePct,
    peakTvl: Math.max(...slice.map((p) => p.tvl)),
    endTvl: end.tvl,
    availDays,
    requested: windowDays,
    clamped: windowDays != null && availDays < windowDays - 1,
  }
}

/**
 * Summary row for the scan table: LP−HODL at each requested window.
 * Windows the pool is too young for come back null (rendered as "—").
 */
export function summarize(series, windows) {
  const maxWin = maxWindowDays(series)
  const out = { maxWin, live: isLive(series), byWindow: {} }
  for (const w of windows) {
    // needs at least ~80% of the window to be a fair comparison
    out.byWindow[w] = maxWin >= w * 0.8 ? computeWindow(series, w) : null
  }
  out.full = computeWindow(series, null)
  return out
}
