/**
 * Balancer official API (api-v3.balancer.fi) — the data backbone.
 *
 * Pool list, daily snapshots (reserves + BPT supply) and historical USD
 * prices all come from the same free GraphQL endpoint, for every chain
 * Balancer v3 runs on. No API key, no execute/poll round-trips, CORS open.
 *
 * Why snapshots and not event replay: the API's snapshots come from the
 * official subgraph, whose reserves already exclude the aggregate
 * (protocol + creator) fee skim. Replaying Vault events overstates
 * reserves by the uncollected skim — small while supply is large, but it
 * produces a fake +22% value-per-share jump across the Feb-2026
 * suspension exits (verified on AAVE/WETH). The Dune query in query/ is
 * kept as an independent cross-check of that effect (Ethereum only).
 *
 * Performance note (measured): snapshots are cheap — 12 pools in parallel
 * take ~385ms. Historical prices are the bottleneck: the API returns
 * HOURLY points, so one year for 41 tokens is ~106k points and ~16s cold.
 * Two mitigations: request only the range a view needs (180d for the scan
 * table, one year for a single pool's detail view), and split the address
 * list into small chunks fetched in parallel. The API caches server-side,
 * so a repeat of the same call drops to ~190ms.
 */

// Explicit .js extension: scripts/scan.mjs imports this module in plain Node,
// which (unlike Vite) will not resolve an extensionless path.
import { EXCLUDED_CHAINS } from '../config.js'

const API = 'https://api-v3.balancer.fi/graphql'
const TTL_MS = 10 * 60 * 1000 // session cache: fresh enough for daily data
const DAY_MS = 86400000

// Universe for the scan table: every v3 pool with more than dust in it.
export const SCAN_MIN_TVL_USD = 1000
// Price-fetch tuning (see the performance note above).
const PRICE_CHUNK = 8
const SNAPSHOT_CONCURRENCY = 4

// The API sits behind Cloudflare and returns 429 under bursty load — a full
// client-side scan of every pool (~200 requests) gets cut off partway. Hence
// two things: the scan table is precomputed by scripts/scan.mjs into
// public/scan.json rather than fetched live, and every request here retries
// politely on 429 so a single-pool drill-down still succeeds.
const MAX_RETRIES = 4
// Snapshots older than this are corrupt sentinels, not history.
const MIN_SNAPSHOT_MS = Date.UTC(2020, 0, 1)

/**
 * Price history range, shared by the scan and the single-pool detail view so
 * neither can be computed over a different span than the other.
 *
 * ONE_YEAR, and NOT `ALL`, despite `ALL` looking better on every surface
 * measurement: it reaches back to 2023 instead of 12 months, returns exactly
 * one point per day at 00:00 UTC (matching how pool snapshots are stamped)
 * rather than 7.36 intraday ticks per day, and is smaller and faster.
 *
 * `ALL` rounds prices to two decimal places. Measured against the live API on
 * the same day:
 *     SHIB   ALL 0            ONE_YEAR 0.00000492   (all 1245 points zero)
 *     BAL    ALL 0.12         ONE_YEAR 0.114176     (a 5.1% price error)
 *     WETH   ALL 1868         ONE_YEAR 1909.11
 * So it silently zeroes every token under half a cent — buildRows requires a
 * positive price for each token, so those pools produce no rows at all and
 * vanish from the table (38 of 527 did) — and quantises every other low-priced
 * token, corrupting value-per-share for any pool that holds one. The jump to
 * 191 pools failing TVL reconciliation was this, not the longer history it was
 * first blamed on.
 *
 * The cost of ONE_YEAR is accepted and disclosed rather than papered over:
 *   - The series cannot exceed ~365 days, so the FULL column is "up to a year",
 *     which is what the header now says instead of "whole life".
 *   - Days are bucketed with last-write-wins across ~7 intraday ticks. For a
 *     COMPLETED day that is consistently its final tick, which is a stable
 *     daily close; the in-progress day, where this was genuinely unstable, is
 *     dropped by normalizeSeries.
 */
