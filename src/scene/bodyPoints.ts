/**
 * Bodies drawn as point sources.
 *
 * Without this, a planet exists on screen only once its disc is a few pixels
 * across, and everything before that is empty space. Flying toward Jupiter
 * from Earth meant looking at nothing for the whole trip and then arriving,
 * which is the opposite of what the product is for.
 *
 * In life a planet is among the brightest things in the sky long before it is
 * a disc. Jupiter at opposition is magnitude -2.7, brighter than Sirius.
 * Watching that dot brighten over minutes and then resolve into a world is
 * most of what an approach feels like.
 *
 * So every body gets a sprite as well as a mesh, its brightness is the real
 * apparent magnitude from bodyMagnitude.ts, and the two crossfade across a
 * few pixels of angular size. Because the sprite shares the star field's
 * point spread function and luminance scale, a planet and a star of the same
 * magnitude come out the same brightness, and Jupiter correctly outshines
 * every star in the sky.
 *
 * Fifteen sprites in one draw call, updated from the CPU each frame. The
 * magnitude maths is a handful of logarithms per body and does not belong on
 * the GPU.
 */

import {
  AdditiveBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  PointsNodeMaterial,
  Sprite,
} from 'three/webgpu'
import { float, instancedBufferAttribute, uniform } from 'three/tsl'
import { magnitudeToLuminance } from '../stars/pointFlux'
import { pointSpread, type PsfSettings } from '../stars/psf'
import { STAR_SHELL_RADIUS } from '../stars/starfield'
import type { FloatUniform } from './materials/nodes'
import type { BodyDesc } from '../ephem/bodies'
import {
  angularDiameter, apparentBodyMagnitude, pointSourceWeight,
} from './bodyMagnitude'
import type { BodyEphemeris, Ephemeris } from '../ephem/ephemeris'
import type { Vec3 } from '../sim/vec3'

/**
 * How far a body's tint is pulled toward neutral.
 *
 * Less than the 60% the stars get. A planet really does show its colour to the
 * naked eye, which is why people describe Mars as the red one, but the mean of
 * an albedo map normalised to its peak channel is more saturated than the eye
 * sees.
 */
const TINT_DESATURATION = 0.42

/** Nominal sprite diameter, in CSS pixels. Feeds the flux conversion. */
const POINT_DIAMETER = 3.1

export interface BodyPoints {
  object: Sprite
  /**
   * Recompute every body's brightness and direction.
   *
   * @param pixelsPerRadian vertical resolution over the vertical field of
   *                        view, which sets when a point hands over to a mesh.
   */
  update: (
    ephem: Ephemeris,
    shipPosition: Vec3,
    pixelsPerRadian: number,
  ) => void
  dispose: () => void
}

