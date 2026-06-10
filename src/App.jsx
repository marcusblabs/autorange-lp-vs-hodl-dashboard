import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  WINDOWS, EXTRA_POOLS, FALLBACK_POOLS,
  DUNE_QUERY_ID, DUNE_QUERY_URL, BALANCER_POOL_URL, EXPLORER_ADDR,
} from './config'
import { fetchReclammPools, fetchPoolSeries } from './lib/balancer'
import { normalizeSeries, computeWindow, maxWindowDays, isLive } from './lib/series'
import StatCards from './components/StatCards'
import ValueChart from './components/ValueChart'
import GapChart from './components/GapChart'
import { shortAddr, fmtUsd } from './lib/format'

const WIN_LABEL = { 1: '1D', 7: '7D', 14: '14D', 30: '30D', 60: '60D', 90: '90D', 180: '180D' }

function mergeExtras(list) {
  const seen = new Set(list.map((p) => p.address))
  const merged = [...list, ...EXTRA_POOLS.filter((p) => !seen.has(p.address))]
  // Same token pair can exist as several pools — make the labels unique.
  const counts = merged.reduce((m, p) => m.set(p.label, (m.get(p.label) || 0) + 1), new Map())
  return merged.map((p) =>
    counts.get(p.label) > 1 ? { ...p, label: `${p.label} (${shortAddr(p.address)})` } : p
  )
}