const PRICE_RANGE = 'ONE_YEAR'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gql(query, { signal, retries = MAX_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      })
    } catch (e) {
      // A throttled response from Cloudflare carries no CORS headers, so the
      // browser rejects it as an opaque network failure — we never get to see
      // the 429. Treat a bare fetch rejection as retryable for the same reason.
      if (signal?.aborted) throw e
      if (attempt >= retries) {
        throw new Error(
          'Could not reach the Balancer API — it may be rate-limiting requests. Wait a moment and retry.'
        )
      }
      await sleep(Math.min(8000, 600 * 2 ** attempt))
      continue
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt >= retries) throw new Error('Balancer API is rate-limiting requests — try again shortly.')
      const retryAfter = +res.headers.get('retry-after') || 0
      await sleep(retryAfter ? retryAfter * 1000 : Math.min(8000, 600 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`Balancer API ${res.status}: ${res.statusText}`)
    const json = await res.json()
    if (json.errors?.length) throw new Error(`Balancer API: ${json.errors[0].message}`)
    return json.data
  }
}

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const { t, v } = JSON.parse(raw)
    return Date.now() - t > TTL_MS ? null : v
  } catch {
    return null
  }
}

function cacheSet(key, v) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v }))
  } catch {
    /* private browsing / quota — just skip caching */
  }
}

const toDay = (tsSec) => new Date(+tsSec * 1000).toISOString().slice(0, 10)

/** Run an async mapper over items, at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Every address whose price series a pool needs: its tokens + underlyings. */
const tokenPriceAddresses = (tokens) => [
  ...new Set(tokens.flatMap((t) => (t.underlying ? [t.address, t.underlying.address] : [t.address]))),
]

const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * Normalise one pool token.
 *
 * `underlying` is the asset an LP actually brings for a boosted (ERC4626)
 * token — USDC rather than waEthUSDC — and drives the "vs underlying" HODL
 * basis. null means the token is its own underlying.
 *
 * We deliberately do NOT use the API's `priceRate` to convert: for a plain
 * ERC4626 wrapper it equals the wrapper rate, but rate providers can fold in
 * other things. waBasEURC reports priceRate 1.1753 while its true wrapper rate
 * is 1.0307 — the difference is the EUR/USD rate baked into the provider. The
 * ratio of the two USD price series is the honest conversion.
 */
function mapToken(t) {
  return {
    idx: t.index,
    address: t.address.toLowerCase(),
    symbol: t.symbol,
    weight: t.weight == null ? null : +t.weight,
    underlying:
      t.isErc4626 && t.underlyingToken
        ? { address: t.underlyingToken.address.toLowerCase(), symbol: t.underlyingToken.symbol }
        : null,
  }
}

/**
 * Tokens an LP actually owns a share of.
 *
 * Composable-stable (v2) pools pre-mint a huge slug of their OWN BPT and hold
 * it as a pool token — `amounts` carries ~2.6e15 of it. That is phantom, not
 * liquidity: the API's own TVL excludes it, and `totalShares` is already the
 * circulating supply (so it must NOT be reduced by the held amount — doing so
 * goes negative). Dropping the self-token from the basket makes reserves
 * reconcile and leaves value-per-share correct.
 */
function realTokens(tokens, poolAddress) {
  const self = String(poolAddress || '').toLowerCase()
  return tokens.map(mapToken).filter((t) => t.address !== self)
}

function summarizeAprs(items) {
  let yieldApr = 0 // earned by BOTH legs (yield-bearing tokens) → cancels out
  let incentiveApr = 0 // LP-only external rewards → NOT in value-per-share
  for (const a of items || []) {
    if (a.type === 'IB_YIELD') yieldApr += +a.apr || 0
    else if (a.type === 'MERKL' || a.type === 'STAKING') incentiveApr += +a.apr || 0
  }
  return { yieldApr, incentiveApr }
}

