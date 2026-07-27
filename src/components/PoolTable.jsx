import React, { useMemo, useState } from 'react'
import { chainName } from '../config'
import { fmtUsd, fmtPct, shortAddr } from '../lib/format'

const TYPE_LABEL = {
  RECLAMM: 'AutoRange',
  STABLE: 'Stable',
  WEIGHTED: 'Weighted',
  GYROE: 'E-CLP',
  QUANT_AMM_WEIGHTED: 'QuantAMM',
  FIXED_LBP: 'LBP',
  LIQUIDITY_BOOTSTRAPPING: 'LBP',
}

// Colour ramp for the LP−HODL cells: neutral near zero, deepening toward the
// extremes so the eye lands on the pools that actually diverged.
function gapStyle(v) {
  if (v == null) return undefined
  const mag = Math.min(1, Math.abs(v) / 8)
  const alpha = 0.06 + mag * 0.26
  return {
    background: v >= 0 ? `rgba(99,242,190,${alpha})` : `rgba(242,99,110,${alpha})`,
    color: v >= 0 ? 'var(--green)' : 'var(--red)',
    fontVariantNumeric: 'tabular-nums',
  }
}

const COLS = [
  { key: 'label', label: 'Pool', align: 'left' },
  { key: 'chain', label: 'Chain', align: 'left' },
  { key: 'type', label: 'Type', align: 'left' },
  { key: 'tvl', label: 'TVL', align: 'right' },
  { key: 'w30', label: '30d', align: 'right', gap: true, title: 'LP − HODL over the last 30 days' },
  { key: 'w90', label: '90d', align: 'right', gap: true, title: 'LP − HODL over the last 90 days' },
  { key: 'w180', label: '180d', align: 'right', gap: true, title: 'LP − HODL over the last 180 days' },
  { key: 'fees', label: 'Fees', align: 'right', title: 'Swap fees earned over the longest available window, as % of average TVL' },
  { key: 'drag', label: 'IL drag', align: 'right', title: 'Gap minus fees ≈ the impermanent-loss / LVR component' },
  { key: 'yield', label: 'Yield', align: 'right', title: 'Underlying yield-bearing APR. Both LP and holder earn this, so it cancels out of LP − HODL.' },
]

// The window whose fees / drag we show: the longest one this pool supports.
const bestWindow = (r) => r.win[180] || r.win[90] || r.win[30] || null
const bestWindowDays = (r) => (r.win[180] ? 180 : r.win[90] ? 90 : r.win[30] ? 30 : null)

function sortValue(r, key) {
  switch (key) {
    case 'label': return r.label.toLowerCase()
    case 'chain': return chainName(r.chain).toLowerCase()
    case 'type': return (TYPE_LABEL[r.type] || r.type).toLowerCase()
    case 'tvl': return r.tvl
    case 'w30': return r.win[30]?.gap
    case 'w90': return r.win[90]?.gap
    case 'w180': return r.win[180]?.gap
    case 'fees': return bestWindow(r)?.fees
    case 'drag': return bestWindow(r)?.drag
    case 'yield': return r.yieldApr
    default: return null
  }
}

