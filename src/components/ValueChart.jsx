import React from 'react'
import { fmtDate, fmtDateShort, fmtPct } from '../lib/format'
import { W, P, xAt, xPct } from '../lib/chartGeom'
import { useHoverIndex } from './useHoverIndex'

function path(vals, yOf, n) {
  let d = ''
  vals.forEach((v, i) => {
    d += (i ? 'L' : 'M') + xAt(i, n).toFixed(1) + ' ' + yOf(v).toFixed(1) + ' '
  })
  return d
}

export default function ValueChart({ pts }) {
  const H = 300
  const n = pts.length
  const { ref, idx, onMove, onLeave } = useHoverIndex(n)
  const lp = pts.map((p) => p.lp)
  const hd = pts.map((p) => p.hodl)
  const lo = Math.min(...lp, ...hd)
  const hi = Math.max(...lp, ...hd)
  const pad = Math.max(0.25, (hi - lo) * 0.08) // small floor so stable/stable pools aren't a flat line
  const yMin = lo - pad
  const yMax = hi + pad
  const yOf = (v) => P.t + (1 - (v - yMin) / (yMax - yMin)) * (H - P.t - P.b)

  const dp = yMax - yMin < 1 ? 2 : yMax - yMin < 8 ? 1 : 0 // keep tight ranges legible
  const grid = []
  for (let k = 0; k <= 5; k++) {
    const v = yMin + ((yMax - yMin) * k) / 5
    const y = yOf(v)
    grid.push(<line key={'g' + k} className="gl" x1={P.l} y1={y} x2={W - P.r} y2={y} />)
    grid.push(
      <text key={'yl' + k} className="ax" x={P.l - 8} y={y + 3} textAnchor="end">{v.toFixed(dp)}</text>
    )
  }
  const nx = Math.min(7, n)
  const xt = []
  for (let k = 0; k < nx; k++) {
    const i = Math.round((k * (n - 1)) / (nx - 1 || 1))
    xt.push(
      <text key={'x' + k} className="ax" x={xAt(i, n)} y={H - 8} textAnchor="middle">{fmtDateShort(pts[i].day)}</text>
    )
  }
  const hodlPath = path(hd, yOf, n)
  const lpPath = path(lp, yOf, n)
  const area = hodlPath + 'L' + xAt(n - 1, n) + ' ' + yOf(yMin) + ' L' + xAt(0, n) + ' ' + yOf(yMin) + ' Z'

  const hov = idx != null ? pts[idx] : null

  return (
    <div className="chartwrap">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={onLeave}>
        {grid}
        {xt}
        <path d={area} fill="#7f6ae8" opacity="0.08" />
        <path d={hodlPath} fill="none" stroke="#63f2be" strokeWidth="2.1" strokeLinejoin="round" />
        <path d={lpPath} fill="none" stroke="#7f6ae8" strokeWidth="2.1" strokeLinejoin="round" />
        {hov && (
          <g className="cross" pointerEvents="none">
            <line x1={xAt(idx, n)} y1={P.t} x2={xAt(idx, n)} y2={H - P.b} />
            <circle cx={xAt(idx, n)} cy={yOf(hov.hodl)} r="3.6" fill="#63f2be" stroke="var(--panel)" strokeWidth="1.4" />
            <circle cx={xAt(idx, n)} cy={yOf(hov.lp)} r="3.6" fill="#7f6ae8" stroke="var(--panel)" strokeWidth="1.4" />
          </g>
        )}
      </svg>
      {hov && (
        <div className={'tip' + (xPct(idx, n) > 62 ? ' flip' : '')} style={{ left: xPct(idx, n) + '%' }}>
          <div className="tip-d">{fmtDate(hov.day)}</div>
          <div className="tip-r"><span className="dot" style={{ background: 'var(--purple)' }} />LP<b>{hov.lp.toFixed(2)}</b></div>
          <div className="tip-r"><span className="dot" style={{ background: 'var(--green)' }} />HODL<b>{hov.hodl.toFixed(2)}</b></div>
          <div className="tip-g">LP − HODL {fmtPct(hov.gap)}</div>
        </div>
      )}
    </div>
  )
}