/**
 * Every Balancer v3 pool above the dust floor, across all chains, TVL-sorted —
 * minus the ones Balancer itself blacklists.
 *
 * The blacklist is the front-end's own curation (`BLACK_LISTED` tag) and it is
 * strictly better than any heuristic for the cases it covers: test pools, dust,
 * and pools built on token families whose price feeds are known-bad. It caught
 * 13 pools our own data checks missed, including several above $1M TVL.
 *
 * It is not a superset though, so the scan keeps its own checks too: the
 * majority of pools we flag for implausible price data are NOT blacklisted,
 * and several are explicitly `reviewedOnly` yet still carry a 133x price drift.
 * Reviewed means the contract was looked at, not that the oracle is sane.
 *
 * NB: the `categories` field cannot be selected — the server returns values
 * (e.g. POINTS_MAINSTREET) that are missing from its own published enum, so
 * GraphQL fails to serialise the response. The tagIn/tagNotIn filters work.
 */
export async function fetchAllPools({ force = false } = {}) {
  const KEY = 'ar.pools.all.v2'
  if (!force) {
    const hit = cacheGet(KEY)
    if (hit) return hit
  }
  const [data, reviewedData, blacklisted] = await Promise.all([
    gql(`{
      poolGetPools(first: 1000, orderBy: totalLiquidity, orderDirection: desc,
                   where: {protocolVersionIn: [1, 2, 3], minTvl: ${SCAN_MIN_TVL_USD},
                           chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                           tagNotIn: ["BLACK_LISTED"]}) {
        id address chain type version protocolVersion name
        dynamicData { totalLiquidity swapFee aprItems { title apr type } }
        poolTokens { index address symbol weight isErc4626 underlyingToken { address symbol } }
      }
    }`),
    gql(`{
      poolGetPools(first: 1000, where: {protocolVersionIn: [1, 2, 3], minTvl: ${SCAN_MIN_TVL_USD}, chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                                        reviewedOnly: true}) { address }
    }`),
    gql(`{
      poolGetPools(first: 1000, where: {protocolVersionIn: [1, 2, 3], minTvl: ${SCAN_MIN_TVL_USD}, chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                                        tagIn: ["BLACK_LISTED"]}) { address }
    }`),
  ])
  const reviewed = new Set(
    (reviewedData.poolGetPools || []).map((p) => p.address.toLowerCase())
  )
  const blacklistedCount = (blacklisted.poolGetPools || []).length

  const list = (data.poolGetPools || []).map((p) => {
    const tokens = [...p.poolTokens].sort((a, b) => a.index - b.index)
    const { yieldApr, incentiveApr } = summarizeAprs(p.dynamicData?.aprItems)
    return {
      // v2 pool ids are 32 bytes (address + nonce) and poolGetPool /
      // poolGetSnapshots key on the id, NOT the address — querying a v2 pool by
      // address returns zero snapshots silently rather than erroring.
      id: p.id,
      address: p.address.toLowerCase(),
      chain: p.chain,
      type: p.type,
      version: p.version,
      protocolVersion: p.protocolVersion,
      name: p.name,
      label: tokens.map((t) => t.symbol).join(' / '),
      tvl: +p.dynamicData?.totalLiquidity || 0,
      swapFee: +p.dynamicData?.swapFee || 0,
      yieldApr,
      incentiveApr,
      tokens: realTokens(tokens, p.address),
      // Balancer looked at the contract. It does NOT imply the price feed is
      // sane — several reviewed pools carry 100x+ oracle drift.
      reviewed: reviewed.has(p.address.toLowerCase()),
    }
  })
  const out = { pools: list, blacklistedCount, excludedChains: EXCLUDED_CHAINS }
  cacheSet(KEY, out)
  return out
}

