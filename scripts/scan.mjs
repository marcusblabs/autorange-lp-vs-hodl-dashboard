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
// Largest single-day price ratio tolerated for one token. Real assets do move
// violently — a 3x day is a bad depeg but it happens — so this is set well
// above market behaviour and aimed at the step changes a rescaled or broken
// feed produces. The observed cases sit either side of it by a wide margin:
// worst genuine day in the set is 1.64x, the broken Polygon USDC feed is 101x.
const PRICE_DRIFT_MAX = 10
const STABLE_RATIO_MAX = 2 // pairwise price drift allowed inside a STABLE pool
const GAP_ABS_MAX = 100 // percent

/**
 * Annualise a window's out/under-performance against holding.
 *
 * Compounds the ratio of the two legs rather than scaling their difference:
 * (LP/HODL)^(365/days) - 1. Both legs start at 100, so the ratio is the pure
 * relative result with the tokens' own price moves already divided out.
 *
 * Windows shorter than MIN_ANNUALISE_DAYS return null: raising a few days of
 * noise to the power of ~50 produces confident-looking nonsense.
 */
const MIN_ANNUALISE_DAYS = 14
function annualise(lp, hodl, days) {
  if (!(days >= MIN_ANNUALISE_DAYS) || !(lp > 0) || !(hodl > 0)) return null
  const r = Math.pow(lp / hodl, 365 / days) - 1
  if (!isFinite(r)) return null
  return +(r * 100).toFixed(2)
}

/**
 * Checked over the most recent RECON_WINDOW_DAYS only.
 *
 * The whole series now reaches back ~3.4 years, and judging a pool on 2023
 * snapshot quality flagged 191 of 446 pools — including wstETH/AAVE at $11.4M —
 * hiding 47% of all TVL behind the SHOW filter by default. A guard that noisy
 * gets ignored, which is worse than not having one.
 *
 * 180 days is the longest fixed window the table quotes, so this asks the
 * question that matters: are the numbers on screen reconcilable today? Ancient
 * disagreement only affects the FULL column and is not worth hiding a pool for.
 */
