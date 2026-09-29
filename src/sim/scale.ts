/**
 * Distant-body rescale.
 *
 * The depth range ends at FAR_PLANE (1e9 m) but Neptune sits about 4.5e12 m
 * from the Sun, so distant bodies would clip. The fix is to place any body
 * past RENDER_DISTANCE_MAX at exactly that distance and shrink its radius by
 * the same factor. Angular size is preserved exactly, which is all the eye
 * can check, and the map is strictly increasing in distance, so front-to-back
 * ordering between rescaled bodies survives.
 *
 * Lighting is always computed from the true Float64 vectors. Only the
 * rendered transform is rescaled.
 */

import { RENDER_DISTANCE_MAX } from './constants'

export interface RenderPlacement {
  /** Factor applied to both the camera-relative offset and the radius. */
  factor: number
  /** Distance the body is drawn at, metres. */
  drawDistance: number
}

/**
 * @param trueDistance metres from the camera to the body centre.
 */
export const placeForRender = (trueDistance: number): RenderPlacement => {
  if (!(trueDistance > RENDER_DISTANCE_MAX)) {
    return { factor: 1, drawDistance: trueDistance }
  }
  const factor = RENDER_DISTANCE_MAX / trueDistance
  return { factor, drawDistance: RENDER_DISTANCE_MAX }
}

/**
 * Angular radius of a sphere of `radius` seen from `distance`, in radians.
 * Exported because the rescale is only correct if this is invariant under it,
 * and the test asserts exactly that.
 */
export const angularRadius = (radius: number, distance: number): number =>
  distance <= radius ? Math.PI / 2 : Math.asin(radius / distance)