/**
 * Locate a pool from whatever the user pasted.
 *
 * v3 pool ids ARE the address, but a v2 id is 32 bytes (address + nonce) and
 * `idIn` matches on the id — so a 42-char v2 address finds nothing. There is no
 * address filter, so fall back to listing pools and matching on the id prefix.
 */
export async function resolvePool(input) {
  const key = String(input).toLowerCase()
  const direct = await gql(`{
    poolGetPools(where: {idIn: ["${key}"]}) { id address chain type version name }
  }`)
  let hit = (direct.poolGetPools || []).find(
    (p) => p.id.toLowerCase() === key || p.address.toLowerCase() === key
  )
  if (!hit) {
    const all = await gql(`{
      poolGetPools(first: 1000, where: {protocolVersionIn: [1, 2, 3]}) { id address chain type version name }
    }`)
    hit = (all.poolGetPools || []).find(
      (p) => p.address.toLowerCase() === key || p.id.toLowerCase().startsWith(key)
    )
  }
  return hit
    ? {
        id: hit.id,
        address: hit.address.toLowerCase(),
        chain: hit.chain,
        type: hit.type,
        version: hit.version,
        name: hit.name,
      }
    : null
}

/** Pool metadata + ordered tokens for a single pool. */
export async function fetchPoolMeta(poolId, chain) {
  const addr = poolId.toLowerCase()
  const data = await gql(`{
    poolGetPool(id: "${addr}", chain: ${chain}) {
      id address type name protocolVersion
      dynamicData { totalLiquidity swapFee aprItems { title apr type } }
      poolTokens { index address symbol weight isErc4626 underlyingToken { address symbol } }
    }
  }`)
  const p = data.poolGetPool
  if (!p) throw new Error(`Pool not found on ${chain}.`)
  const tokens = [...p.poolTokens].sort((a, b) => a.index - b.index)
  const { yieldApr, incentiveApr } = summarizeAprs(p.dynamicData?.aprItems)
  return {
    id: p.id || addr,
    address: (p.address || addr).toLowerCase(),
    protocolVersion: p.protocolVersion,
    chain,
    type: p.type,
    name: p.name,
    label: tokens.map((t) => t.symbol).join(' / '),
    tvl: +p.dynamicData?.totalLiquidity || 0,
    swapFee: +p.dynamicData?.swapFee || 0,
    yieldApr,
    incentiveApr,
    tokens: realTokens(tokens, p.address ?? addr),
  }
}

/**
 * day → price maps for a set of tokens on one chain.
 * Chunked and run in parallel: the endpoint scales badly with the number of
 * addresses in a single call (41 tokens/one year ≈ 16s, vs a few hundred ms
 * for one), so many small parallel calls beat one big one.
 */
async function fetchChainPrices(chain, addresses, range, { signal, concurrency = 3 } = {}) {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))]
  const groups = chunk(uniq, PRICE_CHUNK)
  const maps = new Map()
  // Chunks are fetched with bounded concurrency and fail independently: one
  // bad group must not blank out every token on the chain.
  await mapLimit(groups, concurrency, async (g) => {
    const list = g.map((a) => `"${a}"`).join(',')
    try {
      const data = await gql(
        `{ tokenGetHistoricalPrices(addresses: [${list}], chain: ${chain}, range: ${range}) {
             address prices { timestamp price } } }`,
        { signal }
      )
      for (const t of data.tokenGetHistoricalPrices || []) {
        const m = maps.get(t.address.toLowerCase()) || new Map()
        // ascending → last write per day wins = daily close
        for (const p of t.prices) m.set(toDay(p.timestamp), +p.price)
        maps.set(t.address.toLowerCase(), m)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      /* leave these tokens unpriced; buildRows will skip the affected pools */
    }
  })
  return maps
}

