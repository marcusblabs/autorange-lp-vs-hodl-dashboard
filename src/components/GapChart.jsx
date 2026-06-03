import React from 'react'
import { fmtDateShort } from '../lib/format'

const W = 1020
const P = { l: 46, r: 14, t: 14, b: 26 }
const xAt = (i, n) => P.l + (n <= 1 ? 0 : (i * (W - P.l - P.r)) / (n - 1))

export default function GapChart({ pts }) {
  const H = 190
  const n = pts.length
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

  return (
    <svg viewBox={`0 0 ${W} ${H}`}>
      {grid}
      {xt}
      <path d={area} fill="#f2636e" opacity="0.1" />
      <line x1={P.l} y1={yz} x2={W - P.r} y2={yz} stroke="#9aa4b2" strokeWidth="1" opacity="0.5" />
      <path d={d} fill="none" stroke="#f2636e" strokeWidth="2.1" strokeLinejoin="round" />
    </svg>
  )
}
