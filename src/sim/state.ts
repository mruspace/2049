/**
 * Ship state. The single source of truth for where the player is.
 *
 * Every position here is heliocentric J2000 mean equator (EQJ), in metres,
 * Float64. That is the same frame the HYG catalogue and astronomy-engine
 * already use, so nothing in this project ever converts frames.
 *
 * None of these numbers may reach a shader. The scene layer subtracts the
 * ship position from everything and uploads the Float32 remainder.
 */

import { quat, type Quat } from './quat'
import { vec3, type Vec3 } from './vec3'

export type FlightMode = 'free' | 'orbit'

export interface ShipState {
  /** Heliocentric EQJ, metres. */
  position: Vec3
  /** Metres per second, world frame. */
  velocity: Vec3
  /** Ship attitude. -Z is the nose. */
  orientation: Quat
  /** Throttle position, 0 to 1, linear in log-speed. */
  throttle: number
  /** Current speed after easing, m/s. Not the throttle target. */
  speed: number
  /** Speed the throttle is asking for, before the near-mass clamp. */
  requestedSpeed: number
  /** Cap currently imposed by proximity to a body, m/s. */
  clampedSpeed: number
  /** Body id whose motion the ship is carried by, or null in deep space. */
  attachedTo: string | null
  mode: FlightMode
  /** Free-look offset, radians. Does not steer the ship. */
  lookYaw: number
  lookPitch: number
}

export const createShipState = (): ShipState => ({
  position: vec3(),
  velocity: vec3(),
  orientation: quat(),
  throttle: 0,
  speed: 0,
  requestedSpeed: 0,
  clampedSpeed: Number.POSITIVE_INFINITY,
  attachedTo: null,
  mode: 'free',
  lookYaw: 0,
  lookPitch: 0,
})

/** Control axes for one tick, each already normalised to [-1, 1]. */
export interface ControlInput {
  pitch: number
  yaw: number
  roll: number
  /** Throttle change per second, in units of the 0..1 throttle range. */
  throttleRate: number
  /** True while the 10x throttle modifier is held. */
  boost: boolean
  /** Latched request to cut the throttle to zero. */
  fullStop: boolean
  /** Free-look deltas in radians, applied to the camera only. */
  lookYawDelta: number
  lookPitchDelta: number
  /** True while free look is active. Releasing it recentres the view. */
  looking: boolean
}

export const createControlInput = (): ControlInput => ({
  pitch: 0, yaw: 0, roll: 0,
  throttleRate: 0,
  boost: false,
  fullStop: false,
  lookYawDelta: 0,
  lookPitchDelta: 0,
  looking: false,
})