/**
 * An empty snapshot list is treated as RETRYABLE.
 *
 * Under load this API does not answer a snapshot query with 429 — it answers
 * HTTP 200 carrying an empty array, which sails straight past the retry-on-429
 * path and looks exactly like a pool that has no history. The scan then filed
 * those pools under "too little history" and published a table quietly missing
 * them: a run that lost 38 of 527 pools this way reported nothing unusual.
 *
 * Sampling 25 pools spread across the list, one at a time with 700ms between
 * requests, returned snapshots for 25 of 25 — a genuinely empty pool is rare
 * enough that retrying a few times costs little and recovers the throttled
 * ones. A pool that really has no snapshots still ends up empty, just slower.
 */
const SNAPSHOT_EMPTY_RETRIES = 3
async function fetchSnapshots(poolId, chain, { signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const data = await gql(
      `{ poolGetSnapshots(id: "${poolId.toLowerCase()}", chain: ${chain}, range: ALL_TIME) {
           timestamp totalShares amounts totalLiquidity fees24h } }`,
      { signal }
    )
    const snaps = data.poolGetSnapshots || []
    if (snaps.length || attempt >= SNAPSHOT_EMPTY_RETRIES) return snaps
    await sleep(700 * (attempt + 1))
  }
}

/**
 * Weave snapshots + prices into the daily rows series.js consumes.
 *
 * Gap handling: days with no snapshot mean no pool activity, so reserves and
 * supply are forward-filled exactly. A day is only emitted once EVERY token
 * has a price that day — which also bounds the series to the price range
 * that was fetched.
 */
function buildRows(tokens, snaps, priceMaps) {
  const symbols = tokens.map((t) => t.symbol)
  const perToken = tokens.map((t) => priceMaps.get(t.address) || new Map())
  if (perToken.some((m) => m.size === 0)) return { rows: [], missingPrices: true }
  // Underlying price series for boosted tokens; falls back to the token's own
  // series when it is not wrapped (then the two HODL bases coincide).
  const perUnder = tokens.map((t, i) => {
    const m = t.underlying ? priceMaps.get(t.underlying.address) : null
    return m && m.size ? m : perToken[i]
  })

  const byDay = new Map()
  let firstMs = Infinity
  let lastMs = -Infinity
  for (const s of snaps) {
    const ms = +s.timestamp * 1000
    // Some v2 snapshots carry an epoch-era timestamp (1970). Walking the
    // calendar from there would burn ~20k empty iterations per pool.
    if (ms < MIN_SNAPSHOT_MS) continue
    byDay.set(toDay(s.timestamp), {
      amounts: (s.amounts || []).map(Number),
      bpt: +s.totalShares,
      apiTvl: +s.totalLiquidity,
      fees: +s.fees24h || 0,
    })
    if (ms < firstMs) firstMs = ms
    if (ms > lastMs) lastMs = ms
  }
  if (!byDay.size) return { rows: [], missingPrices: false }

  const rows = []
  let state = null
  let underFallbackDays = 0
  for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10)
    const snap = byDay.get(day)
    // Reserves and supply are STATE: no snapshot means no activity, so
    // forward-filling them is exact. fees24h is a FLOW, and carrying it forward
    // re-counts the same income once per gap day — a pool that traded once and
    // then sat idle for a week booked that day's fees eight times.
    if (snap) state = snap
    else if (state && state.fees !== 0) state = { ...state, fees: 0 }
    if (!state || !(state.bpt > 0)) continue
    // tokens[i].idx points at the original slot, so filtering the pool's own
    // pre-minted BPT out of the basket does not shift the amounts mapping.
    const amounts = tokens.map((t) => state.amounts[t.idx])
    if (amounts.some((a) => a == null || !isFinite(a))) continue
    const prices = perToken.map((m) => m.get(day))
    if (prices.some((p) => p == null || !(p > 0))) continue
    // Missing an underlying price on a given day just means that day cannot
    // support the underlying basis; fall back so the wrapped basis still works.
    // The substitution is COUNTED, not silent: on a day that falls back, the
    // "underlying" leg is really the wrapped price, so an UNDERLYING figure
    // built mostly from fallbacks is the vault-token number wearing the wrong
    // label — and the reader was being told it was the plain USDC they
    // deposited.
    let fellBack = false
    const underPrices = perUnder.map((m, i) => {
      const v = m.get(day)
      if (v > 0) return v
      if (perUnder[i] !== perToken[i]) fellBack = true
      return prices[i]
    })
    if (fellBack) underFallbackDays++
    const tvl = amounts.reduce((a, amt, i) => a + amt * prices[i], 0)
    if (!(tvl > 0)) continue
    rows.push({
      day,
      symbols,
      amounts,
      prices,
      underPrices,
      bpt: state.bpt,
      tvl,
      apiTvl: state.apiTvl,
      fees: state.fees,
    })
  }
  // Share of days whose underlying leg is really the wrapped price. Above a
  // small fraction the UNDERLYING basis is not answerable for this pool.
  const underFallbackRate = rows.length ? underFallbackDays / rows.length : 0
  return { rows, missingPrices: false, underFallbackRate }
}

