import React, { useMemo, useState } from 'react'
import { chainName, chainShort } from '../config'
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
const winLabel = (w) => (w === 'full' ? 'FULL' : w + 'D')

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
  { key: 'chain', label: 'CHAIN', align: 'left' },
  { key: 'tvl', label: 'TVL', align: 'right' },
  ...WIN_COLS.map((w) => ({
    key: winKey(w),
    label: winLabel(w),
    align: 'right',
    title:
      w === 'full'
        ? 'LP − HODL over the pool’s whole life. Always populated, so young pools still say something.'
        : `LP − HODL over the last ${w} days`,
  })),
  { key: 'fees', label: 'FEES', align: 'right', title: 'Swap fees earned over the longest available window, as % of average TVL' },
  { key: 'drag', label: 'IL DRAG', align: 'right', title: 'Gap minus fees ≈ the impermanent-loss / LVR component' },
  { key: 'yield', label: 'YIELD', align: 'right', title: 'Underlying yield-bearing APR. Both the LP and a holder earn this, so it cancels out of LP − HODL.' },
]

// The window whose fees / drag we show: the longest one this pool supports.
const bestWindow = (r) => r.win[180] || r.win[90] || r.win[30] || r.win.full || null
const bestWindowDays = (r) => bestWindow(r)?.days ?? null

function sortValue(r, key) {
  switch (key) {
    case 'label': return r.label.toLowerCase()
    case 'chain': return chainShort(r.chain).toLowerCase()
    case 'type': return (TYPE_LABEL[r.type] || r.type).toLowerCase()
    case 'tvl': return r.tvl
    case 'w30': return r.win[30]?.gap
    case 'w90': return r.win[90]?.gap
    case 'w180': return r.win[180]?.gap
    case 'wfull': return r.win.full?.gap
    case 'fees': return bestWindow(r)?.fees
    case 'drag': return bestWindow(r)?.drag
    case 'yield': return r.yieldApr
    default: return null
  }
}

function toCsv(rows) {
  const head = [
    'pool', 'address', 'chain', 'type', 'tvl_usd',
    'lp_minus_hodl_30d', 'lp_minus_hodl_90d', 'lp_minus_hodl_180d', 'lp_minus_hodl_full',
    'fees_pct_tvl', 'il_drag_pct', 'underlying_yield_apr', 'incentive_apr',
    'live', 'last_day', 'days_of_history', 'flags',
  ]
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map((r) => {
    const bw = bestWindow(r)
    return [
      r.label, r.address, r.chain, TYPE_LABEL[r.type] || r.type, r.tvl,
      r.win[30]?.gap ?? '', r.win[90]?.gap ?? '', r.win[180]?.gap ?? '', r.win.full?.gap ?? '',
      bw?.fees ?? '', bw?.drag ?? '', r.yieldApr ?? '', r.incentiveApr ?? '',
      r.live, r.lastDay ?? '', r.maxWin ?? '', (r.flags || []).join(' | '),
    ].map(esc).join(',')
  })
  return [head.join(','), ...lines].join('\n')
}

export default function PoolTable({ rows, onSelect, generatedAt, blacklistedCount, excludedChains }) {
  const [sort, setSort] = useState({ key: 'tvl', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [minTvl, setMinTvl] = useState(0)
  const [chain, setChain] = useState('ALL')
  const [type, setType] = useState('ALL')
  const [show, setShow] = useState('LIVE')

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const allowed = (r) => {
      const flagged = !!r.flags?.length
      if (show === 'ALL') return true
      if (show === 'LIVE') return r.live && !flagged
      if (show === 'IDLE') return !flagged
      if (show === 'FLAGGED') return r.live || flagged
      return true
    }
    return rows.filter(
      (r) =>
        allowed(r) &&
        (chain === 'ALL' || r.chain === chain) &&
        (type === 'ALL' || r.type === type) &&
        r.tvl >= minTvl &&
        (!q ||
          r.label.toLowerCase().includes(q) ||
          (r.name || '').toLowerCase().includes(q) ||
          chainName(r.chain).toLowerCase().includes(q) ||
          (TYPE_LABEL[r.type] || r.type).toLowerCase().includes(q) ||
          r.address.includes(q))
    )
  }, [rows, query, minTvl, chain, type, show])

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
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: ['label', 'chain', 'type'].includes(key) ? 'asc' : 'desc' }
    )

  const scored = sorted.filter((r) => bestWindow(r))
  const beat = scored.filter((r) => bestWindow(r).gap > 0).length
  const totalTvl = sorted.reduce((a, r) => a + r.tvl, 0)

  function downloadCsv() {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lp-vs-hodl-${String(generatedAt || '').slice(0, 10) || 'export'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="statstrip">
        <div><span className="sl">POOLS</span><span className="sv">{sorted.length}</span></div>
        <div><span className="sl">TOTAL TVL</span><span className="sv">{fmtUsd(totalTvl)}</span></div>
        <div>
          <span className="sl">LP BEAT HOLDING</span>
          <span className="sv" style={{ color: 'var(--green)' }}>
            {beat}<span className="sv-sub">/{scored.length}</span>
          </span>
        </div>
        <div>
          <span className="sl">MEDIAN 90D</span>
          <span className="sv">{(() => {
            const g = sorted.map((r) => r.win[90]?.gap).filter((v) => v != null).sort((a, b) => a - b)
            if (!g.length) return '—'
            const m = g[Math.floor(g.length / 2)]
            return <span style={{ color: m >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtPct(m)}</span>
          })()}</span>
        </div>
        <div><span className="sl">UPDATED</span><span className="sv sm">{String(generatedAt || '').slice(0, 10)}</span></div>
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
        {(query || chain !== 'ALL' || type !== 'ALL' || minTvl || show !== 'LIVE') && (
          <button
            className="fbtn"
            onClick={() => { setQuery(''); setChain('ALL'); setType('ALL'); setMinTvl(0); setShow('LIVE') }}
          >
            [ RESET ]
          </button>
        )}
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
                  <span className="arrow">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '·'}</span>
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
                  <td><span className="chaintag">{chainShort(r.chain)}</span></td>
                  <td className="r num">{fmtUsd(r.tvl)}</td>
                  {WIN_COLS.map((w) => {
                    const c = r.win[w]
                    return (
                      <td key={w} className="r num" style={gapStyle(c?.gap)}
                          title={c
                            ? `$100 in on ${c.entry} (${c.days}d) → LP $${c.lp.toFixed(2)} vs HODL $${c.hodl.toFixed(2)}`
                            : `Only ${r.maxWin}d of history`}>
                        {c ? fmtPct(c.gap, 2) : <span className="dim">—</span>}
                      </td>
                    )
                  })}
                  <td className="r num dimtext" title={bw ? `swap fees over ${bestWindowDays(r)} days, as % of average TVL` : ''}>
                    {bw ? bw.fees.toFixed(2) + '%' : <span className="dim">—</span>}
                  </td>
                  <td className="r num dimtext" title={bw ? `gap minus fees over ${bestWindowDays(r)} days` : ''}>
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
        {!sorted.length && <div className="loading">No pools match those filters.</div>}
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
        {' '}Pools Balancer itself blacklists are excluded
        {blacklistedCount ? ` (${blacklistedCount} of them)` : ''}
        {excludedChains?.length ? `, as are ${excludedChains.join(', ')}` : ''}.
        {generatedAt && <> Data refreshed {String(generatedAt).slice(0, 10)}.</>}
      </p>
    </>
  )
}
