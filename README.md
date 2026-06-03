# AutoRange — LP vs HODL

A dashboard that answers one question for any Balancer v3 **AutoRange (reCLAMM)** pool on
Ethereum: over the last 1 / 7 / 14 / 30 / 60 / 90 / 180 days, would you have had more value
**providing liquidity** or just **holding the two tokens**?

Live: https://marcusblabs.github.io/autorange-lp-vs-hodl-dashboard/

## Method

- **LP leg** — `value_per_share(t) = TVL(t) / BPT_totalSupply(t)`, reconstructed from Balancer v3
  Vault events. Because reCLAMM is a fungible-BPT, proportional-liquidity pool whose range shifts
  *virtually and in-protocol* (no keeper, no LP-borne gas), this single number already nets swap
  fees, impermanent loss, and the LVR cost of auto-ranging — they are all embedded in the on-chain
  reserves.
- **HODL leg** — the deposited basket. At the window's entry day the composition per share is
  `(res0/bpt, res1/bpt)`; it's held forward and marked with the *same* USD prices.
- Both legs are indexed to 100 at entry, so the gap between them is the LP's fee-minus-LVR result.
- All window slicing, the HODL counterfactual, and indexing happen client-side from one Dune query
  that returns the raw daily state.

### Caveats (to calibrate later)

- Reserves are reconstructed from events and do **not** subtract the protocol-fee skim, so the true
  LP drag is marginally worse than shown.
- Gauge incentives are **not** added; where they exist they would offset upward.
- Very small / very young pools are noisy.
- reCLAMM pools were suspended 2026-02-20 and relaunched ~2026-05-19 on fresh contracts, so the
  "historical" cohort is frozen at Feb 2026 and the "live" cohort has short history.

## Data

One parameterized saved Dune query — [#7649043](https://dune.com/queries/7649043) — returns the
per-day raw state (token reserves, BPT supply, USD prices, TVL) for one pool, selected by address.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm run deploy   # gh-pages -d dist
```

The deployed bundle contains **no API key** — each visitor pastes their own Dune key (free tier
works), stored only in their browser's `localStorage`. Featured pools ship with a bundled sample
snapshot so the dashboard renders with no key.

Built with React + Vite. Styling mirrors [balancer.defilytica.com](https://balancer.defilytica.com).
