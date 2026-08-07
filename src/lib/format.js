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

/* fmtDate above keeps the first ten characters of an ISO instant, which is right for a
   calendar day but wrong for "when was this last built" — a scan finished eight hours ago and
   one finished eight minutes ago read identically. UTC is stated rather than converted to the
   viewer's clock, because the scan runs in UTC and a bare local time would differ per reader
   with nothing on screen saying so. */
export const fmtStamp = (iso) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso || '').slice(0, 10)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/** Relative age — the part you actually read to judge whether the data is stale. */
export const ago = (iso) => {
  const ms = Date.now() - new Date(iso).getTime()
  if (!isFinite(ms) || ms < 0) return null
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 48) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}
