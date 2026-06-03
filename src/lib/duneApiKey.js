/**
 * User-provided Dune API key, stored in localStorage. The deployed bundle
 * contains no key — each visitor pastes their own.
 *
 * Get one (free tier works) at https://dune.com/settings/api
 */

const STORAGE_KEY = 'autorange.dune.apiKey'
const listeners = new Set()

export function getDuneApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setDuneApiKey(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* noop */
  }
  for (const cb of listeners) cb(value || '')
}

export function subscribeDuneApiKey(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** True if the input looks roughly like a Dune key. */
export function looksLikeDuneKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(value.trim())
}
