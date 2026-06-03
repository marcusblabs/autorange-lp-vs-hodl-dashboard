/**
 * Minimal Dune API client (browser-side, user's own key).
 *
 * The saved query takes one parameter, `pool` (0x-prefixed address). We pass it
 * via query_parameters on execute. Two modes:
 *   getLatestResults(queryId, {pool}) — returns the most recent cached execution
 *                                       for that exact parameter set (no credit).
 *   executeAndPoll(queryId, {pool})   — spends a credit: runs fresh, polls.
 */

import { getDuneApiKey } from './duneApiKey'

const BASE = 'https://api.dune.com/api/v1'
const POLL_MS = 1500
const MAX_POLLS = 100 // ~2.5 min

function headers() {
  return { 'x-dune-api-key': getDuneApiKey(), 'Content-Type': 'application/json' }
}

function requireKey() {
  if (!getDuneApiKey()) {
    const e = new Error('No Dune API key set.')
    e.code = 'NO_KEY'
    throw e
  }
}

async function asError(res) {
  let detail = ''
  try {
    const j = await res.json()
    detail = j?.error || JSON.stringify(j)
  } catch {
    detail = await res.text().catch(() => '')
  }
  const e = new Error(`Dune API ${res.status}: ${detail || res.statusText}`)
  e.status = res.status
  return e
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch the last cached results for a saved query + parameter set. */
export async function getLatestResults(queryId, { pool, limit = 5000 } = {}) {
  requireKey()
  const qp = encodeURIComponent(JSON.stringify({ pool }))
  const url = `${BASE}/query/${queryId}/results?limit=${limit}&query_parameters=${qp}`
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) throw await asError(res)
  const json = await res.json()
  return {
    rows: json?.result?.rows ?? [],
    executedAt: json?.execution_ended_at || json?.result?.metadata?.execution_ended_at || null,
    isEmpty: !json?.result || (json?.result?.rows ?? []).length === 0,
  }
}

/** Execute a saved query fresh for a parameter set and poll to completion. */
export async function executeAndPoll(queryId, { pool, onState = () => {}, limit = 5000 } = {}) {
  requireKey()
  onState('executing')
  const exec = await fetch(`${BASE}/query/${queryId}/execute`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ performance: 'medium', query_parameters: { pool } }),
  })
  if (!exec.ok) throw await asError(exec)
  const { execution_id } = await exec.json()

  onState('polling')
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS)
    const sres = await fetch(`${BASE}/execution/${execution_id}/status`, { headers: headers() })
    if (!sres.ok) throw await asError(sres)
    const status = await sres.json()
    const state = status?.state
    if (state === 'QUERY_STATE_COMPLETED') break
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      throw new Error(`Query ${state.replace('QUERY_STATE_', '').toLowerCase()}.`)
    }
  }

  const rres = await fetch(`${BASE}/execution/${execution_id}/results?limit=${limit}`, { headers: headers() })
  if (!rres.ok) throw await asError(rres)
  const json = await rres.json()
  return {
    rows: json?.result?.rows ?? [],
    executedAt: json?.execution_ended_at || null,
    isEmpty: (json?.result?.rows ?? []).length === 0,
  }
}