const RECON_WINDOW_DAYS = 180
function reconcile(series) {
  let checked = 0
  let ok = 0
  let worst = 0
  for (const p of series.slice(-RECON_WINDOW_DAYS)) {
    if (!(p.apiTvl > 0)) continue
    checked++
    const err = Math.abs(p.tvl - p.apiTvl) / p.apiTvl
    if (err > worst) worst = err
    if (err <= RECON_TOLERANCE) ok++
  }
  // Coverage is against the days actually examined, not the whole series —
  // otherwise a four-year pool looks 95% "unverified" purely because the
  // window is 180 days long.
  const examined = Math.min(series.length, RECON_WINDOW_DAYS)
  return {
    checked,
    coverage: examined ? checked / examined : 0,
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

/**
 * Largest ONE-DAY price jump across the pool's tokens, with the symbol and date.
 *
 * This used to be the max/min ratio over the whole series, which cannot tell a
 * broken feed from a bad year. Once the price range moved from ONE_YEAR to ALL
 * the series grew to ~3.4 years and that guard started firing on real market
 * moves: BAL ran $7.30 (Apr 2023) to $0.09 (Jun 2026), a genuine 98.8% decline,
 * and got flagged as an 81x "broken feed" — on a $4.5M pool.
 *
 * A rescaling or decimals bug is a STEP; a bear market is a SLOPE. Measuring the
 * largest single-day move separates them cleanly:
 *     BAL   whole-life 81.1x  ->  worst day 1.64x   (benign)
 *     WETH  whole-life  3.4x  ->  worst day 1.21x   (benign)
 *     USDC on Polygon    inf  ->  worst day  101x   (broken, 2023-03-21)
 * It is also immune to the zero-price case that made the old ratio Infinity for
 * any token that ever printed 0.
 */
function priceDrift(series) {
  if (series.length < 2) return { ratio: 1, symbol: null, day: null }
  const n = series[0].prices.length
  let ratio = 1
  let symbol = null
  let day = null
  for (let i = 0; i < n; i++) {
    for (let k = 1; k < series.length; k++) {
      const a = series[k - 1].prices[i]
      const b = series[k].prices[i]
      if (!(a > 0) || !(b > 0)) continue
      const r = Math.max(b / a, a / b)
      if (r > ratio) {
        ratio = r
        symbol = series[0].symbols[i]
        day = series[k].day
      }
    }
  }
  return { ratio, symbol, day }
}

const started = Date.now()
console.log('fetching pool list…')
const { pools, blacklistedCount, excludedChains } = await fetchAllPools({ force: true })
console.log(`  ${pools.length} v3 pools with TVL >= $${SCAN_MIN_TVL_USD.toLocaleString()}`)
console.log(`  excluded: ${blacklistedCount} blacklisted by Balancer · chains ${excludedChains.join(', ')}`)

let done = 0
const results = await scanPools(pools, {
  // Range deliberately left to the PRICE_RANGE default in balancer.js — the
  // detail view uses that same constant, so a row in the table and the chart
  // you get by clicking it cannot be computed over different spans. Naming the
  // range here once let the two drift apart.
  // Dropped from 3 to 2. Throttling here does not announce itself as an error —
  // the API returns 200 with an empty snapshot list — so the cost of pushing
  // too hard was pools silently vanishing from the table rather than a visible
  // failure. fetchSnapshots now retries an empty response, and this makes it
  // need to less often. Slower, and the run is in CI overnight anyway.
  concurrency: 2,
  priceConcurrency: 2,
  onResult: () => {
    done++
    if (done % 20 === 0 || done === pools.length) console.log(`  scanned ${done}/${pools.length}`)
  },
})

const rows = []
// `empty` is tracked apart from `thin` on purpose. A rate-limited request does
// not always throw: the API can answer with no snapshots at all, which lands
// here as a pool with zero rows and looks identical to a pool that is genuinely
// two days old. Filing both under "too little history" hid a throttled scan
// completely — the failure ceiling below only counted `error`, so a run that
// quietly lost 30 pools to 429s still published.
const skipped = { error: 0, empty: 0, thin: 0, unreliable: 0 }
// Identities, not just counts. "38 pools returned nothing" is unactionable;
// knowing WHICH pools, on which chains, is what tells you whether the cause is
// load or something structural about those pools.
const lost = { error: [], empty: [] }
for (const r of results) {
  const { pool } = r
  if (r.error) { skipped.error++; lost.error.push(`${pool.label || pool.name} (${pool.chain}, v${pool.protocolVersion}) — ${r.error}`); continue }
  if (!r.rows.length) { skipped.empty++; lost.empty.push(`${pool.label || pool.name} (${pool.chain}, v${pool.protocolVersion}, $${Math.round(pool.tvl).toLocaleString()}) id=${pool.id?.slice(0, 18)}`); continue }
  const series = normalizeSeries(r.rows)
  if (series.length < 2) { skipped.thin++; continue }

  const s = summarize(series, WINDOWS)
  const packWindow = (c) =>
    c
      ? {
          gap: +c.gapFinal.toFixed(3),
          lp: +c.lpFinal.toFixed(2),
          hodl: +c.hodlFinal.toFixed(2),
          // vs holding the UNDERLYING assets (plain USDC, not waEthUSDC) —
          // the alternative an LP actually has. Equal to `gap` when the pool
          // holds no boosted tokens.
          gapU: +c.gapUnderFinal.toFixed(3),
          hodlU: +c.hodlUnderFinal.toFixed(2),
          boost: +c.boostPct.toFixed(3),
          fees: +c.feePct.toFixed(3),
          drag: +c.dragPct.toFixed(3),
          // The drag has to follow the basis the reader picked. Publishing only
          // the vault-token drag while the gap column switched to underlying
          // made the table contradict its own "IL drag = gap minus fees" note
          // on 128 rows, several with a sign flip.
          dragU: +c.dragUnderPct.toFixed(3),
          entry: c.entryDate,
          days: c.availDays,
          // Annualised out/under-performance vs holding, compounded:
          //   (LP/HODL)^(365/days) - 1
          // A rate, not a forecast — see the note in PoolTable.
          apr: annualise(c.lpFinal, c.hodlFinal, c.availDays),
          aprU: annualise(c.lpFinal, c.hodlUnderFinal, c.availDays),
        }
      : null

  // --- trust flags (see the block comment above) ---
  const flags = []
  const recon = reconcile(series)
  // Two distinct failures, and the second one used to pass silently: a pool
  // whose snapshots carry no totalLiquidity at all had coverage 0, skipped the
  // condition entirely, and came out unflagged — the reconciliation guard
  // treating "nothing to check" as "checked and fine". Absence of evidence is
  // not evidence of agreement.
  if (recon.coverage < RECON_MIN_COVERAGE) {
    flags.push(`only ${(recon.coverage * 100).toFixed(0)}% of days could be checked against the API's own TVL, so this valuation is largely unverified`)
  } else if (recon.pass < RECON_MIN_PASS) {
    flags.push(`our valuation disagrees with the API's own TVL on ${((1 - recon.pass) * 100).toFixed(0)}% of days (worst ${(recon.worst * 100).toFixed(0)}%)`)
  }
  // An UNDERLYING figure built mostly from wrapped-price substitutions is the
  // vault-token number under an "Underlying" heading. Say so rather than let
  // the basis toggle quietly return the same value twice.
  if (r.underFallbackRate > 0.2) {
    flags.push(`no underlying price feed on ${(r.underFallbackRate * 100).toFixed(0)}% of days — the "vs underlying" figure falls back to the wrapped price and is not a true underlying comparison`)
  }
  const drift = priceDrift(series)
  if (drift.ratio > PRICE_DRIFT_MAX) {
    flags.push(`${drift.symbol} price jumped ${drift.ratio.toFixed(0)}x in a single day on ${drift.day} — a step that size is a rescaled or broken feed, not a market move`)
  }
  if (pool.type === 'STABLE') {
    const sr = stableRatioDrift(series)
    if (sr.drift > STABLE_RATIO_MAX) {
      flags.push(`this is a stable pool, yet ${sr.symbol} drifted ${sr.drift.toFixed(1)}x against its pair — the price feed is not trustworthy here`)
    }
  }
  // `full` is included deliberately: it is the ONLY populated column for a pool
  // too young for 30D, so checking just the fixed windows exempted exactly the
  // young pools this dashboard exists to show. Both bases are checked, since a
  // boosted pool can be sane on one and absurd on the other.
  const magnitudes = [...WINDOWS.map((w) => s.byWindow[w]), s.full].flatMap((c) =>
    c ? [Math.abs(c.gapFinal), Math.abs(c.gapUnderFinal)] : []
  )
  const biggest = magnitudes.length ? Math.max(...magnitudes) : 0
  if (biggest > GAP_ABS_MAX) {
    flags.push(`|LP − HODL| reaches ${biggest.toFixed(0)}%, too extreme to take at face value`)
  }
  if (flags.length) {
    skipped.unreliable++
    console.log(`  ⚑ flagged ${pool.label} (${pool.chain}, $${Math.round(pool.tvl).toLocaleString()}) — ${flags[0]}`)
  }

  const win = {}
  for (const w of WINDOWS) win[w] = packWindow(s.byWindow[w])
  // Whole-life result. Many pools — the relaunched AutoRange ones especially —
  // are younger than 30 days, so every fixed window is blank for them. This
  // column guarantees each row still says something.
  win.full = packWindow(s.full)
  rows.push({
    id: pool.id,
    protocolVersion: pool.protocolVersion,
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
    reviewed: pool.reviewed,
    boosted: pool.tokens.some((t) => t.underlying),
    underlyingLabel: pool.tokens.map((t) => t.underlying?.symbol || t.symbol).join(' / '),
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

// No row may end on today: the current UTC day is still accumulating, so its
// value depends on the hour the scan happened to run. That is what made this
// table disagree with the detail view — both quoted the same window and the
// same entry date while reading different intraday states of the same final
// day. normalizeSeries drops it; this asserts it stayed dropped, because the
// failure is silent and surfaces only as two screens showing different numbers.
const today = new Date().toISOString().slice(0, 10)
const leaked = rows.filter((r) => r.lastDay >= today)
if (leaked.length) {
  console.error(
    `\nABORT: ${leaked.length} rows end on the incomplete day ${today} ` +
      `(e.g. ${leaked[0].label}). The table and the live detail view would disagree.`
  )
  // Exit 3, not 1: CI distinguishes "this script refuses to publish" from an
  // ordinary network failure, and only the latter is allowed to fall back to
  // the committed scan.json and still go green.
  process.exit(3)
}

// A scan that lost a third of its pools to 429s produced a table that looked
// exactly like a complete one — the per-pool failures were tallied into
// `counts` and nothing read them. Refuse to publish a visibly truncated run,
// because "fewer pools than usual" is invisible to a reader who has no
// baseline to compare against.
// Counts BOTH hard errors and pools that came back with nothing: under
// throttling the API answers "no snapshots" far more often than it errors, so a
// ceiling on errors alone would miss exactly the failure it exists to catch.
const FETCH_FAIL_MAX = 0.1
const lostToFetch = skipped.error + skipped.empty
const failRate = pools.length ? lostToFetch / pools.length : 0
if (lostToFetch) {
  console.log(`\n${lostToFetch} pools produced no usable series:`)
  for (const l of lost.error) console.log(`  ERROR  ${l}`)
  for (const l of lost.empty) console.log(`  EMPTY  ${l}`)
}
if (failRate > FETCH_FAIL_MAX) {
  console.error(
    `\nABORT: ${lostToFetch}/${pools.length} pools (${(failRate * 100).toFixed(0)}%) returned an error ` +
      `or no data at all (${skipped.error} errors, ${skipped.empty} empty) — over the ` +
      `${(FETCH_FAIL_MAX * 100).toFixed(0)}% ceiling. This is a rate-limited or partial scan; ` +
      `publishing it would silently drop pools from the table.`
  )
  process.exit(3)
}

const out = {
  generatedAt: new Date().toISOString(),
  // The last completed day the rows are computed through. The detail view
  // derives the same boundary from its own clock; carrying it makes any future
  // divergence diagnosable instead of a mystery.
  throughDay: rows.reduce((a, r) => (r.lastDay > a ? r.lastDay : a), ''),
  windows: WINDOWS,
  minTvl: SCAN_MIN_TVL_USD,
  excludedChains,
  blacklistedCount,
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
