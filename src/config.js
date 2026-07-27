// Static configuration for the AutoRange (reCLAMM) LP-vs-HODL dashboard.
//
// The pool list, daily snapshots and USD prices all come live from the
// official Balancer API (see lib/balancer.js), across every chain
// Balancer v3 runs on. What remains here is the window set, a fallback
// list for when the list call fails, chain metadata for labels/links,
// and the Dune cross-check pointer.

export const WINDOWS = [1, 7, 14, 30, 60, 90, 180]

// Precomputed scan table (scripts/scan.mjs → public/scan.json, refreshed
// nightly by CI). Served from the app's own base path so it works both at the
// dev root and under the GitHub Pages subpath.
// Optional chaining because scripts/scan.mjs pulls this module into plain
// Node (for EXCLUDED_CHAINS), where Vite's import.meta.env does not exist.
export const SCAN_URL = `${import.meta.env?.BASE_URL ?? '/'}scan.json`

// Per-chain display name, Balancer UI slug, and explorer address URL.
// Chains without an entry fall back to the Balancer pool page only.
export const CHAIN_INFO = {
  MAINNET: { name: 'Ethereum', slug: 'ethereum', explorer: 'https://etherscan.io/address/' },
  ARBITRUM: { name: 'Arbitrum', slug: 'arbitrum', explorer: 'https://arbiscan.io/address/' },
  BASE: { name: 'Base', slug: 'base', explorer: 'https://basescan.org/address/' },
  GNOSIS: { name: 'Gnosis', slug: 'gnosis', explorer: 'https://gnosisscan.io/address/' },
  OPTIMISM: { name: 'Optimism', slug: 'optimism', explorer: 'https://optimistic.etherscan.io/address/' },
  AVALANCHE: { name: 'Avalanche', slug: 'avalanche', explorer: 'https://snowtrace.io/address/' },
  SONIC: { name: 'Sonic', slug: 'sonic', explorer: 'https://sonicscan.org/address/' },
  HYPEREVM: { name: 'HyperEVM', slug: 'hyperevm', explorer: 'https://hyperevmscan.io/address/' },
  MONAD: { name: 'Monad', slug: 'monad', explorer: 'https://monadexplorer.com/address/' },
  PLASMA: { name: 'Plasma', slug: 'plasma', explorer: 'https://plasmascan.to/address/' },
  // v2 reaches several chains v3 never shipped on.
  POLYGON: { name: 'Polygon', slug: 'polygon', explorer: 'https://polygonscan.com/address/' },
  FANTOM: { name: 'Fantom', slug: 'fantom', explorer: 'https://ftmscan.com/address/' },
  ZKEVM: { name: 'zkEVM', slug: 'zkevm', explorer: 'https://zkevm.polygonscan.com/address/' },
  XLAYER: { name: 'X Layer', slug: 'xlayer', explorer: 'https://www.oklink.com/xlayer/address/' },
}

// Chains deliberately left out of the scan. SEPOLIA is a testnet; the rest are
// excluded by choice. Applied server-side via the `chainNotIn` filter.
export const EXCLUDED_CHAINS = ['SONIC', 'MODE', 'FRAXTAL', 'SEPOLIA']

export const chainName = (c) => CHAIN_INFO[c]?.name || c

// Short codes for dense table cells, matching the Pool Explorer's style.
export const CHAIN_SHORT = {
  MAINNET: 'ETH', ARBITRUM: 'ARB', BASE: 'BASE', GNOSIS: 'GNO', OPTIMISM: 'OP',
  AVALANCHE: 'AVAX', MONAD: 'MON', PLASMA: 'PLAS', HYPEREVM: 'HYPE',
  SONIC: 'SONIC', POLYGON: 'POLY', ZKEVM: 'ZKEVM', FRAXTAL: 'FRAX', MODE: 'MODE',
}
export const chainShort = (c) => CHAIN_SHORT[c] || String(c).slice(0, 4)
// balancer.fi routes by protocol: v3 by address, v2 by the full 32-byte pool
// id, CoW AMM (v1) under /cow/. Linking a v2 pool as /v3/<address> 404s.
export const BALANCER_POOL_URL = (chain, idOrAddress, protocolVersion = 3) => {
  const slug = CHAIN_INFO[chain]?.slug || String(chain).toLowerCase()
  const seg = protocolVersion === 1 ? 'cow' : protocolVersion === 2 ? 'v2' : 'v3'
  return `https://balancer.fi/pools/${slug}/${seg}/${idOrAddress}`
}
export const EXPLORER_ADDR = (chain, a) =>
  CHAIN_INFO[chain]?.explorer ? CHAIN_INFO[chain].explorer + a : BALANCER_POOL_URL(chain, a)

// Shown only if the live pool-list call fails outright.
export const FALLBACK_POOLS = [
  { address: '0x27da8a34579fbc99319af1c1a0f0d51065084576', chain: 'MONAD', label: 'USDC / DUST', version: 3, tvl: 0 },
  { address: '0xb47aec7f043d4c34f76990443e5ee44e54970070', chain: 'MAINNET', label: 'USDC / USDT', version: 3, tvl: 0 },
  { address: '0xda66e8ddf9959e4db759bfd06256730d8a8b2d13', chain: 'MAINNET', label: 'USDC / WETH', version: 3, tvl: 0 },
]

// Independent event-replay reconstruction of the same daily state on
// Ethereum, kept as a methodology cross-check (it overstates reserves by
// the uncollected protocol-fee skim — documented in the README).
export const DUNE_QUERY_ID = '7649043'
export const DUNE_QUERY_URL = `https://dune.com/queries/${DUNE_QUERY_ID}`
