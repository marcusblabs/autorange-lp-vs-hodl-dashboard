import React from 'react'
import { fmtMoney2, fmtPct, fmtUsd } from '../lib/format'

export default function StatCards({ win }) {
  const ahead = win.gapFinal >= 0
  return (
    <div className="cards">
      <div className="card">
        <div className="lbl"><span className="dot" style={{ background: 'var(--purple)' }} />LP — final value</div>
        <div className="val">{fmtMoney2(win.lpFinal)}</div>
        <div className="sub">from $100 entered {win.entryDate}</div>
      </div>
      <div className="card">
        <div className="lbl"><span className="dot" style={{ background: 'var(--green)' }} />HODL — final value</div>
        <div className="val">{fmtMoney2(win.hodlFinal)}</div>
        <div className="sub">same two tokens, just held</div>
      </div>
      <div className="card">
        <div className="lbl">LP − HODL</div>
        <div className="val" style={{ color: ahead ? 'var(--green)' : 'var(--red)' }}>{fmtPct(win.gapFinal)}</div>
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
