/**
 * Display formatting.
 *
 * The HUD spans twenty orders of magnitude. A single unit cannot serve it, so
 * every readout picks the unit that keeps the number between roughly 1 and
 * 1000. The sim itself never uses any of this: it is metres and seconds all
 * the way down.
 */

import { AU, C, LIGHT_YEAR, PARSEC } from './constants'

export interface Formatted {
  /** The number, already scaled into `unit`. */
  value: number
  unit: string
  /** Ready-to-paint string, e.g. "1.42 km/s". */
  text: string
}

const round = (v: number, digits: number): string => {
  const abs = Math.abs(v)
  if (abs >= 100) return v.toFixed(Math.max(0, digits - 2))
  if (abs >= 10) return v.toFixed(Math.max(0, digits - 1))
  return v.toFixed(digits)
}

const make = (value: number, unit: string, digits = 2): Formatted => ({
  value,
  unit,
  text: `${round(value, digits)} ${unit}`,
})

/**
 * Speed, m/s to the fitting unit.
 * Thresholds: m/s below 1 km/s, km/s below 0.01 c, c below 1 ly/s.
 */
export const formatSpeed = (metresPerSecond: number): Formatted => {
  const v = Math.abs(metresPerSecond)
  if (v < 1e3) return make(metresPerSecond, 'm/s', 1)
  if (v < 0.01 * C) return make(metresPerSecond / 1e3, 'km/s')
  if (v < LIGHT_YEAR) return make(metresPerSecond / C, 'c')
  return make(metresPerSecond / LIGHT_YEAR, 'ly/s')
}

/**
 * Distance, metres to the fitting unit.
 * Thresholds: km below 0.1 AU, AU below 0.5 ly, ly below 1000 ly, then pc.
 */
export const formatDistance = (metres: number): Formatted => {
  const v = Math.abs(metres)
  if (v < 1e3) return make(metres, 'm', 0)
  if (v < 0.1 * AU) return make(metres / 1e3, 'km', 0)
  if (v < 0.5 * LIGHT_YEAR) return make(metres / AU, 'AU')
  if (v < 1000 * LIGHT_YEAR) return make(metres / LIGHT_YEAR, 'ly')
  return make(metres / PARSEC, 'pc', 1)
}

/** Duration, seconds to the fitting unit. Used for time-to-target. */
export const formatDuration = (seconds: number): Formatted => {
  if (!Number.isFinite(seconds)) return { value: Infinity, unit: '', text: '—' }
  const v = Math.abs(seconds)
  if (v < 1) return make(seconds * 1e3, 'ms', 0)
  if (v < 120) return make(seconds, 's', 1)
  if (v < 7200) return make(seconds / 60, 'min', 1)
  if (v < 172800) return make(seconds / 3600, 'h', 1)
  if (v < 3.156e9) return make(seconds / 86400, 'd', 1)
  return make(seconds / 3.15576e7, 'yr', 1)
}

/** Time to cover `metres` at `speed`. Infinite when stopped. */
export const timeToTarget = (metres: number, speed: number): number =>
  speed <= 0 ? Infinity : metres / speed
