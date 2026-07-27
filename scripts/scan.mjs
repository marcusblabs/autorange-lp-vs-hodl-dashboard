/**
 * Precompute the LP-vs-HODL scan table for every Balancer v3 pool.
 *
 * Why precompute: the Balancer API sits behind Cloudflare and returns HTTP 429
 * when a browser fires the ~200 requests a full scan needs — a live client-side
 * scan loses most pools to rate limiting. The underlying data is daily
 * snapshots anyway, so a nightly refresh is exactly as fresh as the source.
 * Visitors then load one static JSON: instant table, zero API load. Drilling
 * into a single pool still fetches live (a handful of requests).
 *
 * Run: npm run scan     (writes public/scan.json)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

// The browser modules use sessionStorage for caching; stub it out in Node so
// the exact same fetch + methodology code runs here.
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LIB = pathToFileURL(path.join(ROOT, 'src/lib/')).href

const { fetchAllPools, scanPools, SCAN_MIN_TVL_USD } = await import(LIB + 'balancer.js')
const { normalizeSeries, summarize } = await import(LIB + 'series.js')

const WINDOWS = [30, 90, 180]

// ---------------------------------------------------------------- data trust
//
// Pools are FLAGGED, not silently dropped: the table hides flagged rows behind
// a toggle so nothing is hidden, but obvious nonsense never sits next to real
// results unlabelled.
//
// Three independent signals, because no single one is sufficient:
//
// 1. TVL reconciliation — our Σ(reserve×price) vs the API's own TVL for the
//    same day. Catches arithmetic and token-ordering mistakes. Note it does
//    NOT catch a bad price feed: the API prices the same feed we do, so both
//    agree and the check passes. It is also naturally loose on pools holding
//    illiquid tokens (a healthy 8-token pool sits at 84%), hence the generous
//    threshold.
// 2. Price-feed drift — a token whose price moves more than PRICE_DRIFT_MAX
//    across the window is almost certainly a rebased/rescaled feed rather than
//    a market move. This is what actually catches the $260M pool whose vgUSDC
//    "price" ran 373x while its balances barely moved.
// 3. Implausible magnitude — |LP − HODL| beyond GAP_ABS_MAX over <= 180 days.
//    A backstop for whatever the first two miss.
const RECON_TOLERANCE = 0.05
const RECON_MIN_PASS = 0.8
const RECON_MIN_COVERAGE = 0.5
const PRICE_DRIFT_MAX = 50 // max/min ratio for one token over the series
const STABLE_RATIO_MAX = 2 // pairwise price drift allowed inside a STABLE pool
const GAP_ABS_MAX = 100 // percent

function reconcile(series) {
  let checked = 0
  let ok = 0
  let worst = 0
  for (const p of series) {
    if (!(p.apiTvl > 0)) continue
    checked++
    const err = Math.abs(p.tvl - p.apiTvl) / p.apiTvl
    if (err > worst) worst = err
    if (err <= RECON_TOLERANCE) ok++
  }
  return {
    checked,
    coverage: series.length ? checked / series.length : 0,
    pass: checked ? ok / checked : 0,
    worst,
  }
}

/**
 * For a pool the protocol itself labels STABLE, the tokens are meant to track
 * each other. So the RATIO between their prices should stay near where it
 * started — a yield-bearing wrapper drifts a few percent a year, not multiples.
 *
 * This catches what neither reconciliation nor absolute drift can: a $303M
 * stable pool whose vgUSDC (a USDC vault share) ran 8.2x in six months, giving
 * a nonsensical +99% "LP win". Absolute drift missed it because 8.2x is below
 * any threshold safe for volatile tokens, and reconciliation missed it because
 * the API prices the same feed we do — its own TVL agreed to the dollar.
 */
function stableRatioDrift(series) {
  const first = series[0]
  const n = first.prices.length
  let worst = 1
  let symbol = null
  for (let i = 1; i < n; i++) {
    const base = first.prices[i] / first.prices[0]
    if (!(base > 0)) continue
    let lo = Infinity
    let hi = 0
    for (const p of series) {
      const r = p.prices[i] / p.prices[0] / base
      if (r < lo) lo = r
      if (r > hi) hi = r
    }
    const d = Math.max(hi, lo > 0 ? 1 / lo : Infinity)
    if (d > worst) {
      worst = d
      symbol = first.symbols[i]
    }
  }
  return { drift: worst, symbol }
}

