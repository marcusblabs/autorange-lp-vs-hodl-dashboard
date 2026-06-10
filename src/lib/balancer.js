/**
 * Balancer official API (api-v3.balancer.fi) — the data backbone.
 *
 * Pool list, daily snapshots (reserves + BPT supply) and historical USD
 * prices all come from the same free GraphQL endpoint. No API key, no
 * execute/poll round-trips, CORS open to any origin.
 *
 * Why snapshots and not event replay: the API's snapshots come from the
 * official subgraph, whose reserves already exclude the aggregate
 * (protocol + creator) fee skim. Replaying Vault events overstates
 * reserves by the uncollected skim — small while supply is large, but it
 * produces a fake +22% value-per-share jump across the Feb-2026
 * suspension exits (verified on AAVE/WETH). The Dune query in query/ is
 * kept as an independent cross-check of that effect.
 */

const API = 'https://api-v3.balancer.fi/graphql'
const TTL_MS = 10 * 60 * 1000 // session cache: fresh enough for daily data
const DAY_MS = 86400000

async function gql(query) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`Balancer API ${res.status}: ${res.statusText}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(`Balancer API: ${json.errors[0].message}`)
  return json.data
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

/** Every reCLAMM pool the API lists on Ethereum mainnet, TVL-sorted. */
export async function fetchReclammPools({ force = false } = {}) {
  const KEY = 'ar.pools.v2'
  if (!force) {
    const hit = cacheGet(KEY)
    if (hit) return hit
  }
  const data = await gql(`{
    poolGetPools(where: {chainIn: [MAINNET], poolTypeIn: [RECLAMM]},
                 orderBy: totalLiquidity, orderDirection: desc) {
      address version
      dynamicData { totalLiquidity totalShares }
      poolTokens { symbol }
    }
  }`)
  const pools = (data.poolGetPools || [])
    .filter((p) => +p.dynamicData?.totalShares > 0)
    .map((p) => ({
      address: p.address.toLowerCase(),
      label: p.poolTokens.map((t) => t.symbol).join(' / '),
      version: p.version,
      tvl: +p.dynamicData.totalLiquidity || 0,
    }))
  cacheSet(KEY, pools)
  return pools
}

const toDay = (tsSec) => new Date(+tsSec * 1000).toISOString().slice(0, 10)

/**
 * Daily raw-state rows for one pool, same shape the old Dune query
 * returned: {day, sym0, sym1, res0, res1, bpt, price0, price1, tvl_usd}.
 *
 * Gap handling: days with no snapshot mean no pool activity, so reserves
 * and supply are forward-filled exactly; prices exist for every day.
 * tokenGetHistoricalPrices is capped at ONE_YEAR — fine while every
 * reCLAMM is younger than that (oldest: 2025-07-31); revisit mid-2026.
 */
export async function fetchPoolSeries(address, { force = false } = {}) {
  const addr = address.toLowerCase()
  const KEY = 'ar.series.v2.' + addr
  if (!force) {
    const hit = cacheGet(KEY)
    if (hit) return hit
  }

  const meta = await gql(`{
    poolGetPool(id: "${addr}", chain: MAINNET) {
      type poolTokens { index address symbol }
    }
  }`)
  const pool = meta.poolGetPool
  if (!pool) throw new Error('Pool not found on Ethereum mainnet.')
  if (pool.type !== 'RECLAMM') {
    throw new Error(`Not an AutoRange (reCLAMM) pool — the Balancer API reports type ${pool.type}.`)
  }
  const toks = [...pool.poolTokens].sort((a, b) => a.index - b.index)
  if (toks.length !== 2) throw new Error('Expected a 2-token reCLAMM pool.')

  const [snapData, pxData] = await Promise.all([
    gql(`{
      poolGetSnapshots(id: "${addr}", chain: MAINNET, range: ALL_TIME) {
        timestamp totalShares amounts
      }
    }`),
    gql(`{
      tokenGetHistoricalPrices(
        addresses: ["${toks[0].address}", "${toks[1].address}"],
        chain: MAINNET, range: ONE_YEAR
      ) { address prices { timestamp price } }
    }`),
  ])

  // Per-token day → closing price (last point of each UTC day).
  const px = new Map()
  for (const t of pxData.tokenGetHistoricalPrices || []) {
    const m = new Map()
    for (const p of t.prices) m.set(toDay(p.timestamp), +p.price) // ascending → last wins
    px.set(t.address.toLowerCase(), m)
  }
  const px0 = px.get(toks[0].address.toLowerCase()) || new Map()
  const px1 = px.get(toks[1].address.toLowerCase()) || new Map()

  // Snapshot day → state, then walk the calendar forward-filling gaps.
  const snaps = new Map()
  let firstMs = Infinity
  let lastMs = -Infinity
  for (const s of snapData.poolGetSnapshots || []) {
    const ms = +s.timestamp * 1000
    snaps.set(toDay(s.timestamp), { res0: +s.amounts[0], res1: +s.amounts[1], bpt: +s.totalShares })
    if (ms < firstMs) firstMs = ms
    if (ms > lastMs) lastMs = ms
  }
  if (!snaps.size) return []

  const rows = []
  let state = null
  for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10)
    state = snaps.get(day) || state
    const price0 = px0.get(day)
    const price1 = px1.get(day)
    if (!state || !(state.bpt > 0) || price0 == null || price1 == null) continue
    rows.push({
      day,
      sym0: toks[0].symbol,
      sym1: toks[1].symbol,
      res0: state.res0,
      res1: state.res1,
      bpt: state.bpt,
      price0,
      price1,
      tvl_usd: state.res0 * price0 + state.res1 * price1,
    })
  }

  cacheSet(KEY, rows)
  return rows
}
