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

const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
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
                   where: {protocolVersionIn: [3], minTvl: ${SCAN_MIN_TVL_USD},
                           chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                           tagNotIn: ["BLACK_LISTED"]}) {
        address chain type version name
        dynamicData { totalLiquidity swapFee aprItems { title apr type } }
        poolTokens { index address symbol weight }
      }
    }`),
    gql(`{
      poolGetPools(first: 1000, where: {protocolVersionIn: [3], minTvl: ${SCAN_MIN_TVL_USD}, chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                                        reviewedOnly: true}) { address }
    }`),
    gql(`{
      poolGetPools(first: 1000, where: {protocolVersionIn: [3], minTvl: ${SCAN_MIN_TVL_USD}, chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
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
      address: p.address.toLowerCase(),
      chain: p.chain,
      type: p.type,
      version: p.version,
      name: p.name,
      label: tokens.map((t) => t.symbol).join(' / '),
      tvl: +p.dynamicData?.totalLiquidity || 0,
      swapFee: +p.dynamicData?.swapFee || 0,
      yieldApr,
      incentiveApr,
      tokens: tokens.map((t) => ({
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        weight: t.weight == null ? null : +t.weight,
      })),
      // Balancer looked at the contract. It does NOT imply the price feed is
      // sane — several reviewed pools carry 100x+ oracle drift.
      reviewed: reviewed.has(p.address.toLowerCase()),
    }
  })
  const out = { pools: list, blacklistedCount, excludedChains: EXCLUDED_CHAINS }
  cacheSet(KEY, out)
  return out
}

/** Find which chain a pool address lives on (any version, any chain). */
export async function resolvePool(address) {
  const addr = address.toLowerCase()
  const data = await gql(`{
    poolGetPools(where: {idIn: ["${addr}"]}) { address chain type version name }
  }`)
  const hit = (data.poolGetPools || []).find((p) => p.address.toLowerCase() === addr)
  return hit
    ? { chain: hit.chain, type: hit.type, version: hit.version, name: hit.name }
    : null
}

/** Pool metadata + ordered tokens for a single pool. */
export async function fetchPoolMeta(address, chain) {
  const addr = address.toLowerCase()
  const data = await gql(`{
    poolGetPool(id: "${addr}", chain: ${chain}) {
      type name
      dynamicData { totalLiquidity swapFee aprItems { title apr type } }
      poolTokens { index address symbol weight }
    }
  }`)
  const p = data.poolGetPool
  if (!p) throw new Error(`Pool not found on ${chain}.`)
  const tokens = [...p.poolTokens].sort((a, b) => a.index - b.index)
  const { yieldApr, incentiveApr } = summarizeAprs(p.dynamicData?.aprItems)
  return {
    address: addr,
    chain,
    type: p.type,
    name: p.name,
    label: tokens.map((t) => t.symbol).join(' / '),
    tvl: +p.dynamicData?.totalLiquidity || 0,
    swapFee: +p.dynamicData?.swapFee || 0,
    yieldApr,
    incentiveApr,
    tokens: tokens.map((t) => ({
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      weight: t.weight == null ? null : +t.weight,
    })),
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

async function fetchSnapshots(address, chain, { signal } = {}) {
  const data = await gql(
    `{ poolGetSnapshots(id: "${address.toLowerCase()}", chain: ${chain}, range: ALL_TIME) {
         timestamp totalShares amounts totalLiquidity fees24h } }`,
    { signal }
  )
  return data.poolGetSnapshots || []
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

  const byDay = new Map()
  let firstMs = Infinity
  let lastMs = -Infinity
  for (const s of snaps) {
    const ms = +s.timestamp * 1000
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
  for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10)
    state = byDay.get(day) || state
    if (!state || !(state.bpt > 0)) continue
    if (state.amounts.length !== tokens.length) continue
    const prices = perToken.map((m) => m.get(day))
    if (prices.some((p) => p == null || !(p > 0))) continue
    const tvl = state.amounts.reduce((a, amt, i) => a + amt * prices[i], 0)
    if (!(tvl > 0)) continue
    rows.push({
      day,
      symbols,
      amounts: state.amounts,
      prices,
      bpt: state.bpt,
      tvl,
      apiTvl: state.apiTvl,
      fees: state.fees,
    })
  }
  return { rows, missingPrices: false }
}

/**
 * Full daily series for ONE pool (detail view) — one year of prices.
 * Returns {rows, meta}.
 */
export async function fetchPoolSeries(address, chain, { force = false, meta } = {}) {
  const addr = address.toLowerCase()
  const KEY = `ar.series.v4.${chain}.${addr}`
  if (!force) {
    const hit = cacheGet(KEY)
    if (hit) return hit
  }
  const poolMeta = meta || (await fetchPoolMeta(addr, chain))
  const [snaps, priceMaps] = await Promise.all([
    fetchSnapshots(addr, chain),
    fetchChainPrices(chain, poolMeta.tokens.map((t) => t.address), 'ONE_YEAR'),
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
  { range = 'ONE_HUNDRED_EIGHTY_DAY', onResult, signal, concurrency = SNAPSHOT_CONCURRENCY, priceConcurrency = 2 } = {}
) {
  // Chains are processed one at a time (their price sets are large and the
  // API rate-limits bursts); pools within a chain share one price fetch.
  const byChain = new Map()
  for (const p of pools) {
    const set = byChain.get(p.chain) || new Set()
    for (const t of p.tokens) set.add(t.address)
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
        fetchSnapshots(pool.address, pool.chain, { signal }),
        pricePromises.get(pool.chain),
      ])
      const { rows, missingPrices } = buildRows(pool.tokens, snaps, priceMaps)
      result = { pool, rows, error: missingPrices ? 'no price history' : null }
    } catch (e) {
      if (signal?.aborted) throw e
      result = { pool, rows: [], error: e.message || 'failed' }
    }
    onResult?.(result)
    return result
  })
}
