/**
 * B-V colour index to a linear sRGB triple.
 *
 * Done at build time rather than on the GPU. It costs the same twenty bytes
 * per star either way, and it takes the Planck integral out of the frame loop
 * entirely.
 *
 * The pipeline is: B-V to effective temperature (Ballesteros 2012), then
 * Planck's law sampled against the CIE 1931 colour matching functions, then
 * XYZ to linear sRGB, then a deliberate desaturation.
 *
 * That last step is not a fudge. Real stars look very nearly white to the dark
 * adapted eye, because colour vision barely works at those luminances. Fully
 * saturated star colours are the single clearest tell of an amateur star
 * field: they look like a screensaver.
 */

/** How far each star is pulled toward neutral. 0 is raw chromaticity, 1 is white. */
export const DESATURATION = 0.6

/**
 * Range of B-V the conversion is allowed to see.
 *
 * Ballesteros is fitted for roughly -0.4 to 2.0. HYG contains values well
 * outside that, up to about 5, because a heavily reddened star's measured
 * colour index says as much about the dust in front of it as about the star.
 * Extrapolating there gives temperatures under 2000 K and a fully saturated
 * red, which is both physically wrong and the exact look this pipeline is
 * trying to avoid. Clamping keeps the extremes at the coolest and hottest
 * colours the formula can be trusted for.
 */
const BV_MIN = -0.4
const BV_MAX = 2.5

/** Ballesteros (2012). Good to a few percent over the range HYG actually covers. */
export const bvToKelvin = (bv) => {
  const clamped = Math.min(BV_MAX, Math.max(BV_MIN, bv))
  return 4600 * (1 / (0.92 * clamped + 1.7) + 1 / (0.92 * clamped + 0.62))
}

/**
 * Wyman, Sloan and Shirley (2013), "Simple Analytic Approximations to the
 * CIE XYZ Color Matching Functions". Multi-lobe Gaussians, accurate enough
 * that the error is far below 8-bit quantisation.
 */
const gauss = (x, mu, s1, s2) => {
  const t = (x - mu) / (x < mu ? s1 : s2)
  return Math.exp(-0.5 * t * t)
}
const xBar = (l) => 1.056 * gauss(l, 599.8, 37.9, 31.0) + 0.362 * gauss(l, 442.0, 16.0, 26.7) - 0.065 * gauss(l, 501.1, 20.4, 26.2)
const yBar = (l) => 0.821 * gauss(l, 568.8, 46.9, 40.5) + 0.286 * gauss(l, 530.9, 16.3, 31.1)
const zBar = (l) => 1.217 * gauss(l, 437.0, 11.8, 36.0) + 0.681 * gauss(l, 459.0, 26.0, 13.8)

const H = 6.62607015e-34
const C_LIGHT = 299792458
const K_B = 1.380649e-23

/** Spectral radiance, per wavelength in metres. Only its shape matters here. */
const planck = (lambdaMetres, kelvin) => {
  const l5 = lambdaMetres ** 5
  return (2 * H * C_LIGHT * C_LIGHT) / (l5 * (Math.exp((H * C_LIGHT) / (lambdaMetres * K_B * kelvin)) - 1))
}

/** Temperature to linear sRGB, normalised so the largest channel is 1. */
export const kelvinToLinearRgb = (kelvin) => {
  let X = 0, Y = 0, Z = 0
  for (let nm = 380; nm <= 780; nm += 5) {
    const p = planck(nm * 1e-9, kelvin)
    X += p * xBar(nm); Y += p * yBar(nm); Z += p * zBar(nm)
  }
  const sum = X + Y + Z
  if (sum <= 0) return [1, 1, 1]
  X /= sum; Y /= sum; Z /= sum

  // XYZ to linear sRGB (sRGB primaries, D65 white).
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z

  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b)
  const peak = Math.max(r, g, b)
  if (peak <= 0) return [1, 1, 1]
  return [r / peak, g / peak, b / peak]
}

/** Pull toward the luminance-preserving grey, then renormalise. */
export const desaturate = ([r, g, b], amount = DESATURATION) => {
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b
  let dr = r + (grey - r) * amount
  let dg = g + (grey - g) * amount
  let db = b + (grey - b) * amount
  const peak = Math.max(dr, dg, db)
  if (peak <= 0) return [1, 1, 1]
  return [dr / peak, dg / peak, db / peak]
}

/**
 * The whole chain, with a 1024-entry cache over B-V.
 *
 * The catalogue has 119,614 rows but only a few thousand distinct B-V values
 * to three decimals, so the Planck integral runs a handful of times instead of
 * once per star.
 */
const cache = new Map()
export const bvToRgbBytes = (bv) => {
  const key = Math.round(bv * 1000)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const rgb = desaturate(kelvinToLinearRgb(bvToKelvin(key / 1000)))
  const bytes = rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))))
  cache.set(key, bytes)
  return bytes
}

/** B-V for a star with no colour index. G2V-ish: unremarkable and nearly white. */
export const DEFAULT_BV = 0.656