export default function App() {
  const [pools, setPools] = useState(null) // null until the live list arrives
  const [poolAddr, setPoolAddr] = useState('')
  const [custom, setCustom] = useState('')
  const [windowDays, setWindowDays] = useState(30)
  const [series, setSeries] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const loadSeq = useRef(0)

  // Live reCLAMM pool list, highest-TVL live pool preselected.
  useEffect(() => {
    let on = true
    fetchReclammPools()
      .then((list) => {
        if (!on) return
        const merged = mergeExtras(list)
        setPools(merged)
        setPoolAddr((prev) => prev || merged[0]?.address || '')
      })
      .catch(() => {
        if (!on) return
        setPools(FALLBACK_POOLS)
        setPoolAddr((prev) => prev || FALLBACK_POOLS[0].address)
      })
    return () => { on = false }
  }, [])

  const activeAddr = (custom.trim() || poolAddr).toLowerCase()

  async function load({ force = false } = {}) {
    const addr = activeAddr
    if (!addr) return
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      setStatus('error'); setError(new Error('Enter a valid 0x pool address.')); setSeries(null)
      return
    }
    const seq = ++loadSeq.current
    setStatus('loading'); setError(null)
    try {
      const rows = await fetchPoolSeries(addr, { force })
      if (seq !== loadSeq.current) return // a newer selection superseded this load
      const norm = normalizeSeries(rows)
      if (norm.length < 2) {
        setSeries(null); setStatus('error')
        setError(new Error('Not enough daily history for this pool yet (needs at least 2 days).'))
        return
      }
      setSeries(norm); setStatus('ready')
    } catch (e) {
      if (seq !== loadSeq.current) return
      setSeries(null); setStatus('error'); setError(e)
    }
  }

  // reload on pool change
  useEffect(() => { load() /* eslint-disable-next-line */ }, [activeAddr])

  const maxWin = series ? maxWindowDays(series) : 0
  const live = series ? isLive(series) : false

  // keep the selected window feasible
  useEffect(() => {
    if (!series) return
    if (windowDays != null && windowDays > maxWin) {
      const feasible = [...WINDOWS].reverse().find((w) => w <= maxWin)
      setWindowDays(feasible ?? null)
    }
    // eslint-disable-next-line
  }, [series])

  const win = useMemo(
    () => (series ? computeWindow(series, windowDays) : null),
    [series, windowDays]
  )

  const livePools = (pools || []).filter((p) => p.version >= 3)
  const histPools = (pools || []).filter((p) => p.version < 3)

  return (
    <>
      <div className="head">
        <h1>
          AutoRange — LP vs HODL
          <span className="tag">Balancer v3 reCLAMM · Ethereum</span>
        </h1>
        <p>
          For any AutoRange (reCLAMM) pool: would you have more value <b>providing liquidity</b> or
          just <b>holding the two tokens</b>? Value-per-share of the pool — which already nets fees,
          impermanent loss and the LVR cost of auto-ranging — against the deposited basket, indexed
          to 100 at entry. Pool list and data load live from the official Balancer API — no key
          needed. Pick a pool and a look-back window.
        </p>
      </div>

      <div className="controls">
        <div className="field">
          <label>Pool {pools ? `(${pools.length} reCLAMM pools)` : '(loading list…)'}</label>
          <select
            value={custom.trim() ? '' : poolAddr}
            onChange={(e) => { setCustom(''); setPoolAddr(e.target.value) }}
            disabled={!pools}
          >
            {livePools.length > 0 && (
              <optgroup label="Live — May 2026 relaunch">
                {livePools.map((p) => (
                  <option key={p.address} value={p.address}>
                    {p.label}{p.tvl > 0 ? ` · ${fmtUsd(p.tvl)} TVL` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {histPools.length > 0 && (
              <optgroup label="Historical — suspended Feb 2026">
                {histPools.map((p) => (
                  <option key={p.address} value={p.address}>{p.label}</option>
                ))}
              </optgroup>
            )}
            {custom.trim() ? <option value="">custom address</option> : null}
          </select>
        </div>
        <div className="field">
          <label>…or custom reCLAMM address</label>
          <input
            type="text"
            placeholder="0x… (Ethereum)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label>Look-back window</label>
          <div className="seg">
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={windowDays === w ? 'on' : ''}
                disabled={w > maxWin}
                onClick={() => setWindowDays(w)}
              >
                {WIN_LABEL[w]}
              </button>
            ))}
            <button className={windowDays == null ? 'on' : ''} onClick={() => setWindowDays(null)}>
              Full
            </button>
          </div>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button
            className="btn ghost"
            disabled={status === 'loading'}
            onClick={() => load({ force: true })}
            title="Refetch snapshots and prices from the Balancer API"
          >
            {status === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="err">{String(error.message || error)}</div>}

      {status === 'loading' && !series && <div className="loading">Loading from the Balancer API…</div>}

      {win && (
        <>
          {win.clamped && (
            <div className="note">
              Only <b>{win.availDays} days</b> of history exist for this pool — showing the full
              available life instead of the requested {windowDays}-day window.
            </div>
          )}

          <StatCards win={win} />

          <div className="panel">
            <h2>
              {win.sym0} / {win.sym1} — position value over time
              <span className="tag">{live ? 'live · trailing from today' : `as of ${win.endDate} (no trading activity since)`}</span>
            </h2>
            <p className="ph">
              $100 entered {win.entryDate}, indexed to 100. The gap between the lines is the LP’s
              fee-minus-LVR result; both move together with the token prices.
            </p>
            <div className="legend">
              <span><span className="dot" style={{ background: 'var(--purple)' }} /><b>LP (AutoRange)</b></span>
              <span><span className="dot" style={{ background: 'var(--green)' }} /><b>HODL (2-token basket)</b></span>
            </div>
            <ValueChart pts={win.pts} />
          </div>

          <div className="panel">
            <h2>LP advantage vs HODL</h2>
            <p className="ph">
              LP minus HODL, % of entry capital. Below zero = holding would have won (divergence
              loss given to arbitrageurs &gt; fees earned).
            </p>
            <GapChart pts={win.pts} />
          </div>

          <p className="foot">
            <b>Method:</b> LP value-per-share = (res₀·p₀ + res₁·p₁) / BPT supply from the Balancer
            API’s official daily pool snapshots — reserves are subgraph-accurate and already exclude
            the protocol-fee skim; it nets fees, IL and the LVR cost of auto-ranging (reCLAMM’s range
            shift is virtual and in-protocol — no keeper or LP gas). HODL = the basket per share at
            entry, held and marked with the same daily prices (same API). Gauge incentives are not
            included — where they exist they would lift the LP leg. Cross-check:{' '}
            <a href={DUNE_QUERY_URL} target="_blank" rel="noreferrer">Dune #{DUNE_QUERY_ID}</a>
            {' '}(independent event-replay reconstruction)
            {' · '}
            <a href={BALANCER_POOL_URL(activeAddr)} target="_blank" rel="noreferrer">Balancer pool</a>
            {' · '}
            <a href={EXPLORER_ADDR(activeAddr)} target="_blank" rel="noreferrer">{shortAddr(activeAddr)}</a>
          </p>
        </>
      )}
    </>
  )
}
