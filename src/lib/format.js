export const fmtPct = (v, dp = 2) =>
  (v >= 0 ? '+' : '') + Number(v).toFixed(dp) + '%'

export const fmtUsd = (v) => {
  const n = Number(v)
  if (!isFinite(n)) return '—'
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k'
  return '$' + n.toFixed(0)
}

export const fmtMoney2 = (v) => '$' + Number(v).toFixed(2)

export const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '')

export const fmtDate = (iso) => String(iso).slice(0, 10)

export const fmtDateShort = (iso) => String(iso).slice(2, 10) // YY-MM-DD
