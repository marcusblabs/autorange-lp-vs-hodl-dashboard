import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  WINDOWS, chainName, SCAN_URL,
  DUNE_QUERY_ID, DUNE_QUERY_URL, BALANCER_POOL_URL, EXPLORER_ADDR,
} from './config'
import { fetchPoolSeries, resolvePool } from './lib/balancer'
import { normalizeSeries, computeWindow, maxWindowDays, isLive } from './lib/series'
import PoolTable from './components/PoolTable'
import StatCards from './components/StatCards'
import ValueChart from './components/ValueChart'
import GapChart from './components/GapChart'
import { shortAddr, fmtUsd } from './lib/format'

const WIN_LABEL = { 1: '1D', 7: '7D', 14: '14D', 30: '30D', 60: '60D', 90: '90D', 180: '180D' }
// A v2 balancer.fi link carries the 32-byte pool id; matching only 40 hex
// chars would silently truncate it into a meaningless address.
const POOL_RE = /0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}/

export default function App() {
  const [scan, setScan] = useState(null)
  const [scanErr, setScanErr] = useState(null)
  const [target, setTarget] = useState(null) // {address, chain, label?} → detail view
  const [paste, setPaste] = useState('')
  const [resolving, setResolving] = useState(false)

  // detail-view state
  const [series, setSeries] = useState(null)
  const [meta, setMeta] = useState(null)
  const [windowDays, setWindowDays] = useState(30)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const loadSeq = useRef(0)

  const view = target ? 'detail' : 'table'
  useEffect(() => {
    document.body.dataset.view = view
  }, [view])

  // ---- the precomputed scan table ----
  useEffect(() => {
    let on = true
    // 'no-cache' revalidates instead of serving a stale copy: the browser sends
    // the ETag and gets a cheap 304 when nothing changed, but picks up the new
    // file the moment CI refreshes it. Without this a returning visitor keeps
    // whatever scan.json they cached and never sees the nightly rebuild.
    fetch(SCAN_URL, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`scan.json ${r.status}`)
        return r.json()
      })
      .then((d) => on && setScan(d))
      .catch((e) => on && setScanErr(e))
    return () => { on = false }
  }, [])

  // ---- live per-pool detail ----
  useEffect(() => {
    if (!target) return
    const seq = ++loadSeq.current
    setStatus('loading'); setError(null); setSeries(null); setMeta(null)
    fetchPoolSeries(target.id || target.address, target.chain)
      .then(({ rows, meta: m }) => {
        if (seq !== loadSeq.current) return
        const norm = normalizeSeries(rows)
        if (norm.length < 2) {
          setStatus('error')
          setError(new Error('Not enough daily history for this pool yet (needs at least 2 trading days).'))
          return
        }
        setSeries(norm); setMeta(m); setStatus('ready')
      })
      .catch((e) => {
        if (seq !== loadSeq.current) return
        setStatus('error'); setError(e)
      })
  }, [target])

  const maxWin = series ? maxWindowDays(series) : 0
  const live = series ? isLive(series) : false

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

  async function openPasted() {
    const m = paste.match(POOL_RE)
    if (!m) { setScanErr(new Error('Paste a Balancer pool link or a 0x pool address.')); return }
    const addr = m[0].toLowerCase()
    // if it's already in the scan we know the chain without a round-trip
    const known = scan?.rows.find((r) => r.address === addr || r.id?.toLowerCase() === addr)
    if (known) { setPaste(''); setTarget({ id: known.id, address: known.address, chain: known.chain }); return }
    setResolving(true); setScanErr(null)
    try {
      const r = await resolvePool(addr)
      if (!r) throw new Error('That pool was not found on any Balancer chain.')
      setPaste('')
      setTarget({ id: r.id, address: r.address || addr, chain: r.chain })
    } catch (e) {
      setScanErr(e)
    } finally {
      setResolving(false)
    }
  }

  // ------------------------------------------------------------------ table
  if (view === 'table') {
    return (
      <>
        <div className="head">
          <h1>
            LP vs HODL
            <span className="tag">Balancer v1 · v2 · v3 — every pool, every chain</span>
          </h1>
          <p>
            For every Balancer pool — v1, v2 and v3, on every chain: would you have more value{' '}
            <b>providing liquidity</b> or just <b>holding the tokens</b> you would have deposited?
            Each number is the pool’s value-per-share — which already nets swap fees, impermanent
            loss and the LVR paid to arbitrageurs — measured against that same basket simply held.
            Sort, filter, or click a row for the full chart.
          </p>
        </div>

        <div className="tablebar" style={{ marginBottom: 18 }}>
          <input
            className="search"
            type="text"
            placeholder="Paste a balancer.fi pool link or 0x address…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && openPasted()}
            spellCheck={false}
          />
          <button className="btn" onClick={openPasted} disabled={resolving || !paste.trim()}>
            {resolving ? 'Finding…' : 'Analyse'}
          </button>
          <span className="muted tinystat">
            {scan
              ? `${scan.rows.length} pools · refreshed ${String(scan.generatedAt).slice(0, 10)}`
              : scanErr ? '' : 'loading…'}
          </span>
        </div>

        {scanErr && <div className="err">{String(scanErr.message || scanErr)}</div>}

        {!scan && !scanErr && <div className="loading">Loading the pool table…</div>}

        {scan && (
          <PoolTable
            rows={scan.rows}
            generatedAt={scan.generatedAt}
            blacklistedCount={scan.blacklistedCount}
            excludedChains={scan.excludedChains}
            onSelect={(r) => setTarget({ id: r.id, address: r.address, chain: r.chain })}
          />
        )}
      </>
    )
  }

  // ----------------------------------------------------------------- detail
  return (
    <>
      <button className="backbtn" onClick={() => setTarget(null)}>← all pools</button>

      <div className="head">
        <h1>
          {meta ? meta.label : shortAddr(target.address)}
          <span className="tag">
            {chainName(target.chain)}
            {meta ? ` · ${meta.type}` : ''}
            {meta?.tvl ? ` · ${fmtUsd(meta.tvl)} TVL` : ''}
          </span>
        </h1>
        <p>
          Value of <b>$100</b> put in as <b>liquidity</b> versus <b>simply holding</b> the same
          basket, indexed to 100 at entry. The gap between the two lines is what providing liquidity
          actually earned or cost you.
        </p>
      </div>

      <div className="controls">
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
      </div>

      {error && <div className="err">{String(error.message || error)}</div>}
      {status === 'loading' && <div className="loading">Loading from the Balancer API…</div>}

      {win && (
        <>
          {win.clamped && (
            <div className="note">
              Only <b>{win.availDays} days</b> of history exist for this pool — showing the full
              available life instead of the requested {windowDays}-day window.
            </div>
          )}
          {meta?.incentiveApr > 0 && (
            <div className="note">
              This pool also pays roughly <b>{(meta.incentiveApr * 100).toFixed(1)}% APR</b> in
              external incentives (Merkl / staking). Those go to liquidity providers only and are{' '}
              <b>not</b> included below — the real LP result is better than shown here.
            </div>
          )}

          <StatCards win={win} />

          {win.boosted && (
            <div className="note">
              <b>Boosted pool.</b> Against the wrapped tokens the pool holds, the LP is{' '}
              <b>{win.gapFinal >= 0 ? '+' : ''}{win.gapFinal.toFixed(2)}%</b> — that comparison
              cancels the yield out, so it measures the AMM alone. Against the{' '}
              <b>underlying assets you would actually have deposited</b> (which earn nothing sitting
              in a wallet) it is{' '}
              <b style={{ color: win.gapUnderFinal >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {win.gapUnderFinal >= 0 ? '+' : ''}{win.gapUnderFinal.toFixed(2)}%
              </b>
              . The{' '}
              {/* derive from the rounded figures shown above so the arithmetic reads consistently */}
              {Math.abs(+win.gapUnderFinal.toFixed(2) - +win.gapFinal.toFixed(2)).toFixed(2)}%
              {' '}difference is the wrapper's accrued yield over this window.
            </div>
          )}

          <div className="panel">
            <h2>
              {win.label} — position value over time
              <span className="tag">
                {chainName(target.chain)} ·{' '}
                {live ? 'live · trailing from today' : `as of ${win.endDate} (no trading activity since)`}
              </span>
            </h2>
            <p className="ph">
              $100 entered {win.entryDate}, indexed to 100. The gap between the lines is the LP’s
              fee-minus-divergence result; both move together with the token prices.
            </p>
            <div className="legend">
              <span><span className="dot" style={{ background: 'var(--purple)' }} /><b>LP (in the pool)</b></span>
              <span><span className="dot" style={{ background: 'var(--green)' }} /><b>HODL the pool's tokens</b></span>
              {win.boosted && (
                <span><span className="dot" style={{ background: 'var(--amber)' }} /><b>HODL the underlying</b></span>
              )}
            </div>
            <ValueChart pts={win.pts} showUnderlying={win.boosted} />
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
            <b>Method:</b> LP value-per-share = Σ(reserve·price) / BPT supply from the Balancer API’s
            official daily pool snapshots — reserves are subgraph-accurate and already exclude the
            protocol-fee skim, so this nets swap fees, impermanent loss and LVR. HODL = the basket
            per share at entry, held and marked with the same daily prices. Yield-bearing tokens lift
            both legs equally and so cancel out; external gauge/Merkl incentives are not included and
            would lift the LP leg.
            {' '}
            <a
              href={BALANCER_POOL_URL(
                target.chain,
                (meta?.protocolVersion ?? 3) === 2 ? (meta?.id || target.id || target.address) : target.address,
                meta?.protocolVersion ?? 3
              )}
              target="_blank"
              rel="noreferrer"
            >
              Balancer pool ({chainName(target.chain)})
            </a>
            {' · '}
            <a href={EXPLORER_ADDR(target.chain, target.address)} target="_blank" rel="noreferrer">{shortAddr(target.address)}</a>
            {target.chain === 'MAINNET' && (
              <>
                {' · '}cross-check:{' '}
                <a href={DUNE_QUERY_URL} target="_blank" rel="noreferrer">Dune #{DUNE_QUERY_ID}</a>
                {' '}(independent event-replay reconstruction)
              </>
            )}
          </p>
        </>
      )}
    </>
  )
}
