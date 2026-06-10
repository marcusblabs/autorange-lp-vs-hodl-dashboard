// Static configuration for the AutoRange (reCLAMM) LP-vs-HODL dashboard.
//
// The pool list, daily snapshots and USD prices all come live from the
// official Balancer API (see lib/balancer.js). What remains here is the
// window set, curated pools the API list no longer carries, a fallback
// list for when the list call fails, and external link builders.

export const CHAIN = 'ethereum'

export const WINDOWS = [1, 7, 14, 30, 60, 90, 180]

// Pools the API has delisted from poolGetPools but whose snapshots are
// still queryable — kept selectable for the historical record.
export const EXTRA_POOLS = [
  { address: '0x971de8d629225b766ea924b8719acd2657c631ba', label: 'GHO / WETH', version: 2, tvl: 0 },
]

// Shown only if the live pool-list call fails outright.
export const FALLBACK_POOLS = [
  { address: '0xb47aec7f043d4c34f76990443e5ee44e54970070', label: 'USDC / USDT', version: 3, tvl: 0 },
  { address: '0xda66e8ddf9959e4db759bfd06256730d8a8b2d13', label: 'USDC / WETH', version: 3, tvl: 0 },
  { address: '0x9d1fcf346ea1b073de4d5834e25572cc6ad71f4d', label: 'AAVE / WETH', version: 2, tvl: 0 },
  { address: '0x971de8d629225b766ea924b8719acd2657c631ba', label: 'GHO / WETH', version: 2, tvl: 0 },
]

// Independent event-replay reconstruction of the same daily state, kept as
// a methodology cross-check (it overstates reserves by the uncollected
// protocol-fee skim — documented in the README).
export const DUNE_QUERY_ID = '7649043'
export const DUNE_QUERY_URL = `https://dune.com/queries/${DUNE_QUERY_ID}`

export const EXPLORER_ADDR = (a) => `https://etherscan.io/address/${a}`
export const BALANCER_POOL_URL = (a) => `https://balancer.fi/pools/ethereum/v3/${a}`
