# LP vs HODL — every Balancer v3 pool

A dashboard that answers one question for **any Balancer v3 pool** on any chain, of any type
(Stable, Weighted, AutoRange/reCLAMM, E-CLP/Gyro, QuantAMM) and any number of tokens: over
the last 30 / 90 / 180 days, would you have had more value **providing liquidity** or just
**holding the tokens** you would have deposited?

The landing page is a sortable, filterable **table of every pool** so the answer is scannable
at a glance. Click any row — or paste a `balancer.fi` pool link — for the full chart.

Live: https://marcusblabs.github.io/autorange-lp-vs-hodl-dashboard/

## Data

Everything comes from the official **Balancer API** (`api-v3.balancer.fi/graphql`) — no API
key, no backend:

- `poolGetPools` (protocol version 3, all chains, TVL ≥ $1k) — the pool universe, ~174 pools.
- `poolGetSnapshots` — per-day token reserves and BPT total supply.
- `tokenGetHistoricalPrices` — daily USD closes for every token in the pool (same source as
  the TVL figures, so both legs are marked consistently).

### Why the table is precomputed

A full client-side scan needs ~200 requests (one snapshot call per pool plus batched price
calls). The API sits behind Cloudflare and starts returning **HTTP 429** partway through — an
early live-scan attempt silently lost 126 of 174 pools. Worse, a throttled response carries no
CORS headers, so the browser surfaces it as an opaque `Failed to fetch` rather than a status
you can back off on.

So [`scripts/scan.mjs`](scripts/scan.mjs) precomputes the whole table into `public/scan.json`
(~70 KB) with low concurrency and 429 backoff, run nightly by CI. The underlying data is daily
snapshots, so a nightly rebuild is exactly as fresh as the source — and visitors load a single
static file. Drilling into one pool still fetches live (a handful of requests), reusing the
same modules so the chart and the row it came from are computed identically.

Live per-pool responses are cached in `sessionStorage` for 10 minutes.

### Trust guard: TVL reconciliation

Every pool's reconstructed TVL (Σ reserve×price) is checked against the API's own reported TVL
day by day. A pool is dropped unless ≥95% of its days agree within 5% **and** at least half its
days are verifiable at all.

That second clause matters: a $260M stable pool reported a nonsensical **−272% / −1423%**
because one token's price feed drifted 373× across the window — and it slipped through an
earlier version of this check, since `totalLiquidity` was missing from every one of its
snapshots and a guard that only tested days with data had nothing to compare. Absence of
evidence is not a pass; the check fails closed.

## Method

- **LP leg** — `value_per_share(t) = Σᵢ(amountᵢ·priceᵢ) / BPT_totalSupply(t)` from the API's
  daily snapshots. Balancer BPTs are fungible and liquidity operations are proportional, so
  this single number already nets swap fees, impermanent loss, and (for reCLAMM, whose range
  shifts *virtually and in-protocol* — no keeper, no LP-borne gas) the LVR cost of
  auto-ranging.
- **HODL leg** — the deposited basket. At the window's entry day the composition per share is
  `(amountᵢ/bpt)` for every token; it's held forward and marked with the *same* daily prices.
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

### Yield vs incentives — an important distinction

- **Yield-bearing (boosted) tokens** — `IB_YIELD`, e.g. `waEthUSDC`. Both the LP *and* the
  holder hold the same wrapped token, so the underlying yield lifts **both legs equally and
  cancels out of LP − HODL**. Boosting can never make LPing beat holding on its own. Shown as
  a column for context only.
- **External incentives** — `MERKL` / `STAKING`. These go to liquidity providers *only* and
  never touch the pool's reserves, so they are **not** in value-per-share. Pools that pay them
  are tagged `+rewards`; their true LP result is better than the columns show.

### Caveats

- External gauge/Merkl incentives are **not** added; where they exist they would lift the LP leg.
- Very small / very young pools are noisy.
- reCLAMM pools were suspended 2026-02-20 and relaunched ~2026-05-19 on fresh (v3-tagged)
  contracts, so the "historical" cohort is frozen at Feb 2026 and the "live" cohort has short
  history.
- `tokenGetHistoricalPrices` is capped at one year back; fine while every reCLAMM is younger
  than that (oldest: 2025-07-31) — revisit mid-2026.

## Run

```bash
npm install
npm run scan     # refresh public/scan.json (~10-15 min, polite to the API)
npm run dev      # http://localhost:3000
npm run build
npm run deploy   # gh-pages -d dist
```

CI ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) reruns the scan nightly and
redeploys. If the scan fails it keeps the committed `scan.json` rather than shipping an empty
table.

Built with React + Vite. Styling mirrors [balancer.defilytica.com](https://balancer.defilytica.com).
