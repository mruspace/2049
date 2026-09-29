/**
 * Shared lighting for every body surface.
 *
 * Ambient light is zero. There is one light: the Sun. Shadows are pure black
 * and the terminator is razor sharp. This looks wrong at first and it is
 * correct; Apollo photographs look exactly like this, and softening it is the
 * quickest way to make the whole scene read as a video game.
 *
 * All values are on the project's photometric scale, where 1.0 is a fully lit
 * white Lambertian surface at 1 AU. See sim/constants.ts.
 */

import { uniform, vec3, float, positionWorld, normalWorld } from 'three/tsl'
import { AU } from '../../sim/constants'

/**
 * Uniforms shared by every lit surface.
 *
 * `sunDirection` is a unit vector from the body toward the Sun in EQJ.
 * `irradiance` is the inverse-square factor (AU / distance)^2.
 * `planetshine` is the nearby body's bounced colour, already multiplied by its
 * albedo, and `planetshineDirection` points from the surface toward it.
 */
export const createSurfaceLighting = () => {
  const sunDirection = uniform(vec3(0, 0, 1))
  const irradiance = uniform(float(1))
  const planetshine = uniform(vec3(0, 0, 0))
  const planetshineDirection = uniform(vec3(0, 1, 0))

  return {
    sunDirection,
    irradiance,
    planetshine,
    planetshineDirection,
    update: (sx: number, sy: number, sz: number, distanceToSun: number): void => {
      const len = Math.hypot(sx, sy, sz) || 1
      sunDirection.value.set(sx / len, sy / len, sz / len)
      // Inverse square, in AU. At Mars this is 0.43, which is why Mars is
      // visibly dimmer than Earth rather than just further away.
      const au = Math.max(distanceToSun, 1) / AU
      irradiance.value = 1 / (au * au)
    },
  }
}

export type SurfaceLighting = ReturnType<typeof createSurfaceLighting>

/** Direction from the fragment to the camera. The camera is always at the origin. */
export const viewDirection = () => positionWorld.negate().normalize()

/**
 * Lambertian response to the Sun, with no ambient and no wrap.
 *
 * Returns cos(incidence) clamped at zero, already scaled by the inverse-square
 * irradiance, so multiplying it by an albedo gives a value on the scene scale.
 */
export const sunlight = (light: SurfaceLighting) =>
  normalWorld.dot(light.sunDirection).max(0).mul(light.irradiance)

/**
 * Planetshine: a dim bounce from the nearby body onto whatever is near it,
 * tinted by that body's albedo. Cheap, and very convincing in orbit, where the
 * shadowed side of a hull is lit by the planet rather than being a silhouette.
 */
export const bounceLight = (light: SurfaceLighting) =>
  light.planetshine.mul(normalWorld.dot(light.planetshineDirection).max(0))
