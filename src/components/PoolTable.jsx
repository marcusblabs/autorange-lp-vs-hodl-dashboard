import React, { useMemo, useState } from 'react'
import { chainName, chainShort, BALANCER_POOL_URL } from '../config'
import { fmtUsd, fmtPct, shortAddr, fmtStamp, ago } from '../lib/format'

const TYPE_LABEL = {
  RECLAMM: 'AutoRange',
  STABLE: 'Stable',
  WEIGHTED: 'Weighted',
  GYROE: 'E-CLP',
  QUANT_AMM_WEIGHTED: 'QuantAMM',
  FIXED_LBP: 'LBP',
  LIQUIDITY_BOOTSTRAPPING: 'LBP',
}

const TVL_STEPS = [
  { v: 0, label: 'ANY' },
  { v: 1000, label: '$1K' },
  { v: 10000, label: '$10K' },
  { v: 100000, label: '$100K' },
  { v: 1000000, label: '$1M' },
]

// Which rows are eligible at all. Idle pools measure their windows back from
// their last trading day rather than today, and flagged pools failed a data
// sanity check — both are excluded by default but never deleted.
const SHOW_MODES = [
  { v: 'LIVE', label: 'LIVE' },
  { v: 'IDLE', label: '+IDLE' },
  { v: 'FLAGGED', label: '+FLAGGED' },
  { v: 'ALL', label: 'ALL' },
]

const WIN_COLS = [30, 90, 180, 'full']
const winKey = (w) => (w === 'full' ? 'wfull' : 'w' + w)
// "FULL ≤1Y" rather than "FULL": the series can never be longer than the price
// history fetched, which tops out around 365 days, so for a pool older than a
// year this column is the last 12 months and not its lifetime. Roughly half the
// table is in that position, and the bare word FULL invited readers to compare
// a 3-year pool's "lifetime" against a 2-month pool's.
const winLabel = (w) => (w === 'full' ? 'FULL ≤1Y' : w + 'D')

// What the LP is measured against. For a boosted pool these differ, and can
// disagree on the sign — see the footnote in the table.
const BASES = [
  {
    v: 'WRAPPED',
    label: 'Vault token',
    blurb: 'hold the same waEthUSDC the pool holds — its yield lifts both sides, so this measures the AMM alone',
  },
  {
    v: 'UNDERLYING',
    label: 'Underlying',
    blurb: 'hold the plain USDC you actually deposited — idle in a wallet it earns nothing, so the boost counts for the LP',
  },
]
const gapOf = (c, basis) => (c ? (basis === 'UNDERLYING' ? c.gapU ?? c.gap : c.gap) : null)
const aprOf = (c, basis) => (c ? (basis === 'UNDERLYING' ? c.aprU ?? c.apr : c.apr) : null)
const hodlOf = (c, basis) => (basis === 'UNDERLYING' ? c.hodlU ?? c.hodl : c.hodl)
// The drag must switch with the basis for the same reason the gap does — the
// footnote tells the reader drag = gap − fees, and on the underlying basis a
// vault-token drag broke that identity on 128 rows.
const dragOf = (c, basis) => (c ? (basis === 'UNDERLYING' ? c.dragU ?? c.drag : c.drag) : null)

// Colour ramp for the LP−HODL cells: neutral near zero, deepening toward the
// extremes so the eye lands on the pools that actually diverged.
function gapStyle(v) {
  if (v == null) return undefined
  const mag = Math.min(1, Math.abs(v) / 8)
  const alpha = 0.06 + mag * 0.26
  return {
    background: v >= 0 ? `rgba(99,242,190,${alpha})` : `rgba(242,99,110,${alpha})`,
    color: v >= 0 ? 'var(--green)' : 'var(--red)',
  }
}

