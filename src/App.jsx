import React, { useEffect, useMemo, useState } from 'react'
import {
  POOLS, WINDOWS, DUNE_QUERY_ID, DUNE_QUERY_URL,
  BALANCER_POOL_URL, EXPLORER_ADDR,
} from './config'
import { getDuneApiKey, subscribeDuneApiKey } from './lib/duneApiKey'
import { getLatestResults, executeAndPoll } from './lib/dune'
import { SAMPLE_SERIES } from './lib/sampleData'
import { normalizeSeries, computeWindow, maxWindowDays, isLive } from './lib/series'
import ApiKeyPanel from './components/ApiKeyPanel'
import StatCards from './components/StatCards'
import ValueChart from './components/ValueChart'
import GapChart from './components/GapChart'
import { shortAddr } from './lib/format'

const WIN_LABEL = { 1: '1D', 7: '7D', 14: '14D', 30: '30D', 60: '60D', 90: '90D', 180: '180D' }

export default function App() {
  const [poolAddr, setPoolAddr] = useState(POOLS[0].address)
  const [custom, setCustom] = useState('')
  const [windowDays, setWindowDays] = useState(30)
  const [series, setSeries] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [usingSample, setUsingSample] = useState(false)
  const [executedAt, setExecutedAt] = useState(null)
  const [keyV, setKeyV] = useState(0)

  useEffect(() => subscribeDuneApiKey(() => setKeyV((v) => v + 1)), [])

  const activeAddr = (custom.trim() || poolAddr).toLowerCase()

  async function load({ force = false } = {}) {
    const addr = activeAddr
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      setStatus('error'); setError(new Error('Enter a valid 0x pool address.')); return
    }
    const sample = SAMPLE_SERIES[addr]
    const key = getDuneApiKey()

    if (!key && !force) {
      if (sample) {
        setSeries(normalizeSeries(sample)); setUsingSample(true); setExecutedAt(null); setStatus('ready'); setError(null)
        return
      }
      setStatus('error'); setError({ code: 'NO_KEY' }); return
    }

    setStatus('loading'); setError(null)
    try {
      let res
      if (force) {
        res = await executeAndPoll(DUNE_QUERY_ID, { pool: addr })
      } else {
        res = await getLatestResults(DUNE_QUERY_ID, { pool: addr })
        if (res.isEmpty) res = await executeAndPoll(DUNE_QUERY_ID, { pool: addr })
      }
      const norm = normalizeSeries(res.rows)
      if (!norm.length) {
        if (sample) { setSeries(normalizeSeries(sample)); setUsingSample(true); setStatus('ready'); return }
        setStatus('error'); setError(new Error('No reCLAMM data for this pool on Ethereum.')); return
      }
      setSeries(norm); setUsingSample(false); setExecutedAt(res.executedAt); setStatus('ready')
    } catch (e) {
      if (sample) { setSeries(normalizeSeries(sample)); setUsingSample(true); setExecutedAt(null); setStatus('ready'); setError(e); return }
      setStatus('error'); setError(e)
    }
  }

  // reload on pool / key change
  useEffect(() => { load() /* eslint-disable-next-line */ }, [activeAddr, keyV])

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
          to 100 at entry. Pick a pool and a look-back window.
        </p>
      </div>

      <ApiKeyPanel />

      <div className="controls">
        <div className="field">
          <label>Pool</label>
          <select
            value={custom.trim() ? '' : poolAddr}
            onChange={(e) => { setCustom(''); setPoolAddr(e.target.value) }}
          >
            {POOLS.map((p) => (
              <option key={p.address} value={p.address}>
                {p.label} · {p.cohort}
              </option>
            ))}
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
            disabled={!getDuneApiKey() || status === 'loading'}
            onClick={() => load({ force: true })}
            title={getDuneApiKey() ? 'Run the Dune query fresh' : 'Add a Dune key to refresh'}
          >
            {status === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {usingSample && (
        <div className="note">
          Showing a bundled <b>sample snapshot</b> of real on-chain data. Add your Dune API key above
          to load live data and any other reCLAMM pool.
        </div>
      )}
      {error && error.code === 'NO_KEY' && (
        <div className="err">
          This pool isn’t in the bundled sample. Paste a Dune API key above to load it
          (free tier works — <a href="https://dune.com/settings/api" target="_blank" rel="noreferrer">get one here</a>).
        </div>
      )}
      {error && error.code !== 'NO_KEY' && (
        <div className="err">{String(error.message || error)}</div>
      )}

      {status === 'loading' && !series && <div className="loading">Running the Dune query…</div>}

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
              <span className="tag">{live ? 'live · trailing from today' : `as of ${win.endDate} (pool retired/suspended)`}</span>
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
            <b>Method:</b> LP value-per-share = TVL / BPT supply, reconstructed from Balancer v3 Vault
            events; it already nets fees, IL and the LVR cost of auto-ranging (reCLAMM’s range shift is
            virtual and in-protocol — no keeper or LP gas). HODL = the deposited basket marked with the
            same prices. <b>Conservative:</b> reserves don’t subtract the protocol-fee skim (true LP drag
            marginally worse), and any gauge incentives would offset upward — both to be calibrated.
            {' '}Source:{' '}
            <a href={DUNE_QUERY_URL} target="_blank" rel="noreferrer">Dune #{DUNE_QUERY_ID}</a>
            {' · '}
            <a href={BALANCER_POOL_URL(activeAddr)} target="_blank" rel="noreferrer">Balancer pool</a>
            {' · '}
            <a href={EXPLORER_ADDR(activeAddr)} target="_blank" rel="noreferrer">{shortAddr(activeAddr)}</a>
            {executedAt ? ` · data ${String(executedAt).slice(0, 10)}` : ''}
          </p>
        </>
      )}
    </>
  )
}
