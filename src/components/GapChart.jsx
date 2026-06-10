import React from 'react'
import { fmtDate, fmtDateShort, fmtPct } from '../lib/format'
import { W, P, xAt, xPct } from '../lib/chartGeom'
import { useHoverIndex } from './useHoverIndex'

export default function GapChart({ pts }) {
  const H = 190
  const n = pts.length
  const { ref, idx, onMove, onLeave } = useHoverIndex(n)
  const g = pts.map((p) => p.gap)
  const lo = Math.min(...g, 0)
  const hi = Math.max(...g, 0)
  const pad = Math.max(0.2, (hi - lo) * 0.12)
  const yMin = lo - pad
  const yMax = hi + pad
  const yOf = (v) => P.t + (1 - (v - yMin) / (yMax - yMin)) * (H - P.t - P.b)

  const grid = []
  for (let k = 0; k <= 4; k++) {
    const v = yMin + ((yMax - yMin) * k) / 4
    const y = yOf(v)
    grid.push(<line key={'g' + k} className="gl" x1={P.l} y1={y} x2={W - P.r} y2={y} />)
    grid.push(
      <text key={'yl' + k} className="ax" x={P.l - 8} y={y + 3} textAnchor="end">{(v >= 0 ? '+' : '') + v.toFixed(1) + '%'}</text>
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
  let d = ''
  g.forEach((v, i) => {
    d += (i ? 'L' : 'M') + xAt(i, n).toFixed(1) + ' ' + yOf(v).toFixed(1) + ' '
  })
  const area = d + 'L' + xAt(n - 1, n) + ' ' + yOf(0) + ' L' + xAt(0, n) + ' ' + yOf(0) + ' Z'
  const yz = yOf(0)

  const hov = idx != null ? pts[idx] : null

  return (
    <div className="chartwrap">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={onLeave}>
        {grid}
        {xt}
        <path d={area} fill="#f2636e" opacity="0.1" />
        <line x1={P.l} y1={yz} x2={W - P.r} y2={yz} stroke="#9aa4b2" strokeWidth="1" opacity="0.5" />
        <path d={d} fill="none" stroke="#f2636e" strokeWidth="2.1" strokeLinejoin="round" />
        {hov && (
          <g className="cross" pointerEvents="none">
            <line x1={xAt(idx, n)} y1={P.t} x2={xAt(idx, n)} y2={H - P.b} />
            <circle cx={xAt(idx, n)} cy={yOf(hov.gap)} r="3.6" fill="#f2636e" stroke="var(--panel)" strokeWidth="1.4" />
          </g>
        )}
      </svg>
      {hov && (
        <div className={'tip' + (xPct(idx, n) > 62 ? ' flip' : '')} style={{ left: xPct(idx, n) + '%' }}>
          <div className="tip-d">{fmtDate(hov.day)}</div>
          <div className="tip-g">LP − HODL <b className={hov.gap >= 0 ? 'pos' : 'neg'}>{fmtPct(hov.gap)}</b></div>
        </div>
      )}
    </div>
  )
}
