/**
 * Targets and navigation.
 *
 * Three kinds of thing can be a target, and they arrive in three different
 * coordinate systems, so they are normalised here into one heliocentric EQJ
 * position in metres:
 *
 *   body     already EQJ metres, from the ephemeris, and it moves.
 *   star     parsecs in the catalogue, converted on read.
 *   messier  right ascension, declination and a distance in parsecs.
 *
 * All three are EQJ to begin with, which is the whole reason the project uses
 * EQJ: nothing is ever converted between frames, only between units.
 */

import { PARSEC } from './constants'
import { copy, distance, scale, sub, vec3, type Vec3 } from './vec3'
import { timeToTarget } from './units'

export type TargetKind = 'body' | 'star' | 'messier'

export interface Target {
  kind: TargetKind
  /** Stable identifier: a body id, a star index, or a Messier number. */
  id: string
  name: string
  /** A short descriptor for the HUD, e.g. "gas giant" or "globular cluster". */
  detail?: string
  /** Heliocentric EQJ metres. Refreshed each frame for bodies. */
  position: Vec3
  /** True when the position has to be re-read from the ephemeris every frame. */
  moving: boolean
  /** Radius in metres, where the object has a meaningful one. */
  radius?: number
}

export const bodyTarget = (id: string, name: string, detail: string, radius: number): Target => ({
  kind: 'body', id, name, detail, position: vec3(), moving: true, radius,
})

/** @param pc catalogue position in parsecs, EQJ. */
export const starTarget = (index: number, name: string, detail: string, pc: Vec3): Target => ({
  kind: 'star',
  id: String(index),
  name,
  detail,
  position: scale(vec3(), pc, PARSEC),
  moving: false,
})

/**
 * @param ra  right ascension in degrees (ICRS, which agrees with EQJ to far
 *            below anything visible here).
 * @param dec declination in degrees.
 * @param pc  distance in parsecs.
 */
export const skyTarget = (
  id: string, name: string, detail: string, ra: number, dec: number, pc: number,
): Target => {
  const raRad = (ra * Math.PI) / 180
  const decRad = (dec * Math.PI) / 180
  const r = pc * PARSEC
  return {
    kind: 'messier',
    id,
    name,
    detail,
    position: vec3(
      r * Math.cos(decRad) * Math.cos(raRad),
      r * Math.cos(decRad) * Math.sin(raRad),
      r * Math.sin(decRad),
    ),
    moving: false,
  }
}

export interface TargetReadout {
  name: string
  detail: string
  /** Metres from the ship to the target centre. */
  distance: number
  /** Metres from the ship to the target's surface, where it has one. */
  surfaceDistance: number
  /** Seconds at the current speed. Infinite when stopped. */
  eta: number
  /** Unit vector from the ship toward the target, EQJ. */
  direction: Vec3
}

const directionScratch = vec3()

export const readTarget = (
  target: Target, shipPosition: Vec3, speed: number, out?: TargetReadout,
): TargetReadout => {
  const centre = distance(shipPosition, target.position)
  const surface = target.radius === undefined ? centre : centre - target.radius

  sub(directionScratch, target.position, shipPosition)
  const length = centre || 1
  const result = out ?? {
    name: '', detail: '', distance: 0, surfaceDistance: 0, eta: 0, direction: vec3(),
  }
  result.name = target.name
  result.detail = target.detail ?? ''
  result.distance = centre
  result.surfaceDistance = surface
  // Time to the surface, not to the centre: arriving means arriving at the
  // planet, not at its core.
  result.eta = timeToTarget(Math.max(0, surface), speed)
  result.direction[0] = directionScratch[0]! / length
  result.direction[1] = directionScratch[1]! / length
  result.direction[2] = directionScratch[2]! / length
  return result
}

export interface ScreenBearing {
  /**
   * Direction to the target in screen terms, radians, measured anticlockwise
   * from the right with the y axis pointing up.
   *
   * Meaningful whether the target is in front or behind, which is the whole
   * point of computing it here rather than from a projected position.
   */
  angle: number
  /** True when the target is in front of the camera. */
  inFront: boolean
  /**
   * How far off the view axis the target is, as a sine, between 0 and 1.
   *
   * Near zero the bearing is meaningless: a target dead ahead or dead behind
   * has no direction on screen, and the angle is whatever the floating point
   * noise in two near-zero components says. Callers use this to hold the last
   * usable bearing instead, so the arrow does not flick as the ship swings
   * through the singular point.
   */
  lateral: number
}

/**
 * Where a target lies relative to the view.
 *
 * The obvious way to drive an off-screen arrow is to project the target and
 * use the resulting coordinates, and it does not work. Behind the camera the
 * perspective divide is by a negative w, so the projected position flips sign,
 * and the arrow swings across the screen as the ship turns away from its
 * target instead of settling on the edge it should be pointing at.
 *
 * Camera space has no such discontinuity. The sign of z says plainly whether
 * the target is in front, and x and y keep pointing the right way on both
 * sides of it: a target behind and to the right still needs an arrow that says
 * turn right.
 *
 * @param direction         unit vector from the ship to the target, world space.
 * @param cameraOrientation the camera's rotation. Structural, so it takes a
 *                          THREE.Quaternion or anything else with the four
 *                          components, and the sim keeps not importing three.
 */
export const screenBearing = (
  direction: Vec3,
  cameraOrientation: { x: number; y: number; z: number; w: number },
): ScreenBearing => {
  // Rotate the direction into camera space by the inverse of the camera's
  // orientation, which for a unit quaternion is its conjugate.
  const qx = -cameraOrientation.x
  const qy = -cameraOrientation.y
  const qz = -cameraOrientation.z
  const qw = cameraOrientation.w
  const x = direction[0]!, y = direction[1]!, z = direction[2]!

  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)

  const vx = x + qw * tx + qy * tz - qz * ty
  const vy = y + qw * ty + qz * tx - qx * tz
  const vz = z + qw * tz + qx * ty - qy * tx

  return {
    angle: Math.atan2(vy, vx),
    inFront: vz < 0,
    lateral: Math.hypot(vx, vy),
  }
}

/**
 * Below this lateral component the bearing is treated as unusable.
 *
 * About half a degree off the view axis. Inside that the target is effectively
 * dead ahead or dead behind and there is no direction to point.
 */
export const BEARING_DEAD_ZONE = 0.009

/** Keep a moving target's position current. Bodies move; stars do not. */
export const refreshTarget = (target: Target, world: Vec3 | undefined): void => {
  if (!target.moving || world === undefined) return
  copy(target.position, world)
}