/** Largest max/min price ratio across the pool's tokens, with the symbol. */
function priceDrift(series) {
  if (!series.length) return { ratio: 1, symbol: null }
  const n = series[0].prices.length
  let ratio = 1
  let symbol = null
  for (let i = 0; i < n; i++) {
    let lo = Infinity
    let hi = 0
    for (const p of series) {
      const v = p.prices[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (lo > 0 && hi / lo > ratio) {
      ratio = hi / lo
      symbol = series[0].symbols[i]
    }
  }
  return { ratio, symbol }
}

const started = Date.now()
console.log('fetching pool list…')
const pools = await fetchAllPools({ force: true })
console.log(`  ${pools.length} v3 pools with TVL >= $${SCAN_MIN_TVL_USD.toLocaleString()}`)

let done = 0
const results = await scanPools(pools, {
  // Same price range the single-pool detail view uses, so a row in the table
  // and the chart you get by clicking it are computed from identical inputs.
  range: 'ONE_YEAR',
  concurrency: 3,
  priceConcurrency: 2,
  onResult: () => {
    done++
    if (done % 20 === 0 || done === pools.length) console.log(`  scanned ${done}/${pools.length}`)
  },
})

const rows = []
const skipped = { error: 0, thin: 0, unreliable: 0 }
for (const r of results) {
  const { pool } = r
  if (r.error) { skipped.error++; continue }
  const series = normalizeSeries(r.rows)
  if (series.length < 2) { skipped.thin++; continue }

  const s = summarize(series, WINDOWS)

  // --- trust flags (see the block comment above) ---
  const flags = []
  const recon = reconcile(series)
  if (recon.coverage >= RECON_MIN_COVERAGE && recon.pass < RECON_MIN_PASS) {
    flags.push(`our valuation disagrees with the API's own TVL on ${((1 - recon.pass) * 100).toFixed(0)}% of days (worst ${(recon.worst * 100).toFixed(0)}%)`)
  }
  const drift = priceDrift(series)
  if (drift.ratio > PRICE_DRIFT_MAX) {
    flags.push(`${drift.symbol} price moved ${drift.ratio.toFixed(0)}x over the window — likely a rescaled or broken feed rather than a market move`)
  }
  if (pool.type === 'STABLE') {
    const sr = stableRatioDrift(series)
    if (sr.drift > STABLE_RATIO_MAX) {
      flags.push(`this is a stable pool, yet ${sr.symbol} drifted ${sr.drift.toFixed(1)}x against its pair — the price feed is not trustworthy here`)
    }
  }
  const biggest = Math.max(...WINDOWS.map((w) => Math.abs(s.byWindow[w]?.gapFinal ?? 0)))
  if (biggest > GAP_ABS_MAX) {
    flags.push(`|LP − HODL| reaches ${biggest.toFixed(0)}%, too extreme to take at face value`)
  }
  if (flags.length) {
    skipped.unreliable++
    console.log(`  ⚑ flagged ${pool.label} (${pool.chain}, $${Math.round(pool.tvl).toLocaleString()}) — ${flags[0]}`)
  }

  const win = {}
  for (const w of WINDOWS) {
    const c = s.byWindow[w]
    win[w] = c
      ? {
          gap: +c.gapFinal.toFixed(3),
          lp: +c.lpFinal.toFixed(2),
          hodl: +c.hodlFinal.toFixed(2),
          fees: +c.feePct.toFixed(3),
          drag: +c.dragPct.toFixed(3),
          entry: c.entryDate,
        }
      : null
  }
  rows.push({
    address: pool.address,
    chain: pool.chain,
    type: pool.type,
    label: pool.label,
    name: pool.name,
    tvl: Math.round(pool.tvl),
    swapFee: pool.swapFee,
    yieldApr: +(pool.yieldApr || 0).toFixed(5),
    incentiveApr: +(pool.incentiveApr || 0).toFixed(5),
    nTokens: pool.tokens.length,
    maxWin: s.maxWin,
    live: s.live,
    // Windows are measured back from a pool's LAST TRADING DAY, not from
    // today. For a dormant pool "90d" therefore means a 90-day stretch that
    // ended whenever it stopped trading — not comparable with a live pool's
    // last 90 days, so the table separates the two.
    lastDay: series[series.length - 1].day,
    flags,
    win,
  })
}

rows.sort((a, b) => b.tvl - a.tvl)
const out = {
  generatedAt: new Date().toISOString(),
  windows: WINDOWS,
  minTvl: SCAN_MIN_TVL_USD,
  counts: { listed: pools.length, usable: rows.length, ...skipped },
  rows,
}

const dest = path.join(ROOT, 'public/scan.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(out))
const kb = (fs.statSync(dest).size / 1024).toFixed(1)

console.log(`\nwrote public/scan.json — ${rows.length} pools, ${kb} KB, ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`skipped: ${skipped.error} fetch/price errors, ${skipped.thin} too little history`)
console.log(`flagged (kept, hidden behind a toggle): ${skipped.unreliable}`)
for (const w of WINDOWS) console.log(`  ${w}d coverage: ${rows.filter((r) => r.win[w]).length} pools`)
