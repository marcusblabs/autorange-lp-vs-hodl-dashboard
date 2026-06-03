import React, { useState } from 'react'
import { getDuneApiKey, setDuneApiKey, looksLikeDuneKey } from '../lib/duneApiKey'

export default function ApiKeyPanel() {
  const [val, setVal] = useState(getDuneApiKey())
  const has = !!getDuneApiKey()

  return (
    <div className="keybar">
      <div className="status" style={{ fontWeight: 600 }}>Dune API key</div>
      <input
        className="grow"
        type="text"
        placeholder="paste your Dune API key to load live data & other pools"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        spellCheck={false}
      />
      <button
        className="btn"
        disabled={!looksLikeDuneKey(val)}
        onClick={() => setDuneApiKey(val.trim())}
      >
        Save
      </button>
      {has && (
        <button className="btn ghost" onClick={() => { setDuneApiKey(''); setVal('') }}>
          Clear
        </button>
      )}
      <span className={'status ' + (has ? 'ok' : 'no')}>
        {has ? '● key set — stored only in your browser' : 'free tier works · dune.com/settings/api'}
      </span>
    </div>
  )
}
