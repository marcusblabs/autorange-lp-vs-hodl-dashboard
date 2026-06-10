import { useCallback, useRef, useState } from 'react'
import { W, indexFromSvgX } from '../lib/chartGeom'

// Track which data point the cursor is over. The SVG fills its wrapper and its
// viewBox maps 1:1 across the width, so clientX → viewBox x → nearest index.
export function useHoverIndex(n) {
  const ref = useRef(null)
  const [idx, setIdx] = useState(null)

  const onMove = useCallback(
    (e) => {
      const svg = ref.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (!rect.width) return
      const svgX = ((e.clientX - rect.left) / rect.width) * W
      setIdx(indexFromSvgX(svgX, n))
    },
    [n]
  )
  const onLeave = useCallback(() => setIdx(null), [])

  return { ref, idx, onMove, onLeave }
}