export default function PoolTable({ rows, onSelect, generatedAt }) {
  const [sort, setSort] = useState({ key: 'tvl', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [minTvl, setMinTvl] = useState(0)
  const [showFlagged, setShowFlagged] = useState(false)
  const [showIdle, setShowIdle] = useState(false)

  const flaggedCount = useMemo(() => rows.filter((r) => r.flags?.length).length, [rows])
  const idleCount = useMemo(() => rows.filter((r) => !r.live && !r.flags?.length).length, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (showFlagged || !r.flags?.length) &&
        (showIdle || r.live) &&
        r.tvl >= minTvl &&
        (!q ||
          r.label.toLowerCase().includes(q) ||
          (r.name || '').toLowerCase().includes(q) ||
          chainName(r.chain).toLowerCase().includes(q) ||
          (TYPE_LABEL[r.type] || r.type).toLowerCase().includes(q) ||
          r.address.includes(q))
    )
  }, [rows, query, minTvl, showFlagged, showIdle])

  const sorted = useMemo(() => {
    const out = [...filtered]
    const { key, dir } = sort
    out.sort((a, b) => {
      const va = sortValue(a, key)
      const vb = sortValue(b, key)
      // rows missing a value always sink to the bottom, whichever direction
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
      return dir === 'asc' ? va - vb : vb - va
    })
    return out
  }, [filtered, sort])

  const click = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'label' || key === 'chain' || key === 'type' ? 'asc' : 'desc' }))

  const beat = filtered.filter((r) => bestWindow(r) && bestWindow(r).gap > 0).length
  const scored = filtered.filter((r) => bestWindow(r)).length

  return (
    <>
      <div className="tablebar">
        <input
          className="search"
          type="text"
          placeholder="Filter by token, chain, type or address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="seg sm">
          {[0, 10000, 100000, 1000000].map((v) => (
            <button key={v} className={minTvl === v ? 'on' : ''} onClick={() => setMinTvl(v)}>
              {v === 0 ? 'All TVL' : `≥ ${fmtUsd(v)}`}
            </button>
          ))}
        </div>
        {idleCount > 0 && (
          <button
            className={'btn ghost small' + (showIdle ? ' on' : '')}
            onClick={() => setShowIdle((v) => !v)}
            title="Pools that have stopped trading. Their windows are measured back from their last active day, not from today, so the numbers are not comparable with live pools."
          >
            {showIdle ? 'Hide' : 'Show'} {idleCount} idle
          </button>
        )}
        {flaggedCount > 0 && (
          <button
            className={'btn ghost small' + (showFlagged ? ' on' : '')}
            onClick={() => setShowFlagged((v) => !v)}
            title="Pools whose data failed a sanity check — a broken price feed, a valuation that disagrees with the API, or an implausibly large result. Shown so nothing is hidden, but excluded by default."
          >
            {showFlagged ? 'Hide' : 'Show'} {flaggedCount} flagged
          </button>
        )}
        <span className="muted tinystat">
          {sorted.length} pools · <b style={{ color: 'var(--green)' }}>{beat}</b> of {scored} beat holding
        </span>
      </div>

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
                  <span className="arrow">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const bw = bestWindow(r)
              return (
                <tr key={`${r.chain}:${r.address}`} onClick={() => onSelect(r)} title="Open the full chart for this pool">
                  <td className="pool">
                    <span className="plabel">{r.label}</span>
                    {r.nTokens > 2 && <span className="mini">{r.nTokens}t</span>}
                    {r.flags?.length > 0 && (
                      <span className="mini flag" title={`Data sanity check failed — ${r.flags.join('; ')}. Treat these numbers with suspicion.`}>
                        ⚑ suspect
                      </span>
                    )}
                    {r.incentiveApr > 0 && (
                      <span className="mini warn" title={`This pool also pays ~${(r.incentiveApr * 100).toFixed(1)}% APR in external incentives (Merkl/staking). Those go to LPs only and are NOT included below — the real LP result is better than shown.`}>
                        +rewards
                      </span>
                    )}
                    {!r.live && (
                      <span className="mini dim" title={`Stopped trading — these windows end ${r.lastDay}, not today, so they are not comparable with live pools.`}>
                        idle · {r.lastDay?.slice(0, 7)}
                      </span>
                    )}
                  </td>
                  <td>{chainName(r.chain)}</td>
                  <td className="dimtext">{TYPE_LABEL[r.type] || r.type}</td>
                  <td className="r num">{fmtUsd(r.tvl)}</td>
                  {[30, 90, 180].map((w) => (
                    <td key={w} className="r num" style={gapStyle(r.win[w]?.gap)}
                        title={r.win[w] ? `$100 in on ${r.win[w].entry} → LP $${r.win[w].lp.toFixed(2)} vs HODL $${r.win[w].hodl.toFixed(2)}` : `Only ${r.maxWin}d of history`}>
                      {r.win[w] ? fmtPct(r.win[w].gap, 2) : <span className="dim">—</span>}
                    </td>
                  ))}
                  <td className="r num dimtext" title={bw ? `swap fees over the last ${bestWindowDays(r)} days, as % of average TVL` : ''}>
                    {bw ? bw.fees.toFixed(2) + '%' : <span className="dim">—</span>}
                  </td>
                  <td className="r num dimtext" title={bw ? `gap minus fees over the last ${bestWindowDays(r)} days` : ''}>
                    {bw ? fmtPct(bw.drag, 2) : <span className="dim">—</span>}
                  </td>
                  <td className="r num dimtext">
                    {r.yieldApr > 0 ? (r.yieldApr * 100).toFixed(2) + '%' : <span className="dim">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!sorted.length && <div className="loading">No pools match that filter.</div>}
      </div>

      <p className="foot">
        <b>Reading this table:</b> every number is <b>LP minus HODL</b> — the extra (or missing) value
        from providing liquidity versus simply holding the same basket of tokens you would have
        deposited. Negative means holding won. <b>Fees</b> is what the pool earned in swap fees over
        the window (% of average TVL) and <b>IL drag</b> is the gap minus those fees — roughly the
        impermanent-loss / LVR cost. <b>Yield</b> is the underlying yield-bearing APR: an LP and a
        holder both earn it, so it cancels out of the comparison and can never make LPing beat
        holding on its own. Pools tagged <span className="mini warn">+rewards</span> pay external
        incentives (Merkl/staking) that go to LPs only and are <b>not</b> counted here — their true
        LP result is better than the columns show. Click any row for the full chart.
        {generatedAt && <> Data refreshed {String(generatedAt).slice(0, 10)}.</>}
      </p>
    </>
  )
}
