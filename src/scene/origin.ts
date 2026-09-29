/**
 * The floating origin.
 *
 * A Float32 holds about seven significant digits. The cockpit is measured in
 * metres and Neptune is 4.5e12 m away. There is no single Float32 space that
 * holds both, and trying produces geometry jitter, z-fighting and a star field
 * that tears as the camera moves.
 *
 * So the camera sits at exactly (0,0,0) and never moves. Every frame, the ship
 * position is subtracted from every body position in Float64, and only the
 * remainder is written into the scene graph. The remainder is small near the
 * camera, which is the only place precision is visible.
 *
 * Reverse-Z fixes depth precision. It does nothing for position precision.
 * This file is what makes the scene work, and it is what keeps the WebGL2
 * fallback usable on browsers with no EXT_clip_control.
 */

import type { Object3D } from 'three/webgpu'
import { PARSEC, RENDER_DISTANCE_MAX } from '../sim/constants'
import type { Vec3 } from '../sim/vec3'

export interface RebaseResult {
  /** Metres from the camera to the body centre, before any rescale. */
  trueDistance: number
  /** Uniform scale applied to the body so its angular size is unchanged. */
  factor: number
  /** True when the body was pulled in to stay inside the far plane. */
  rescaled: boolean
}

/**
 * Place one body relative to the camera.
 *
 * Bodies past RENDER_DISTANCE_MAX are placed at exactly that distance and
 * scaled by the same factor. Angular size is preserved exactly, which is all
 * the eye can check, and the map is strictly increasing in distance, so
 * front-to-back ordering between rescaled bodies survives.
 *
 * @param object     the scene node to place. Its scale is overwritten.
 * @param bodyWorld  body position, heliocentric EQJ metres, Float64.
 * @param shipWorld  ship position, same frame and units.
 * @param baseScale  the body's own scale before the rescale, per axis.
 */
export const rebaseBody = (
  object: Object3D,
  bodyWorld: Vec3,
  shipWorld: Vec3,
  baseScaleX: number,
  baseScaleY: number,
  baseScaleZ: number,
): RebaseResult => {
  // The subtraction happens in Float64. Only its result reaches Float32.
  const dx = bodyWorld[0]! - shipWorld[0]!
  const dy = bodyWorld[1]! - shipWorld[1]!
  const dz = bodyWorld[2]! - shipWorld[2]!
  const trueDistance = Math.hypot(dx, dy, dz)

  if (trueDistance <= RENDER_DISTANCE_MAX || trueDistance === 0) {
    object.position.set(dx, dy, dz)
    object.scale.set(baseScaleX, baseScaleY, baseScaleZ)
    return { trueDistance, factor: 1, rescaled: false }
  }

  const factor = RENDER_DISTANCE_MAX / trueDistance
  object.position.set(dx * factor, dy * factor, dz * factor)
  object.scale.set(baseScaleX * factor, baseScaleY * factor, baseScaleZ * factor)
  return { trueDistance, factor, rescaled: true }
}

/**
 * Ship position expressed in parsecs, for the star shader.
 *
 * The star catalogue is in parsecs and stays that way. Inside the solar system
 * this vector is about 1e-5 pc, which is below Float32 resolution against a
 * 100 pc star, so nearby stars do not shift. That is the correct physical
 * result, not a limitation.
 */
export const METRES_TO_PARSEC = 1 / PARSEC
