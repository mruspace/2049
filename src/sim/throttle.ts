/**
 * Logarithmic throttle.
 *
 * The usable speed range runs from 1 m/s to 1000 light years per second: about
 * nineteen orders of magnitude. A linear control would spend its whole travel
 * in the top decade, so the control variable `t` is linear in log-speed
 * instead. One full sweep of `t` is one sweep of the exponent.
 */

import { CLAMP_FLOOR_SPEED, SPEED_MAX, SPEED_MIN } from './constants'

const LOG_MIN = Math.log10(SPEED_MIN)
const LOG_MAX = Math.log10(SPEED_MAX)
const LOG_SPAN = LOG_MAX - LOG_MIN

/** Throttle position in [0,1] to speed in m/s. t = 0 means stopped, not 1 m/s. */
export const throttleToSpeed = (t: number): number => {
  if (t <= 0) return 0
  const clamped = Math.min(1, t)
  return 10 ** (LOG_MIN + clamped * LOG_SPAN)
}

/** Inverse of throttleToSpeed. Used when a speed clamp has to be shown on the bar. */
export const speedToThrottle = (speed: number): number => {
  if (speed <= 0) return 0
  return Math.min(1, Math.max(0, (Math.log10(speed) - LOG_MIN) / LOG_SPAN))
}

/**
 * Seconds the approach cap allows for closing whatever distance remains.
 *
 * Because the cap is recomputed from the shrinking distance every frame, the
 * approach becomes exponential: the gap falls by a factor of e every
 * APPROACH_SECONDS. Getting from 5 AU to low orbit over Jupiter takes about
 * fifteen seconds, which is slow enough to watch and fast enough not to be a
 * chore. It also makes overshooting impossible, because the speed goes to zero
 * as the gap does.
 */
export const APPROACH_SECONDS = 2

/**
 * The same allowance while leaving something rather than arriving at it.
 *
 * Much shorter, because departing is not the problem the clamp is there to
 * solve: nothing ahead is going to be overshot on the way out. At the arrival
 * value, climbing out of low orbit took ten seconds during which the distance
 * to the destination did not visibly change, which is its own kind of
 * unflyable.
 */
export const DEPARTURE_SECONDS = 0.5

/**
 * Maximum speed permitted near a mass.
 *
 * Elite Dangerous calls this supercruise, and the behaviour is worth copying:
 * close to a body the cap falls until crossing the remaining gap takes at
 * least a couple of seconds. Without it a single frame at full throttle puts
 * the ship on the far side of the solar system and the arrival is unflyable.
 *
 * @param distanceToSurface metres from the hull to the body's surface. May be negative inside the body.
 * @param withinInfluence   false when the ship is outside the body's influence radius, which lifts the cap.
 * @param receding          true when the body is behind the nose, which relaxes the cap.
 */
export const clampSpeedNearMass = (
  distanceToSurface: number, withinInfluence: boolean, receding = false,
): number => {
  if (!withinInfluence) return SPEED_MAX
  const gap = Math.max(0, distanceToSurface)
  const seconds = receding ? DEPARTURE_SECONDS : APPROACH_SECONDS
  return Math.min(SPEED_MAX, Math.max(CLAMP_FLOOR_SPEED, gap / seconds))
}

/**
 * Maximum speed permitted while heading at something.
 *
 * The near-mass clamp only engages inside a hundred radii, and that is far too
 * late. At full throttle the ship crosses a hundred Jupiter radii in a
 * fraction of a frame, so a planet went from an invisible dot to already
 * behind the ship with nothing in between, and the only way to stop at one was
 * to guess.
 *
 * This applies the same rule to the whole approach, from however far out the
 * ship is pointed at something. The result is an exponential closing curve
 * that cannot overshoot: the cap is proportional to the remaining gap, so the
 * speed reaches zero exactly as the gap does.
 *
 * @param approachGap metres along the nose to the body's surface, or Infinity
 *                    when the ship is not heading at anything.
 */
export const clampSpeedForApproach = (approachGap: number): number => {
  if (!Number.isFinite(approachGap)) return SPEED_MAX
  const gap = Math.max(0, approachGap)
  return Math.min(SPEED_MAX, Math.max(CLAMP_FLOOR_SPEED, gap / APPROACH_SECONDS))
}
