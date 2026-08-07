import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  WINDOWS, chainName, SCAN_URL,
  DUNE_QUERY_ID, DUNE_QUERY_URL, BALANCER_POOL_URL, EXPLORER_ADDR,
} from './config'
import { fetchPoolSeries, resolvePool } from './lib/balancer'
import { normalizeSeries, computeWindow, maxWindowDays, isLive, windowFits } from './lib/series'
import PoolTable from './components/PoolTable'
import StatCards from './components/StatCards'
import ValueChart from './components/ValueChart'
import GapChart from './components/GapChart'
import { shortAddr, fmtUsd, fmtStamp, ago } from './lib/format'

const WIN_LABEL = { 1: '1D', 7: '7D', 14: '14D', 30: '30D', 60: '60D', 90: '90D', 180: '180D' }
// A v2 balancer.fi link carries the 32-byte pool id; matching only 40 hex
// chars would silently truncate it into a meaningless address.
const POOL_RE = /0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}/
const DAY_MS = 86400000

/**
 * End the chart on the same completed day the table was built through.
 *
 * Both sides already drop the in-progress UTC day, which is what made them
 * disagree. That still leaves the hours between UTC midnight and the nightly
 * scan, when a browser has rolled onto a new completed day and the table has
 * not — the same complaint, one day wide, every night.
 *
 * Only followed when the table is at most a day behind. If scan.json is stale
 * because CI has been failing, pinning to it would silently throw away days of
 * good chart data to match a table that is itself wrong; better to let the two
 * dates differ visibly, which the "through <date>" labels now show.
 */
