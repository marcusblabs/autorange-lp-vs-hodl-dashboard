import React from 'react'
import { fmtMoney2, fmtPct, fmtUsd } from '../lib/format'

/**
 * The detail view's headline verdict.
 *
 * `basis` is not optional decoration: for a boosted pool the two counterfactuals
 * can disagree on the SIGN of the answer (108 pool/window pairs do, in the
 * current data). This card used to render win.gapFinal unconditionally, so a
 * reader who set the table to "Holding the underlying" and clicked a row got the
 * opposite conclusion with nothing on screen saying the question had changed.
 */
export default function StatCards({ win, basis = 'WRAPPED' }) {
  const under = basis === 'UNDERLYING' && win.boosted
  const gap = under ? win.gapUnderFinal : win.gapFinal
  const hodl = under ? win.hodlUnderFinal : win.hodlFinal
  const ahead = gap >= 0
  const heldLabel = under ? 'the underlying assets, just held' : `same ${win.nTokens === 2 ? 'two tokens' : `${win.nTokens} tokens`}, just held`

  return (
    <div className="cards">
      <div className="card">
        <div className="lbl"><span className="dot" style={{ background: 'var(--purple)' }} />LP — final value</div>
        <div className="val">{fmtMoney2(win.lpFinal)}</div>
        <div className="sub">from $100 entered {win.entryDate}</div>
      </div>
      <div className="card">
        <div className="lbl">
          <span className="dot" style={{ background: under ? 'var(--amber)' : 'var(--green)' }} />
          HODL — final value
        </div>
        <div className="val">{fmtMoney2(hodl)}</div>
        <div className="sub">{heldLabel}</div>
      </div>
      <div className="card">
        {/* The label names the comparison, so the number can never be read
            against the wrong counterfactual. */}
        <div className="lbl">LP − HODL{win.boosted ? (under ? ' (vs underlying)' : ' (vs vault token)') : ''}</div>
        <div className="val" style={{ color: ahead ? 'var(--green)' : 'var(--red)' }}>{fmtPct(gap)}</div>
        <div className="sub">{ahead ? 'providing liquidity won' : 'holding won'}</div>
      </div>
      <div className="card">
        <div className="lbl">Peak TVL</div>
        <div className="val sm">{fmtUsd(win.peakTvl)}</div>
        <div className="sub">{win.availDays}d of history</div>
      </div>
    </div>
  )
}
