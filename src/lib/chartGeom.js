// Shared chart geometry — both ValueChart and GapChart draw into the same
// 1020-wide viewBox with the same inner padding, so the x mapping (and its
// inverse, used for hover hit-testing) lives here.
export const W = 1020
export const P = { l: 46, r: 14, t: 14, b: 26 }

export const xAt = (i, n) => P.l + (n <= 1 ? 0 : (i * (W - P.l - P.r)) / (n - 1))

// Nearest data index for an x given in viewBox units (0..W).
export const indexFromSvgX = (svgX, n) => {
  if (n <= 1) return 0
  const step = (W - P.l - P.r) / (n - 1)
  return Math.max(0, Math.min(n - 1, Math.round((svgX - P.l) / step)))
}

// xAt as a percentage of width — resolution-independent, for HTML overlays.
export const xPct = (i, n) => (xAt(i, n) / W) * 100
