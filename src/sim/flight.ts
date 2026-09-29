/**
 * Flight integration.
 *
 * Velocity is set directly from the throttle. There is no gravity solver and
 * no orbital transfer puzzle: both are explicit non-goals. The ship points
 * where the nose points and moves at the speed the throttle asks for.
 *
 * Rotation is rate-based, not position-based. The ship keeps turning while
 * the stick is held off centre. Position-based steering is unflyable once a
 * turn takes several seconds, which it does here.
 */

import { forward, fromAxisAngle, multiply, normalizeQuat, quat } from './quat'
import type { ControlInput, ShipState } from './state'
import { throttleToSpeed } from './throttle'
import { addScaled, cross, dot, lengthOf, scale, type Vec3 } from './vec3'

/** Maximum angular rate at full stick deflection, rad/s. A half turn takes about five seconds. */
export const MAX_TURN_RATE = 0.6
/** Maximum roll rate, rad/s. Roll is allowed to feel quicker than pitch and yaw. */
export const MAX_ROLL_RATE = 1.2
/**
 * Throttle travel per second at normal rate. Shift multiplies this.
 *
 * The scale is logarithmic over nineteen decades, so the band that gets you
 * across the solar system in a watchable time is only about a tenth of the
 * travel, from roughly 45% to 56%. At the original rate, reaching it took two
 * and a half seconds of holding a key with nothing appearing to happen, and
 * stopping short left the ship at a speed that would reach Mars in three
 * weeks. Full travel now takes about two and a half seconds rather than four
 * and a half, and the cruise key skips the wait entirely.
 */
export const THROTTLE_RATE = 0.4
export const BOOST_MULTIPLIER = 10
/**
 * Speed easing time constants, seconds. They are deliberately different.
 *
 * Opening the throttle should feel like a ship building up. Closing it, or
 * running into the approach cap, should not: a slow spin-down means the ship
 * coasts through the point it was supposed to stop at, which is most of why
 * arriving at a planet felt like guesswork. Braking is quick and honest.
 */
export const SPEED_TAU_UP = 0.55
export const SPEED_TAU_DOWN = 0.16
/** Free-look limits, radians. */
export const LOOK_PITCH_LIMIT = Math.PI * 0.45

const scratchDelta = quat()
const scratchForward = Float64Array.of(0, 0, -1) as Vec3
const scratchAxis = Float64Array.of(0, 1, 0) as Vec3

/** Apply the rotation controls for one tick. Mutates `ship.orientation`. */
export const integrateRotation = (ship: ShipState, input: ControlInput, dt: number): void => {
  const pitch = clampAxis(input.pitch) * MAX_TURN_RATE * dt
  const yaw = clampAxis(input.yaw) * MAX_TURN_RATE * dt
  const roll = clampAxis(input.roll) * MAX_ROLL_RATE * dt

  // Body-frame axes, so the rotations compose the way a pilot expects.
  if (pitch !== 0) multiply(ship.orientation, ship.orientation, fromAxisAngle(scratchDelta, 1, 0, 0, pitch))
  if (yaw !== 0) multiply(ship.orientation, ship.orientation, fromAxisAngle(scratchDelta, 0, 1, 0, yaw))
  if (roll !== 0) multiply(ship.orientation, ship.orientation, fromAxisAngle(scratchDelta, 0, 0, 1, roll))
  normalizeQuat(ship.orientation)
}

/** Apply the throttle controls for one tick. Mutates `ship.throttle`. */
export const integrateThrottle = (ship: ShipState, input: ControlInput, dt: number): void => {
  if (input.fullStop) {
    ship.throttle = 0
    return
  }
  if (input.throttleRate === 0) return
  const rate = input.throttleRate * THROTTLE_RATE * (input.boost ? BOOST_MULTIPLIER : 1)
  ship.throttle = Math.min(1, Math.max(0, ship.throttle + rate * dt))
}

/**
 * Resolve the throttle into an actual speed and move the ship.
 *
 * @param speedCap metres per second permitted here, from the near-mass clamp.
 */
