# LP vs HODL — every Balancer pool

A dashboard that answers one question for **any Balancer pool** — protocol v1, v2 and v3, on
every chain, of any type (Stable, Weighted, Composable Stable, AutoRange/reCLAMM, E-CLP/Gyro,
QuantAMM, CoW AMM) and any number of tokens: over the last 30 / 90 / 180 days, would you have
had more value **providing liquidity** or just **holding the tokens** you would have deposited?

The landing page is a sortable, filterable **table of every pool** so the answer is scannable
at a glance — filters for chain, pool type, min TVL and status, plus CSV export, matching the
[Pool Explorer](https://marcusblabs.github.io/balancer-pool-explorer/). Click any row — or paste
a `balancer.fi` pool link — for the full chart.

Columns run **30d / 90d / 180d / Full**. The Full (whole-life) column matters because many pools
are younger than 30 days — every relaunched AutoRange pool is — so the fixed windows are blank
for them and Full is the only figure they can report.

Live: https://marcusblabs.github.io/autorange-lp-vs-hodl-dashboard/

## Data

Everything comes from the official **Balancer API** (`api-v3.balancer.fi/graphql`) — no API
key, no backend:

- `poolGetPools` (protocol versions 1–3, TVL ≥ $1k) — the pool universe. v2 is the larger half:
  376 pools / $31M TVL against v3's 143 / $25M, and the single biggest pool anywhere
  (`20wstETH-80AAVE`, $13M) is v2.
  - **Balancer's own blacklist** is applied at source (`tagNotIn: ["BLACK_LISTED"]`). It is the
    front end's curation and is strictly better than any heuristic for what it covers — test
    pools, dust, and token families with known-bad feeds. It caught 13 pools our data checks
    missed, several above $1M TVL. It is *not* a superset though: most pools we flag for
    implausible prices are not blacklisted, and several are explicitly `reviewedOnly` yet carry
    133× oracle drift. Reviewed means the contract was looked at, not that the oracle is sane —
    so both filters run.
  - Sonic, Mode, Fraxtal and the Sepolia testnet are excluded via `chainNotIn`.
  - Caveat: the `categories` field **cannot be selected** — the server returns values (e.g.
    `POINTS_MAINSTREET`) missing from its own published enum, so GraphQL fails to serialise the
    response. The `tagIn` / `tagNotIn` filters work fine.
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

### v2 quirks worth knowing

- **v2 pools are keyed by `id`, not `address`.** A v2 id is 32 bytes (address + nonce), and
  `poolGetPool` / `poolGetSnapshots` match on it. Querying a v2 pool by its address returns
  **zero snapshots silently** rather than erroring — which looks exactly like "no data". A
  pasted v2 link carries the full id, so the paste box matches 64 hex chars before 40.
- **Composable-stable pools pre-mint their own BPT** and hold ~2.6e15 of it as a pool token.
  It is phantom, not liquidity: it is dropped from the basket. `totalShares` is already the
  *circulating* supply, so it must **not** also be reduced — doing that sends it negative.
- **Some v2 snapshots carry epoch-era timestamps** (1970). Walking the calendar from there
  would burn ~20k empty iterations per pool, so snapshots before 2020 are ignored.
- Old linear-pool BPTs (`bb-a-WETH`, `bb-euler-USD`) have no price series, so a handful of
  legacy composable-stable pools are skipped for want of prices.

### Annualised column

`APR` is the **annualised out/under-performance against holding**, compounded:

```
(LP / HODL) ^ (365 / days) − 1
```

taken from the longest window with at least **14 days**. Both legs are indexed to 100 at entry,
so their ratio is the pure relative result — the tokens' own price moves are already divided out,
which is why the reference is the HODL leg rather than USD or a risk-free rate. It follows the
**vs** switch, so it annualises against vault tokens or underlying to match what you are reading.

It compounds the *ratio* rather than scaling the *difference* (`gap × 365/days`), because the two
legs grow multiplicatively. Short windows are excluded deliberately: raising a few days of noise
to the power of ~50 produces confident-looking nonsense. It is a realised rate, not a forecast.

### Trust guard: TVL reconciliation

Every pool's reconstructed TVL (Σ reserve×price) is checked against the API's own reported TVL
day by day. A pool is **flagged** — kept, but hidden behind the `SHOW` filter and labelled with
the reason — when fewer than **80%** of its checkable days agree within **5%**. Flagged pools are
not dropped; they are shown with a warning on the row and on the detail page, because a suspect
number a reader can inspect beats a silently missing one.

Coverage is a separate flag, not a precondition. A pool whose snapshots carry no `totalLiquidity`
at all has nothing to reconcile, and an earlier version of this guard let exactly that case
through unflagged — a $260M stable pool reported a nonsensical **−272% / −1423%** because one
token's price feed drifted 373× across the window, with `totalLiquidity` missing from every
snapshot so the check had nothing to compare. It now flags **"largely unverified"** whenever
under half the days are checkable. Absence of evidence is not evidence of agreement.

## Method

- **LP leg** — `value_per_share(t) = Σᵢ(amountᵢ·priceᵢ) / BPT_totalSupply(t)` from the API's
  daily snapshots. Balancer BPTs are fungible and liquidity operations are proportional, so
  this single number already nets swap fees, impermanent loss, and (for reCLAMM, whose range
  shifts *virtually and in-protocol* — no keeper, no LP-borne gas) the LVR cost of
  auto-ranging.
- **HODL leg** — the deposited basket. At the window's entry day the composition per share is
  `(amountᵢ/bpt)` for every token; it's held forward and marked with the *same* daily prices.
- Both legs are indexed to 100 at entry, so the gap between them is the LP's fee-minus-LVR result.
- **Fee return** — `Σₜ (fees24hₜ / bptₜ) / vps₀`, the sum of each day's fees *per share*, in the
  same units as the gap. Not `Σfees / mean(TVL)`, which is a TVL-*weighted* mean of daily yield
  and agrees with the truth only when daily fee yield happens to be constant. A pool earning
  $500/day that takes a 10× deposit bringing no extra volume reported **1.92%** where the answer
  is **2.47%** — and since drag = gap − fees, every point lost there was silently reattributed to
  "impermanent loss / LVR". The entry day's `fees24h` is excluded: it accrued in the 24h *before*
  entry. These fees are **gross** of the protocol/creator skim while the LP leg is already net of
  it, so the drag reads slightly more negative than pure divergence.
- Days without a snapshot mean no pool activity; reserves and supply are forward-filled exactly —
  but `fees24h` is **not**, because it is a flow rather than state. Carrying it forward re-counted
  the same income once per gap day.
- **Prices use the `ONE_YEAR` range, deliberately, not `ALL`.** `ALL` looks better on every
  surface measurement — back to 2023 rather than 12 months, exactly one point per day at 00:00 UTC
  (matching how snapshots are stamped) instead of ~7.4 intraday ticks, smaller and faster. It is
  also **unusable**: it rounds prices to two decimal places.

  | token | `ALL` | `ONE_YEAR` |
  |---|---|---|
  | SHIB | **0** (all 1,245 points) | 0.00000492 |
  | BAL | **0.12** | 0.114176 — a 5.1% error |
  | WETH | 1868 | 1909.11 |

  Every token under half a cent comes back as zero, and `buildRows` needs a positive price per
  token, so those pools produce no rows and disappear from the table — 38 of 527 did. Every other
  low-priced token is quantised, corrupting value-per-share wherever it is held. A run on `ALL`
  put 191 pools into TVL-reconciliation failure; that was this, not the longer history it first
  looked like.

  The cost of `ONE_YEAR` is stated rather than hidden: the series cannot exceed ~365 days, so the
  column is labelled **FULL ≤1Y** — for a pool older than a year it is the last 12 months, not a
  lifetime, which is true of roughly half the table. Days are bucketed last-write-wins across the
  intraday ticks, which for a *completed* day is consistently its final tick (a stable daily
  close); the in-progress day, where that genuinely was unstable, is dropped.
- A trailing run of ≥10 days without trading is trimmed. "No trading" is detected on per-share
  composition (`res/bpt`): proportional add/remove — the only liquidity ops reCLAMM allows,
  including post-suspension exits — leaves it unchanged, while any swap shifts it. A frozen pool
  earns no fees and pays no LVR, so the tail carries no information.
- Supply-collapse guard: the series is cut where BPT supply falls below 1e-6 of its running max.
  A pool drained to dust shares makes value-per-share degenerate (a seeded-then-drained test pool
  showed a 2.5e15× fake "LP return"); real mass exits never go that deep (the Feb-2026
  withdrawal left 0.9% of max supply).
- **The series ends on the last completed UTC day.** Today's snapshot covers only the hours
  elapsed so far — its reserves are mid-day, its `fees24h` is partial, and its price is whichever
  intraday tick arrived last. Including it makes the answer a function of *when you looked*: on
  2026-08-05 the AAVE/WETH reCLAMM read **+0.08%** to the nightly scan at 07:02 UTC, **−0.94%** to
  a browser that afternoon, and **−0.85%** at 19:17 — same pool, same entry date, same day count.
  The table and the chart could not agree by construction. Dropping the in-progress day costs up
  to 24h of freshness and makes every reader compute an identical series; `scan.mjs` aborts rather
  than publish a row that ends on today, and the detail view pins itself to the table's
  `throughDay` when the two are a day apart (but not when the table is stale).

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

### Two HODL bases — what exactly are you holding instead?

60% of v3 pools (86 of 128) hold yield-bearing ERC4626 wrappers, and the answer genuinely
depends on which counterfactual you mean. The **VS** filter switches between them:

- **POOL TOKENS** — hold the same `waEthUSDC` the pool holds. The Aave yield lifts *both* legs,
  so it cancels: this isolates what the AMM itself did (fees minus divergence).
- **UNDERLYING** — hold the plain `USDC` you actually deposited. Nobody's real alternative is
  holding an aToken, and idle USDC earns nothing, so here the boost counts **for** the LP.

This is not cosmetic. **108 pool/window pairs in the current data disagree on the sign** — the two
bases reach opposite conclusions about whether LPing beat holding. The difference between the two
figures is exactly the wrapper's accrued yield over the window, and the pool detail page draws
both HODL legs so you can see it.

Because the choice changes the answer, it is owned by the page rather than by the table: the
selection follows you into the detail view, the headline card names which basis it is showing,
and the IL DRAG column switches with it. Previously the toggle lived inside the table component,
so navigating to a pool reset it to POOL TOKENS and the detail page's verdict silently contradicted
the row that had been clicked.

Where a wrapper has no underlying price feed, the "underlying" leg falls back to the wrapped
price — which would return the pool-token number under an underlying label. Pools where that
happens on more than 20% of days are flagged rather than quietly answered.

Conversion uses the **ratio of the two USD price series**, not the API's `priceRate` field: rate
providers can fold in more than the wrapper rate. `waBasEURC` reports `priceRate` 1.1753 while its
true wrapper rate is 1.0307 — the gap is the EUR/USD rate baked into the provider.

- **External incentives** (`MERKL` / `STAKING`) are different again: LP-only rewards that never
  touch the pool's reserves, so they are in neither basis. Pools paying them are tagged
  `+rewards` and their true LP result is better than shown.
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
