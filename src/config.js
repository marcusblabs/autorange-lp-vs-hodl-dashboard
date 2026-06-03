// Static configuration for the AutoRange (reCLAMM) LP-vs-HODL dashboard.
//
// One saved Dune query returns the per-day raw state (reserves, BPT supply,
// USD prices, TVL) for a single Ethereum reCLAMM pool, parameterized by the
// pool address. The HODL counterfactual and the 1d–180d window indexing are
// computed client-side from that raw state (see lib/series.js).

function normalizeQueryId(value) {
  if (!value) return ''
  const raw = String(value).trim()
  const urlMatch = raw.match(/\/queries\/(\d+)(?:\/|$)/i)
  return urlMatch ? urlMatch[1] : raw
}

// Saved Dune query — https://dune.com/queries/7649043
export const DUNE_QUERY_ID =
  normalizeQueryId(import.meta.env.VITE_DUNE_QUERY_ID) || '7649043'

export const CHAIN = 'ethereum'

// Featured reCLAMM pools on Ethereum. `cohort` is informational:
//   'historical' — full life, frozen at the Feb-2026 suspension
//   'live'       — relaunched on fresh contracts ~May 2026, trading now
// Any other reCLAMM pool works too via the "custom address" input.
export const POOLS = [
  { address: '0x9d1fcf346ea1b073de4d5834e25572cc6ad71f4d', label: 'AAVE / WETH', cohort: 'historical' },
  { address: '0x971de8d629225b766ea924b8719acd2657c631ba', label: 'GHO / WETH', cohort: 'historical' },
  { address: '0xda66e8ddf9959e4db759bfd06256730d8a8b2d13', label: 'USDC / WETH', cohort: 'live' },
  { address: '0xb47aec7f043d4c34f76990443e5ee44e54970070', label: 'USDC / USDT', cohort: 'live' },
]

export const WINDOWS = [1, 7, 14, 30, 60, 90, 180]

export const EXPLORER_ADDR = (a) => `https://etherscan.io/address/${a}`
export const BALANCER_POOL_URL = (a) => `https://balancer.fi/pools/ethereum/v3/${a}`
export const DUNE_QUERY_URL = `https://dune.com/queries/${DUNE_QUERY_ID}`