function clampToScanDay(series, throughDay) {
  if (!throughDay || !series.length) return series
  const end = series[series.length - 1].day
  if (throughDay >= end) return series
  if (Date.parse(end) - Date.parse(throughDay) > DAY_MS) return series
  return series.filter((p) => p.day <= throughDay)
}

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
  const [refreshing, setRefreshing] = useState(false)
  // Which counterfactual the whole page is measured against. Owned here so the
  // table and the detail view can never answer the same question differently:
  // 108 pool/window pairs in the current data have OPPOSITE SIGNS on the two
  // bases, and the detail view used to hardcode the vault-token one.
  const [basis, setBasis] = useState('WRAPPED')
  // The table's search, filters and sort. Held here rather than inside
  // PoolTable, which is unmounted whenever a pool is open — see the note on
  // that component. Paired with scrollRef below so "← all pools" returns to the
  // view that was left, not to a reset one.
  const [tableView, setTableView] = useState({
    sort: { key: 'tvl', dir: 'desc' },
    query: '',
    minTvl: 0,
    chain: 'ALL',
    type: 'ALL',
    ver: 'ALL',
    show: 'LIVE',
  })
  const scrollRef = useRef(0)
  const loadSeq = useRef(0)

  const view = target ? 'detail' : 'table'
  useEffect(() => {
    document.body.dataset.view = view
  }, [view])

  // Remember where the reader was in the list, and put them back there.
  // useLayoutEffect, not useEffect: the table has to be laid out before the
  // scroll can land, otherwise the page is still short and the position clamps
  // to the bottom of a one-screen document.
  const openPool = (r) => {
    scrollRef.current = window.scrollY
    setTarget({ id: r.id, address: r.address, chain: r.chain })
  }
  useLayoutEffect(() => {
    if (target) window.scrollTo(0, 0)
    else if (scrollRef.current) window.scrollTo(0, scrollRef.current)
  }, [target])

  // One definition of "raw rows → the series both views chart and tabulate".
  // Kept in a single place on purpose: the table and the chart disagreeing was
  // exactly the bug that came from two code paths each doing this their own way.
  const seriesFrom = (rows, throughDay) => clampToScanDay(normalizeSeries(rows), throughDay)

  // ---- the precomputed scan table ----
  // 'no-cache' revalidates instead of serving a stale copy: the browser sends
  // the ETag and gets a cheap 304 when nothing changed, but picks up the new
  // file the moment CI refreshes it. Without this a returning visitor keeps
  // whatever scan.json they cached and never sees the nightly rebuild.
  // 'reload' (the refresh button) skips even the revalidation.
  const loadScan = async (bypassCache) => {
    setScanErr(null)
    try {
      const r = await fetch(SCAN_URL, { cache: bypassCache ? 'reload' : 'no-cache' })
      if (!r.ok) throw new Error(`scan.json ${r.status}`)
      const d = await r.json()
      setScan(d)
      return d
    } catch (e) {
      setScanErr(e)
      return null
    }
  }

  useEffect(() => { loadScan(false) }, [])

  // ---- live per-pool detail ----
  useEffect(() => {
    if (!target) return
    const seq = ++loadSeq.current
    setStatus('loading'); setError(null); setSeries(null); setMeta(null)
    fetchPoolSeries(target.id || target.address, target.chain)
      .then(({ rows, meta: m }) => {
        if (seq !== loadSeq.current) return
        const norm = seriesFrom(rows, scan?.throughDay)
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
  }, [target, scan?.throughDay])

  // Refresh has to defeat two caches, not one: the browser's copy of scan.json
  // and the 10-minute in-page cache in balancer.js that fetchPoolSeries reads.
  // Skipping the second would make the button look like it worked while the
  // chart kept showing the same numbers for ten minutes.
  //
  // The table is reloaded first so the chart is clamped to the *new* throughDay
  // — refreshing across a nightly rebuild would otherwise pin the fresh series
  // back to yesterday's boundary.
  const onRefresh = async () => {
    setRefreshing(true)
    const seq = ++loadSeq.current
    try {
      const fresh = await loadScan(true)
      if (!target) return
      const { rows, meta: m } = await fetchPoolSeries(target.id || target.address, target.chain, {
        force: true,
      })
      if (seq !== loadSeq.current) return // user navigated away mid-refresh
      const norm = seriesFrom(rows, (fresh || scan)?.throughDay)
      if (norm.length < 2) throw new Error('Not enough daily history for this pool yet.')
      setSeries(norm); setMeta(m); setStatus('ready'); setError(null)
    } catch (e) {
      if (seq === loadSeq.current && target) { setStatus('error'); setError(e) }
    } finally {
      setRefreshing(false)
    }
  }

  const maxWin = series ? maxWindowDays(series) : 0
  const live = series ? isLive(series) : false

  // Clamp the look-back to what THIS pool supports, then restore it for the
  // next one. The clamp used to be one-way: opening a two-day-old pool knocked
  // the selection down to 1D and left it there, so every pool opened afterwards
  // — however long its history — was silently charted over a single day until
  // the reader noticed and clicked back up. `preferredWindow` remembers what was
  // actually asked for; windowDays is only ever the clamped view of it.
  const preferredWindow = useRef(30)
  useEffect(() => {
    if (!series) return
    const want = preferredWindow.current
    if (want == null || windowFits(maxWin, want)) {
      setWindowDays(want)
      return
    }
    const feasible = [...WINDOWS].reverse().find((w) => windowFits(maxWin, w))
    setWindowDays(feasible ?? null)
    // eslint-disable-next-line
  }, [series])

  const win = useMemo(
    () => (series ? computeWindow(series, windowDays) : null),
    [series, windowDays]
  )

  // Kept separate from scanErr. Sharing one error slot meant a typo in the
  // paste box rendered as a table-load failure and, because the table only
  // renders when `!scanErr`, replaced the whole table with the message.
  const [pasteErr, setPasteErr] = useState(null)

  async function openPasted() {
    const m = paste.match(POOL_RE)
    if (!m) { setPasteErr(new Error('Paste a Balancer pool link or a 0x pool address.')); return }
    const addr = m[0].toLowerCase()
    // If it is already in the scan we know the chain without a round-trip.
    // Matched on id first: 7 addresses in the current scan belong to two
    // different pools on two different chains, and an address-only match would
    // open whichever happened to sort first.
    const known =
      scan?.rows.find((r) => r.id?.toLowerCase() === addr) ||
      scan?.rows.find((r) => r.address === addr)
    if (known) { setPaste(''); setPasteErr(null); setTarget({ id: known.id, address: known.address, chain: known.chain }); return }
    setResolving(true); setPasteErr(null)
    try {
      const r = await resolvePool(addr)
      if (!r) throw new Error('That pool was not found on any Balancer chain.')
      setPaste('')
      setTarget({ id: r.id, address: r.address || addr, chain: r.chain })
    } catch (e) {
      setPasteErr(e)
    } finally {
      setResolving(false)
    }
  }

  // The scan's trust flags are the reason a row is hidden behind the SHOW filter;
  // dropping them on the detail page meant the one screen a reader studies
  // closely was the only one that never warned them.
  const targetFlags = target
    ? scan?.rows.find((r) => r.id === target.id || r.address === target.address)?.flags || []
    : []

  // ------------------------------------------------------------------ table
  if (view === 'table') {
    return (
      <>
        <div className="head">
          <h1>
            LP vs HODL
            <span className="tag">Balancer v1 · v2 · v3 — every chain, every pool above $1k</span>
          </h1>
          <p>
            For every Balancer pool above <b>$1k TVL</b> — v1, v2 and v3, on every chain: would you
            have more value <b>providing liquidity</b> or just <b>holding the tokens</b> you would
            have deposited? Each number is the pool’s value-per-share — which already nets swap
            fees, impermanent loss and the LVR paid to arbitrageurs — measured against that same
            basket simply held. Sort, filter, or click a row for the full chart.
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
              ? `${scan.rows.length} pools · refreshed ${fmtStamp(scan.generatedAt)}${ago(scan.generatedAt) ? ' · ' + ago(scan.generatedAt) : ''}`
              : scanErr ? '' : 'loading…'}
          </span>
        </div>

        {pasteErr && <div className="err">{String(pasteErr.message || pasteErr)}</div>}
        {scanErr && <div className="err">{String(scanErr.message || scanErr)}</div>}

        {!scan && !scanErr && <div className="loading">Loading the pool table…</div>}

        {scan && (
          <PoolTable
            rows={scan.rows}
            generatedAt={scan.generatedAt}
            blacklistedCount={scan.blacklistedCount}
            excludedChains={scan.excludedChains}
            onSelect={openPool}
            onRefresh={onRefresh}
            refreshing={refreshing}
            basis={basis}
            setBasis={setBasis}
            counts={scan.counts}
            minTvlFloor={scan.minTvl}
            view={tableView}
            setView={setTableView}
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
                disabled={!windowFits(maxWin, w)}
                onClick={() => { preferredWindow.current = w; setWindowDays(w) }}
              >
                {WIN_LABEL[w]}
              </button>
            ))}
            <button
              className={windowDays == null ? 'on' : ''}
              onClick={() => { preferredWindow.current = null; setWindowDays(null) }}
            >
              Full
            </button>
          </div>
        </div>
        {/* Same control as the table's, so the basis can be changed without
            navigating back — and so this page never silently answers a
            different question than the one the table was set to. */}
        {win?.boosted && (
          <div className="field">
            <label>VS</label>
            <div className="seg">
              <button className={basis === 'WRAPPED' ? 'on' : ''} onClick={() => setBasis('WRAPPED')}>
                Vault token
              </button>
              <button className={basis === 'UNDERLYING' ? 'on' : ''} onClick={() => setBasis('UNDERLYING')}>
                Underlying
              </button>
            </div>
          </div>
        )}
        <div className="field">
          <label>Data</label>
          <button
            className="fbtn refresh"
            onClick={onRefresh}
            disabled={refreshing || status === 'loading'}
            title="Re-read this pool's snapshots and prices from the Balancer API, bypassing the 10-minute in-page cache. The series still ends on the last completed UTC day."
          >
            {refreshing ? '[ REFRESHING… ]' : '[ REFRESH ]'}
          </button>
        </div>
      </div>

      {error && <div className="err">{String(error.message || error)}</div>}
      {status === 'loading' && <div className="loading">Loading from the Balancer API…</div>}

      {win && (
        <>
          {/* The scan hides flagged pools behind a filter and explains why on the
              row. Reaching the same pool by clicking through or by pasting a link
              used to bypass that warning entirely. */}
          {targetFlags.length > 0 && (
            <div className="note warn">
              <b>⚑ Treat these numbers with suspicion.</b>{' '}
              {targetFlags.length === 1 ? targetFlags[0] : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {targetFlags.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
            </div>
          )}
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

          <StatCards win={win} basis={basis} />

          {win.boosted && (
            <div className="note">
              <b>Boosted pool — two honest answers.</b> Against the wrapped tokens the pool holds,
              the LP is{' '}
              <b>{win.gapFinal >= 0 ? '+' : ''}{win.gapFinal.toFixed(2)}%</b>; that comparison
              cancels the yield out, so it measures the AMM alone. Against the{' '}
              <b>underlying assets you would actually have deposited</b> (which earn nothing sitting
              in a wallet) it is{' '}
              <b style={{ color: win.gapUnderFinal >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {win.gapUnderFinal >= 0 ? '+' : ''}{win.gapUnderFinal.toFixed(2)}%
              </b>
              . The{' '}
              {/* derive from the rounded figures shown above so the arithmetic reads consistently */}
              {Math.abs(+win.gapUnderFinal.toFixed(2) - +win.gapFinal.toFixed(2)).toFixed(2)}%
              {' '}difference is the wrapper's accrued yield over this window. The cards above show
              the <b>{basis === 'UNDERLYING' ? 'underlying' : 'vault token'}</b> comparison — switch
              it with <b>VS</b> in the controls.
              {Math.sign(win.gapFinal) !== Math.sign(win.gapUnderFinal) && (
                <> <b style={{ color: 'var(--amber)' }}>The two disagree on the sign here</b>, so
                which one you want is the whole question.</>
              )}
            </div>
          )}

          <div className="panel">
            <h2>
              {win.label} — position value over time
              <span className="tag">
                {chainName(target.chain)} ·{' '}
                {live ? `live · through ${win.endDate}` : `as of ${win.endDate} (no trading activity since)`}
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
            would lift the LP leg. The series ends on the last <b>completed</b> UTC day — today's
            snapshot covers only the hours elapsed so far, so including it would make the result
            depend on what time you loaded the page and disagree with the table.
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