const COLS = [
  { key: 'label', label: 'POOL', align: 'left' },
  { key: 'type', label: 'TYPE', align: 'left' },
  { key: 'ver', label: 'VER', align: 'left', title: 'Balancer protocol version the pool is deployed on. Every row already carried it; it just was not shown.' },
  { key: 'chain', label: 'CHAIN', align: 'left' },
  { key: 'tvl', label: 'TVL', align: 'right' },
  ...WIN_COLS.map((w) => ({
    key: winKey(w),
    label: winLabel(w),
    align: 'right',
    title:
      w === 'full'
        ? 'LP − HODL over all the history available, which the price feed caps at ~365 days. For a pool younger than that it is the whole life; for an older one it is the last 12 months, NOT lifetime. Always populated, so young pools still say something. Hover a cell for its exact entry date and day count.'
        : `LP − HODL over the last ${w} days. A pool with at least 80% of that history is included, so this can be as short as ${Math.round(w * 0.8)} days — hover a cell for its exact entry date and day count.`,
  })),
  { key: 'apr', label: 'APR', align: 'right', title: 'Annualised out/under-performance vs holding: (LP/HODL)^(365/days) − 1, from the longest window with at least 14 days. A realised rate, not a forecast.' },
  { key: 'fees', label: 'FEES', align: 'right', title: 'Swap fees earned over the longest available window, as % of entry capital — the sum of each day’s fees per share. Gross: the protocol/creator skim is already out of the LP’s value-per-share but is still counted here.' },
  { key: 'drag', label: 'IL DRAG', align: 'right', title: 'Gap minus fees ≈ the divergence (impermanent-loss / LVR) component, on whichever basis is selected above. Slightly overstated, since the fees subtracted are gross of the protocol skim.' },
  // Whether the yield cancels depends entirely on the selected basis, so the
  // tooltip cannot state one answer unconditionally.
  { key: 'yield', label: 'YIELD', align: 'right', title: 'Underlying yield-bearing APR. On the VAULT TOKEN basis both the LP and the holder earn it, so it cancels out of LP − HODL. On the UNDERLYING basis the holder does not earn it, so it counts in the LP’s favour.' },
]

// The window whose fees / drag we show: the longest one this pool supports.
const bestWindow = (r) => r.win[180] || r.win[90] || r.win[30] || r.win.full || null
const bestWindowDays = (r) => bestWindow(r)?.days ?? null

function sortValue(r, key, basis) {
  switch (key) {
    case 'label': return r.label.toLowerCase()
    case 'chain': return chainShort(r.chain).toLowerCase()
    case 'type': return (TYPE_LABEL[r.type] || r.type).toLowerCase()
    // Numeric on purpose: sorting the rendered "v2"/"v3" as text would put v10 before v2
    // the day a v10 exists, and reads as sorted until you look closely.
    case 'ver': return r.protocolVersion ?? null
    case 'tvl': return r.tvl
    case 'w30': return gapOf(r.win[30], basis)
    case 'w90': return gapOf(r.win[90], basis)
    case 'w180': return gapOf(r.win[180], basis)
    case 'wfull': return gapOf(r.win.full, basis)
    case 'apr': return aprOf(bestWindow(r), basis)
    case 'fees': return bestWindow(r)?.fees
    case 'drag': return bestWindow(r)?.drag
    case 'yield': return r.yieldApr
    default: return null
  }
}

function toCsv(rows) {
  const head = [
    'pool', 'address', 'chain', 'type', 'protocol_version', 'tvl_usd',
    'vs_pooltokens_30d', 'vs_pooltokens_90d', 'vs_pooltokens_180d', 'vs_pooltokens_full',
    'vs_underlying_30d', 'vs_underlying_90d', 'vs_underlying_180d', 'vs_underlying_full',
    'fees_pct_entry_capital', 'il_drag_vs_pooltokens', 'il_drag_vs_underlying',
    'underlying_yield_apr', 'incentive_apr',
    'live', 'last_day', 'days_of_history', 'flags',
  ]
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map((r) => {
    const bw = bestWindow(r)
    return [
      r.label, r.address, r.chain, TYPE_LABEL[r.type] || r.type, r.protocolVersion ?? '', r.tvl,
      r.win[30]?.gap ?? '', r.win[90]?.gap ?? '', r.win[180]?.gap ?? '', r.win.full?.gap ?? '',
      r.win[30]?.gapU ?? '', r.win[90]?.gapU ?? '', r.win[180]?.gapU ?? '', r.win.full?.gapU ?? '',
      bw?.fees ?? '', bw?.drag ?? '', bw?.dragU ?? bw?.drag ?? '',
      r.yieldApr ?? '', r.incentiveApr ?? '',
      r.live, r.lastDay ?? '', r.maxWin ?? '', (r.flags || []).join(' | '),
    ].map(esc).join(',')
  })
  return [head.join(','), ...lines].join('\n')
}

