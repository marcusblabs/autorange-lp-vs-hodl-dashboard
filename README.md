# AutoRange — LP vs HODL

A dashboard that answers one question for any Balancer v3 **AutoRange (reCLAMM)** pool on
any chain: over the last 1 / 7 / 14 / 30 / 60 / 90 / 180 days, would you have had more value
**providing liquidity** or just **holding the two tokens**?

Live: https://marcusblabs.github.io/autorange-lp-vs-hodl-dashboard/

## Data

Everything loads live from the official **Balancer API** (`api-v3.balancer.fi/graphql`) —
no API key, no backend:

- `poolGetPools` (type `RECLAMM`, all chains) — the selectable pool list, TVL-sorted and
  refreshed on every visit. Only **live** pools are listed: contract `version >= 3` (the
  May-2026 relaunch generation — every v1/v2 pool has had zero volume since the Feb-2026
  suspension) with TVL above a $50 dust floor (drops seeded-then-drained test pools).
  Deprecated/historical pools stay reachable through the custom-address input, which
  resolves the chain automatically via an `idIn` lookup.
- `poolGetSnapshots` — per-day token reserves and BPT total supply for the selected pool.
- `tokenGetHistoricalPrices` — daily USD closes for the two tokens (same source as the TVL
  figures, so both legs are marked consistently).

Responses are cached in `sessionStorage` for 10 minutes, so switching back and forth between
pools is instant.

## Method

- **LP leg** — `value_per_share(t) = (res0·p0 + res1·p1) / BPT_totalSupply(t)` from the API's
  daily snapshots. Because reCLAMM is a fungible-BPT, proportional-liquidity pool whose range
  shifts *virtually and in-protocol* (no keeper, no LP-borne gas), this single number already
  nets swap fees, impermanent loss, and the LVR cost of auto-ranging.
- **HODL leg** — the deposited basket. At the window's entry day the composition per share is
  `(res0/bpt, res1/bpt)`; it's held forward and marked with the *same* daily prices.
- Both legs are indexed to 100 at entry, so the gap between them is the LP's fee-minus-LVR result.
- Days without a snapshot mean no pool activity; reserves and supply are forward-filled exactly.
- A trailing run of ≥10 days without trading is trimmed. "No trading" is detected on per-share
  composition (`res/bpt`): proportional add/remove — the only liquidity ops reCLAMM allows,
  including post-suspension exits — leaves it unchanged, while any swap shifts it. A frozen pool
  earns no fees and pays no LVR, so the tail carries no information.
- Supply-collapse guard: the series is cut where BPT supply falls below 1e-6 of its running max.
  A pool drained to dust shares makes value-per-share degenerate (a seeded-then-drained test pool
  showed a 2.5e15× fake "LP return"); real mass exits never go that deep (the Feb-2026
  withdrawal left 0.9% of max supply).

### Why snapshots, not event replay

Reserves replayed from Vault `Swap`/`LiquidityAdded`/`LiquidityRemoved` events overstate the
pool's true balances by the uncollected **aggregate (protocol + creator) fee skim** — in v3 the
skim is deducted from pool accounting at swap time but never appears as an event. The error is
small while supply is large (~0.2% on AAVE/WETH), but it produces a fake **+22% value-per-share
jump** across the Feb-2026 suspension exits, when 99% of supply left and the phantom reserves
concentrated on the remainder. The API's subgraph-backed snapshots are continuous through the
same exits (597.5 → 599.6), which is the physically correct behaviour for proportional
withdrawals.

The event-replay reconstruction is kept as an independent cross-check:
[Dune #7649043](https://dune.com/queries/7649043) (source in [`query/`](query/)).

### Caveats

- Gauge incentives are **not** added; where they exist they would lift the LP leg.
- Very small / very young pools are noisy.
- reCLAMM pools were suspended 2026-02-20 and relaunched ~2026-05-19 on fresh (v3-tagged)
  contracts, so the "historical" cohort is frozen at Feb 2026 and the "live" cohort has short
  history.
- `tokenGetHistoricalPrices` is capped at one year back; fine while every reCLAMM is younger
  than that (oldest: 2025-07-31) — revisit mid-2026.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm run deploy   # gh-pages -d dist
```

Built with React + Vite. Styling mirrors [balancer.defilytica.com](https://balancer.defilytica.com).