export const createBodyPoints = (
  bodies: readonly BodyDesc[],
  tints: ReadonlyMap<string, readonly [number, number, number]>,
): BodyPoints => {
  const count = bodies.length

  // xyz is a unit direction from the ship, w is scene luminance.
  const data = new Float32Array(count * 4)
  // rgb is the tint, a is the crossfade weight against the mesh.
  const tint = new Float32Array(count * 4)

  for (let i = 0; i < count; i++) {
    const body = bodies[i]!
    const [r, g, b] = desaturate(tints.get(body.id) ?? [1, 1, 1])
    tint[i * 4] = r
    tint[i * 4 + 1] = g
    tint[i * 4 + 2] = b
    tint[i * 4 + 3] = 0
  }

  const dataAttribute = new InstancedBufferAttribute(data, 4).setUsage(DynamicDrawUsage)
  const tintAttribute = new InstancedBufferAttribute(tint, 4).setUsage(DynamicDrawUsage)

  const dataNode = instancedBufferAttribute<'vec4'>(dataAttribute, 'vec4')
  const tintNode = instancedBufferAttribute<'vec4'>(tintAttribute, 'vec4')

  // Slightly larger than a star's, because a planet at naked-eye brightness
  // reads as a steadier, fuller point than a star does. Same floor, so it
  // cannot scintillate either.
  const psf: PsfSettings = {
    psfPixels: uniform(float(POINT_DIAMETER)) as FloatUniform,
    minPixels: uniform(float(1.5)) as FloatUniform,
    maxPixels: uniform(float(14)) as FloatUniform,
    cullIntensity: uniform(float(2e-9)) as FloatUniform,
  }

  const sprite = pointSpread(dataNode.w, tintNode.xyz, psf, tintNode.w)

  const material = new PointsNodeMaterial({
    sizeAttenuation: false,
    transparent: true,
    blending: AdditiveBlending,
    // Same shell and the same depth rules as the star field, so a body's own
    // mesh, or anything else in front, occludes its point.
    depthWrite: false,
    depthTest: true,
  })
  material.positionNode = dataNode.xyz.mul(STAR_SHELL_RADIUS)
  material.sizeNode = sprite.size
  material.colorNode = sprite.colour
  material.opacityNode = sprite.opacity

  const object = new Sprite(material)
  object.count = count
  object.frustumCulled = false
  object.matrixAutoUpdate = false
  // Drawn after the stars, so a planet sits over the star field rather than
  // being blended underneath it.
  object.renderOrder = -90
  object.name = 'body-points'

  const update = (
    ephem: Ephemeris, shipPosition: Vec3, pixelsPerRadian: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const body = bodies[i]!
      const entry = ephem.get(body.id)
      const o = i * 4

      if (entry === undefined || !entry.initialised) {
        data[o + 3] = 0
        tint[o + 3] = 0
        continue
      }

      const dx = entry.position[0]! - shipPosition[0]!
      const dy = entry.position[1]! - shipPosition[1]!
      const dz = entry.position[2]! - shipPosition[2]!
      const distance = Math.hypot(dx, dy, dz)

      if (distance <= body.radiusEq) {
        // Inside the body. Nothing sensible to draw, and the mesh has it.
        data[o + 3] = 0
        tint[o + 3] = 0
        continue
      }

      data[o] = dx / distance
      data[o + 1] = dy / distance
      data[o + 2] = dz / distance

      const magnitude = apparentBodyMagnitude({
        body,
        sunDistance: sunDistanceOf(entry),
        observerDistance: distance,
        phaseAngle: phaseAngleOf(entry, dx, dy, dz, distance),
        ringTiltCosine: ringTiltOf(entry, dx, dy, dz, distance),
      })

      // The same derived conversion the star field uses, so magnitudes are
      // comparable across the whole sky and a planet's brightness as a point
      // matches its brightness as a disc.
      data[o + 3] = magnitudeToLuminance(magnitude, pixelsPerRadian, POINT_DIAMETER)

      const pixels = angularDiameter(body.radiusEq, distance) * pixelsPerRadian
      tint[o + 3] = pointSourceWeight(pixels)
    }

    dataAttribute.needsUpdate = true
    tintAttribute.needsUpdate = true
  }

  return {
    object,
    update,
    dispose: () => { material.dispose(); object.geometry.dispose() },
  }
}

/** The Sun sits at the origin, so a body's heliocentric distance is its length. */
const sunDistanceOf = (entry: BodyEphemeris): number =>
  Math.hypot(entry.position[0]!, entry.position[1]!, entry.position[2]!) || 1

/**
 * Phase angle at the body: the angle subtended at it by the Sun and the ship.
 *
 * This is what makes Venus a thin brilliant crescent rather than a uniformly
 * lit disc, and it is why a planet seen near the Sun is far dimmer than the
 * same planet at opposition.
 */
const phaseAngleOf = (
  entry: BodyEphemeris, dx: number, dy: number, dz: number, distance: number,
): number => {
  const sunDistance = sunDistanceOf(entry)
  // Toward the Sun from the body, and toward the ship from the body.
  const sx = -entry.position[0]! / sunDistance
  const sy = -entry.position[1]! / sunDistance
  const sz = -entry.position[2]! / sunDistance
  const ox = -dx / distance
  const oy = -dy / distance
  const oz = -dz / distance
  const cosine = sx * ox + sy * oy + sz * oz
  return Math.acos(cosine < -1 ? -1 : cosine > 1 ? 1 : cosine)
}

/** |cos| between the ring plane normal and the direction to the ship. */
const ringTiltOf = (
  entry: BodyEphemeris, dx: number, dy: number, dz: number, distance: number,
): number => {
  if (entry.desc.rings === undefined) return 0
  const cosine =
    (entry.north[0]! * -dx + entry.north[1]! * -dy + entry.north[2]! * -dz) / distance
  return Math.abs(cosine)
}

/** Pull a tint toward its own luminance, then renormalise to a peak of 1. */
const desaturate = (
  [r, g, b]: readonly [number, number, number],
): [number, number, number] => {
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const dr = r + (grey - r) * TINT_DESATURATION
  const dg = g + (grey - g) * TINT_DESATURATION
  const db = b + (grey - b) * TINT_DESATURATION
  const peak = Math.max(dr, dg, db)
  if (peak <= 0) return [1, 1, 1]
  return [dr / peak, dg / peak, db / peak]
}