export const integrateMotion = (ship: ShipState, dt: number, speedCap: number): void => {
  ship.requestedSpeed = throttleToSpeed(ship.throttle)
  ship.clampedSpeed = speedCap
  const target = Math.min(ship.requestedSpeed, speedCap)

  // Exponential approach, frame-rate independent. Proportional, so it behaves
  // the same whether the step is 1 m/s or 1e18 m/s.
  const tau = target < ship.speed ? SPEED_TAU_DOWN : SPEED_TAU_UP
  const blend = 1 - Math.exp(-dt / tau)
  ship.speed += (target - ship.speed) * blend
  if (Math.abs(ship.speed) < 1e-6) ship.speed = 0

  forward(scratchForward, ship.orientation)
  scale(ship.velocity, scratchForward, ship.speed)
  addScaled(ship.position, ship.position, ship.velocity, dt)
}

/**
 * Maximum rate the align assist may turn the ship, rad/s.
 *
 * Deliberately slower than the pilot's own maximum, so taking the controls
 * always wins and the assist reads as the ship settling rather than as the
 * ship fighting.
 */
export const ALIGN_RATE = 0.35

/** Below this stick deflection the pilot counts as hands-off. */
const ALIGN_HANDS_OFF = 0.04

/**
 * Turn the ship toward its target while the throttle is open.
 *
 * Needed because aim, not speed, is what decides whether an arrival happens.
 * A heading one degree off at 1.75 AU misses Mars by 4.6 million kilometres,
 * and no speed clamp can fix that: the ship simply never gets closer than the
 * miss distance, so it slowed to a crawl abeam of a planet that was still a
 * single pixel wide. Flying an interplanetary intercept by hand to a fraction
 * of a degree is not what this is for.
 *
 * It yields completely to the pilot. Any real stick input disables it for that
 * frame, so steering always wins and letting go lets the ship settle.
 *
 * @param direction unit vector from the ship to the target, world space.
 * @returns true when the assist actually moved the ship.
 */
export const alignToward = (
  ship: ShipState, input: ControlInput, direction: Vec3, dt: number,
): boolean => {
  if (ship.throttle <= 0) return false
  if (Math.abs(input.pitch) > ALIGN_HANDS_OFF) return false
  if (Math.abs(input.yaw) > ALIGN_HANDS_OFF) return false

  forward(scratchForward, ship.orientation)
  const cosine = Math.min(1, Math.max(-1, dot(scratchForward, direction)))
  const angle = Math.acos(cosine)
  if (angle < 1e-4) return false

  // Rotation axis, in world space, from the nose to the target direction.
  cross(scratchAxis, scratchForward, direction)
  const length = lengthOf(scratchAxis)
  if (length < 1e-9) return false
  scale(scratchAxis, scratchAxis, 1 / length)

  const step = Math.min(angle, ALIGN_RATE * dt)
  fromAxisAngle(scratchDelta, scratchAxis[0]!, scratchAxis[1]!, scratchAxis[2]!, step)
  // Pre-multiplied: the axis is in world space, not the ship's.
  multiply(ship.orientation, scratchDelta, ship.orientation)
  normalizeQuat(ship.orientation)
  return true
}

/** Free look. Pure camera offset: it never steers the ship. */
export const integrateLook = (ship: ShipState, input: ControlInput, dt: number): void => {
  if (input.looking) {
    ship.lookYaw += input.lookYawDelta
    ship.lookPitch = Math.min(LOOK_PITCH_LIMIT, Math.max(-LOOK_PITCH_LIMIT, ship.lookPitch + input.lookPitchDelta))
    return
  }
  // Recentre over about a fifth of a second once the look button is released.
  const blend = 1 - Math.exp(-dt / 0.2)
  ship.lookYaw -= ship.lookYaw * blend
  ship.lookPitch -= ship.lookPitch * blend
  if (Math.abs(ship.lookYaw) < 1e-4) ship.lookYaw = 0
  if (Math.abs(ship.lookPitch) < 1e-4) ship.lookPitch = 0
}

const clampAxis = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v)