/**
 * Full daily series for ONE pool (detail view) — one year of prices.
 * Returns {rows, meta}.
 */
export async function fetchPoolSeries(poolId, chain, { force = false, meta } = {}) {
  const addr = poolId.toLowerCase()
  const KEY = `ar.series.v5.${chain}.${addr}`
  if (!force) {
    const hit = cacheGet(KEY)
    if (hit) return hit
  }
  const poolMeta = meta || (await fetchPoolMeta(addr, chain))
  const [snaps, priceMaps] = await Promise.all([
    fetchSnapshots(poolMeta.id || addr, chain),
    fetchChainPrices(chain, tokenPriceAddresses(poolMeta.tokens), PRICE_RANGE),
  ])
  const { rows, missingPrices } = buildRows(poolMeta.tokens, snaps, priceMaps)
  if (missingPrices) {
    throw new Error('No price history for one or more of this pool’s tokens.')
  }
  const out = { rows, meta: poolMeta }
  cacheSet(KEY, out)
  return out
}

/**
 * Scan many pools for the table. Prices are fetched once per chain (shared
 * across every pool on it) and snapshots per pool with bounded concurrency;
 * each pool is emitted through `onResult` the moment it resolves so the table
 * fills in progressively instead of blocking on the slowest chain.
 */
export async function scanPools(
  pools,
  { range = PRICE_RANGE, onResult, signal, concurrency = SNAPSHOT_CONCURRENCY, priceConcurrency = 2 } = {}
) {
  // Chains are processed one at a time (their price sets are large and the
  // API rate-limits bursts); pools within a chain share one price fetch.
  const byChain = new Map()
  for (const p of pools) {
    const set = byChain.get(p.chain) || new Set()
    for (const a of tokenPriceAddresses(p.tokens)) set.add(a)
    byChain.set(p.chain, set)
  }
  const pricePromises = new Map()
  for (const [chain, set] of byChain) {
    pricePromises.set(
      chain,
      fetchChainPrices(chain, [...set], range, { signal, concurrency: priceConcurrency }).catch(() => new Map())
    )
  }

  return mapLimit(pools, concurrency, async (pool) => {
    let result
    try {
      const [snaps, priceMaps] = await Promise.all([
        fetchSnapshots(pool.id || pool.address, pool.chain, { signal }),
        pricePromises.get(pool.chain),
      ])
      const { rows, missingPrices, underFallbackRate } = buildRows(pool.tokens, snaps, priceMaps)
      result = { pool, rows, underFallbackRate, error: missingPrices ? 'no price history' : null }
    } catch (e) {
      if (signal?.aborted) throw e
      result = { pool, rows: [], error: e.message || 'failed' }
    }
    onResult?.(result)
    return result
  })
}