// Every control on this table is owned by App, not held here.
//
// Opening a pool unmounts this component, so any state living inside it is
// destroyed: coming back from a chart dropped the search, the chain and type
// filters, the min-TVL floor, the sort, and the basis — landing the reader on
// the default top-of-TVL view rather than the one they left. `basis` was lifted
// first because it also changes the detail view's answer; the rest follows for
// the same reason, and App restores the scroll position alongside it.
export default function PoolTable({ rows, onSelect, generatedAt, blacklistedCount, excludedChains, onRefresh, refreshing, basis, setBasis, counts, minTvlFloor = 1000, view, setView }) {
  const { sort, query, minTvl, chain, type, show } = view
  const patch = (p) => setView((v) => ({ ...v, ...p }))
  const setSort = (fn) => setView((v) => ({ ...v, sort: typeof fn === 'function' ? fn(v.sort) : fn }))
  const setQuery = (q) => patch({ query: q })
  const setMinTvl = (v) => patch({ minTvl: v })
  const setChain = (c) => patch({ chain: c })
  const setType = (t) => patch({ type: t })
  const setShow = (s) => patch({ show: s })

  // Only offer values that actually exist, with counts — AutoRange pools are
  // small and new, so a TVL sort buries them; this is how you find them.
  const chains = useMemo(() => {
    const c = rows.reduce((m, r) => m.set(r.chain, (m.get(r.chain) || 0) + 1), new Map())
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const types = useMemo(() => {
    const c = rows.reduce((m, r) => m.set(r.type, (m.get(r.type) || 0) + 1), new Map())
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const matchesQuery = (r, q) =>
    !q ||
    r.label.toLowerCase().includes(q) ||
    (r.name || '').toLowerCase().includes(q) ||
    chainName(r.chain).toLowerCase().includes(q) ||
    (TYPE_LABEL[r.type] || r.type).toLowerCase().includes(q) ||
    r.address.includes(q)

  // A pool you searched for by name or address must never come back empty just
  // because a default filter excluded it. Typing a query therefore lifts the
  // SHOW filter — an idle or flagged row still arrives carrying its badge, so
  // nothing is silently misrepresented, it is simply findable.
  const { filtered, hiddenByFilters, hiddenByShow } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const allowed = (r) => {
      if (q) return true
      const flagged = !!r.flags?.length
      if (show === 'ALL') return true
      if (show === 'LIVE') return r.live && !flagged
      if (show === 'IDLE') return !flagged
      if (show === 'FLAGGED') return r.live || flagged
      return true
    }
    // Count only what the chain / type / min-TVL filters remove. Rows the SHOW
    // dropdown excludes are not "hidden" — that control states its own effect,
    // and counting them made the hint fire permanently with no filter set.
    const eligible = rows.filter((r) => matchesQuery(r, q) && allowed(r))
    const out = eligible.filter(
      (r) =>
        (chain === 'ALL' || r.chain === chain) &&
        (type === 'ALL' || r.type === type) &&
        r.tvl >= minTvl
    )
    // Counted separately from hiddenByFilters so the footnote can state what
    // the SHOW dropdown is removing. Its default (LIVE) hides idle and flagged
    // pools, which is right, but it was doing so without ever saying how many.
    const hiddenByShow = rows.filter((r) => matchesQuery(r, q)).length - eligible.length
    return { filtered: out, hiddenByFilters: eligible.length - out.length, hiddenByShow }
  }, [rows, query, minTvl, chain, type, show])

  const sorted = useMemo(() => {
    const out = [...filtered]
    const { key, dir } = sort
    out.sort((a, b) => {
      const va = sortValue(a, key, basis)
      const vb = sortValue(b, key, basis)
      // rows missing a value always sink to the bottom, whichever direction
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
      return dir === 'asc' ? va - vb : vb - va
    })
    return out
  }, [filtered, sort, basis])

  const click = (key) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: ['label', 'chain', 'type'].includes(key) ? 'asc' : 'desc' }
    )

  // One stated horizon, so the tally means something. Mixing each pool's
  // longest available window made "150/281" a count over 281 different
  // questions.
  const beat90 = useMemo(() => {
    const withWin = sorted.filter((r) => r.win[90])
    return { n: withWin.filter((r) => gapOf(r.win[90], basis) > 0).length, total: withWin.length }
  }, [sorted, basis])
  const totalTvl = sorted.reduce((a, r) => a + r.tvl, 0)

  function downloadCsv() {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lp-vs-hodl-${String(generatedAt || '').slice(0, 16).replace('T', '_').replace(':', '') || 'export'}Z.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="basisbar">
        <div className="basis-q">
          Compare the LP against <b>what</b>?
        </div>
        <div className="basis-opts">
          {BASES.map((b) => (
            <button
              key={b.v}
              className={'basis-opt' + (basis === b.v ? ' on' : '')}
              onClick={() => setBasis(b.v)}
            >
              <span className="basis-name">Holding the {b.label.toLowerCase()}</span>
              <span className="basis-blurb">{b.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="statstrip">
        <div><span className="sl">POOLS</span><span className="sv">{sorted.length}</span></div>
        <div><span className="sl">TOTAL TVL</span><span className="sv">{fmtUsd(totalTvl)}</span></div>
        {/* Both cards state their window and their row set. LP BEAT used to
            count each pool over whatever its longest window happened to be —
            180 days for one row, under 14 for the next — and present the tally
            as if it were one comparison. It is now a single stated horizon. */}
        <div title={`Pools whose 90-day LP − HODL is positive, vs ${basis === 'UNDERLYING' ? 'holding the underlying' : 'holding the vault token'}. Counted over the ${sorted.length} rows currently shown, of which ${beat90.total} have 90 days of history.`}>
          <span className="sl">LP BEAT {basis === 'UNDERLYING' ? 'UNDERLYING' : 'VAULT TOKEN'} · 90D</span>
          <span className="sv" style={{ color: 'var(--green)' }}>
            {beat90.n}<span className="sv-sub">/{beat90.total} shown</span>
          </span>
        </div>
        <div title={`Median of the 90-day LP − HODL across the ${beat90.total} shown pools that have 90 days of history.`}>
          <span className="sl">MEDIAN 90D</span>
          <span className="sv">{(() => {
            const g = sorted.map((r) => gapOf(r.win[90], basis)).filter((v) => v != null).sort((a, b) => a - b)
            if (!g.length) return '—'
            // Mean of the two middle values on an even count, rather than
            // silently picking the upper one.
            const mid = g.length >> 1
            const m = g.length % 2 ? g[mid] : (g[mid - 1] + g[mid]) / 2
            return <span style={{ color: m >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtPct(m)}</span>
          })()}</span>
        </div>
        <div>
          <span className="sl">UPDATED</span>
          <span className="sv sm">{fmtStamp(generatedAt)}
            {ago(generatedAt) && <span className="sv-sub"> · {ago(generatedAt)}</span>}</span>
        </div>
      </div>

      <div className="fbar">
        <span className="prompt">&gt;</span>
        <input
          className="fsearch"
          type="text"
          placeholder="search pool / token / address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <span className="fgroup">
          <span className="flabel">CHN</span>
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="ALL">ALL</option>
            {chains.map(([c, n]) => (
              <option key={c} value={c}>{chainShort(c)} ({n})</option>
            ))}
          </select>
        </span>
        <span className="fgroup">
          <span className="flabel">TYPE</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="ALL">ALL</option>
            {types.map(([t, n]) => (
              <option key={t} value={t}>{(TYPE_LABEL[t] || t).toUpperCase()} ({n})</option>
            ))}
          </select>
        </span>
        <span className="fgroup">
          <span className="flabel">MIN-TVL</span>
          <select value={minTvl} onChange={(e) => setMinTvl(+e.target.value)}>
            {TVL_STEPS.map((s) => (
              <option key={s.v} value={s.v}>{s.label}</option>
            ))}
          </select>
        </span>
        <span className="fgroup">
          <span className="flabel">SHOW</span>
          <select value={show} onChange={(e) => setShow(e.target.value)}
                  title="Idle pools measure their windows from their last trading day, not today. Flagged pools failed a data sanity check.">
            {SHOW_MODES.map((s) => (
              <option key={s.v} value={s.v}>{s.label}</option>
            ))}
          </select>
        </span>
        <button className="fbtn" onClick={downloadCsv} disabled={!sorted.length}>[ CSV ]</button>
        {onRefresh && (
          <button
            className="fbtn refresh"
            onClick={onRefresh}
            disabled={refreshing}
            title="Re-read scan.json, bypassing the browser cache. The table is rebuilt nightly by CI — this picks up the newest build rather than rescanning every pool live, which takes ~25 minutes."
          >
            {refreshing ? '[ REFRESHING… ]' : '[ REFRESH ]'}
          </button>
        )}
        {(query || chain !== 'ALL' || type !== 'ALL' || minTvl || show !== 'LIVE') && (
          <button
            className="fbtn"
            onClick={() => { setQuery(''); setChain('ALL'); setType('ALL'); setMinTvl(0); setShow('LIVE') }}
          >
            [ RESET ]
          </button>
        )}
      </div>

      {hiddenByFilters > 0 && (
        <div className="hint">
          <b>{hiddenByFilters}</b> more {hiddenByFilters === 1 ? 'pool matches' : 'pools match'} but{' '}
          {hiddenByFilters === 1 ? 'is' : 'are'} hidden by the chain, type or min-TVL filter.
          <button className="fbtn" onClick={() => { setChain('ALL'); setType('ALL'); setMinTvl(0) }}>
            [ SHOW THEM ]
          </button>
        </div>
      )}

      <div className="tablewrap">
        <table className="pooltable">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={`${c.align === 'right' ? 'r' : ''} ${sort.key === c.key ? 'sorted' : ''}`}
                  onClick={() => click(c.key)}
                  title={c.title}
                >
                  {c.label}
                  <span className="arrow">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '·'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const bw = bestWindow(r)
              // Rows are the only route to a pool's chart, so they have to be
              // reachable without a mouse.
              return (
                <tr
                  key={`${r.chain}:${r.address}`}
                  onClick={() => onSelect(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r) }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open the full chart for ${r.label} on ${chainShort(r.chain)}`}
                  title="Open the full chart for this pool"
                >
                  <td className="pool">
                    {/* The name alone leaves the dashboard for Balancer's own
                        pool page. stopPropagation keeps the row's own click —
                        which opens the LP-vs-HODL chart — from firing too, and
                        the keydown guard does the same for Enter/Space so
                        keyboard users get the link rather than the chart. */}
                    <a
                      className="plabel plink"
                      href={BALANCER_POOL_URL(r.chain, r.protocolVersion === 2 ? r.id : r.address, r.protocolVersion)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      title={`Open ${r.label} on balancer.fi`}
                    >
                      {r.label}
                    </a>
                    {r.nTokens > 2 && <span className="mini">{r.nTokens}t</span>}
                    {r.boosted && (
                      <span className="mini boost" title={`Boosted pool — holds yield-bearing wrappers. Underlying assets: ${r.underlyingLabel}. Use the VS filter to switch which basket the LP is compared against.`}>
                        boosted
                      </span>
                    )}
                    {r.flags?.length > 0 && (
                      <span className="mini flag" title={`Data sanity check failed — ${r.flags.join('; ')}. Treat these numbers with suspicion.`}>
                        ⚑ suspect
                      </span>
                    )}
                    {r.incentiveApr > 0 && (
                      <span className="mini warn" title={`Also pays ~${(r.incentiveApr * 100).toFixed(1)}% APR in external incentives (Merkl/staking). Those go to LPs only and are NOT included below — the real LP result is better than shown.`}>
                        +rewards
                      </span>
                    )}
                    {r.reviewed === false && (
                      <span className="mini dim" title="Not in Balancer's reviewed-pool list.">unreviewed</span>
                    )}
                    {!r.live && (
                      <span className="mini dim" title={`Stopped trading — these windows end ${r.lastDay}, not today, so they are not comparable with live pools.`}>
                        idle · {r.lastDay?.slice(0, 7)}
                      </span>
                    )}
                  </td>
                  <td className="dimtext">{TYPE_LABEL[r.type] || r.type}</td>
                  <td>{r.protocolVersion ? <span className={'vtag v' + r.protocolVersion}>v{r.protocolVersion}</span>
                                         : <span className="dim">—</span>}</td>
                  <td><span className="chaintag">{chainShort(r.chain)}</span></td>
                  <td className="r num">{fmtUsd(r.tvl)}</td>
                  {WIN_COLS.map((w) => {
                    const c = r.win[w]
                    const g = gapOf(c, basis)
                    return (
                      <td key={w} className="r num" style={gapStyle(g)}
                          title={c
                            ? `$100 in on ${c.entry} (${c.days}d) → LP $${c.lp.toFixed(2)} vs HODL $${hodlOf(c, basis).toFixed(2)}`
                              + (c.boost ? ` · boost over this window ${(c.boost >= 0 ? '+' : '') + c.boost.toFixed(2)}%` : '')
                            : `Only ${r.maxWin}d of history`}>
                        {g != null ? fmtPct(g, 2) : <span className="dim">—</span>}
                        {/* A pool needs only 80% of a window to be admitted to
                            its column, so a "30D" cell can hold 25 days. Say so
                            on the cell face rather than only on hover. */}
                        {c && w !== 'full' && c.days < w - 1 && (
                          <span className="shortwin" title={`only ${c.days} days of history — not a full ${w}-day window`}>
                            {' '}{c.days}d
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="r num" style={gapStyle(aprOf(bw, basis))}
                      title={bw ? `annualised from the ${bestWindowDays(r)}-day window` : ''}>
                    {aprOf(bw, basis) != null ? fmtPct(aprOf(bw, basis), 1) : <span className="dim" title="needs at least 14 days of history">—</span>}
                  </td>
                  <td className="r num dimtext" title={bw ? `swap fees over ${bestWindowDays(r)} days, as % of entry capital` : ''}>
                    {bw ? bw.fees.toFixed(2) + '%' : <span className="dim">—</span>}
                  </td>
                  <td className="r num dimtext" title={bw ? `gap minus fees over ${bestWindowDays(r)} days, vs ${basis === 'UNDERLYING' ? 'the underlying' : 'the vault token'}` : ''}>
                    {bw ? fmtPct(dragOf(bw, basis), 2) : <span className="dim">—</span>}
                  </td>
                  <td className="r num dimtext">
                    {r.yieldApr > 0 ? (r.yieldApr * 100).toFixed(2) + '%' : <span className="dim">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!sorted.length && (
          <div className="loading">
            No pools match those filters.
            {' '}
            <button className="fbtn" onClick={() => { setQuery(''); setChain('ALL'); setType('ALL'); setMinTvl(0); setShow('ALL') }}>
              [ CLEAR FILTERS ]
            </button>
          </div>
        )}
      </div>

      <p className="foot">
        <b>Reading this table:</b> every number is <b>LP minus HODL</b> — the extra (or missing) value
        from providing liquidity versus simply holding the same basket of tokens you would have
        deposited. Negative means holding won. <b>Fees</b> is what the pool earned in swap fees over
        the window, as a % of entry capital — the sum of each day's fees per share — and{' '}
        <b>IL drag</b> is the gap minus those fees, on the basis you have selected, which is
        roughly the impermanent-loss / LVR cost. Those fees are gross of the protocol/creator
        skim while the gap is already net of it, so the drag reads a little more negative than
        pure divergence. <b>Yield</b> is the underlying yield-bearing APR: an LP and a
        holder both earn it — so on the <b>vault token</b> basis it cancels out and can never make
        LPing win on its own; on the <b>underlying</b> basis it does not cancel and counts for the LP. Switch <b>VS</b> to <b>UNDERLYING</b> to compare against the plain
        assets you actually deposited (USDC rather than waEthUSDC): a holder of those earns no
        yield, so the boost then counts in the LP's favour. For boosted pools the two bases can
        disagree on the sign, and the difference between them is exactly the yield the wrapper
        accrued over the window. Pools tagged <span className="mini warn">+rewards</span> pay external
        incentives (Merkl/staking) that go to LPs only and are <b>not</b> counted here — their true
        LP result is better than the columns show. Click any row for the full chart.
        {' '}Pools Balancer itself blacklists are excluded
        {blacklistedCount ? ` (${blacklistedCount} of them)` : ''}
        {excludedChains?.length ? `, as are ${excludedChains.join(', ')}` : ''}.
        {/* Coverage stated as numbers rather than implied by "every pool":
            pools do get dropped, and a reader is entitled to know how many. */}
        {counts && (
          <>
            {' '}Coverage: <b>{counts.listed}</b> pools listed above the ${(minTvlFloor / 1000).toFixed(0)}k floor,{' '}
            <b>{counts.usable}</b> scored, <b>{counts.error + (counts.empty || 0)}</b> dropped for
            missing price or snapshot data and <b>{counts.thin}</b> for under two days of history.
            {hiddenByShow > 0 && <> The <b>SHOW</b> filter is currently hiding <b>{hiddenByShow}</b> idle or flagged {hiddenByShow === 1 ? 'pool' : 'pools'}.</>}
          </>
        )}
        {generatedAt && <> Data refreshed {fmtStamp(generatedAt)}.</>}
      </p>
    </>
  )
}
