/**
 * Atmospheres.
 *
 * A back-facing shell around the body with analytic single scattering. Not a
 * full Bruneton precomputation: this has to be right at a glance from orbit,
 * not right at every altitude and sun angle, and the shell costs one extra
 * draw call per body.
 *
 * Why it matters more than texture resolution: a hard-edged planet limb is an
 * instant tell. Earth's blue limb is the strongest realism cue in the solar
 * system, and Mars is only 0.6% of Earth's pressure but its suspended dust
 * still gives a soft butterscotch edge. Both come out of this shader with
 * different optical depths from the body descriptor.
 *
 * The model, in the order the shader computes it:
 *
 *  1. Intersect the view ray with the atmosphere shell, and clip the segment
 *     at the planet surface so the ground occludes the haze behind it.
 *  2. Take the altitude of closest approach. For an exponential atmosphere
 *     that is where nearly all the scattering along the ray happens.
 *  3. Turn it into an optical depth with a Chapman-style column factor,
 *     sqrt(2 pi R / H) * exp(-altitude / H), times the surface vertical
 *     optical depth from the descriptor.
 *  4. Scatter: (1 - exp(-tau)) is the fraction of the beam removed, and the
 *     Rayleigh phase function 3/(16 pi) * (1 + cos^2 theta) is the fraction
 *     sent toward the eye. On the project's scale, where a fully lit white
 *     Lambertian at 1 AU is 1.0, that whole product is
 *     (3/16) * (1 + cos^2 theta) * (1 - exp(-tau)), between 0.19 and 0.375 of
 *     the saturated value.
 *
 * Step 4 is the one that matters, and getting it wrong is visible immediately.
 * A first version used the optical depth directly instead of saturating it,
 * which put the limb at 235 rather than at most 0.375: Earth came out as a
 * white disc inside a halo that filled the frame.
 */

import {
  AdditiveBlending,
  BackSide,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Mesh,
} from 'three/webgpu'
import { float, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl'
import type { AtmosphereDesc, BodyDesc } from '../../ephem/bodies'
import type { SurfaceLighting } from './lighting'
import type { FloatUniform, Vec3Uniform } from './nodes'

/** Rayleigh phase normalisation, 3/16, already divided through by pi. */
const PHASE_SCALE = 3 / 16

export interface Atmosphere {
  object: Mesh
  /** Planet centre in camera-relative metres. Written every frame. */
  setCentre: (x: number, y: number, z: number) => void
  /** Uniform scale applied by the distant-body rescale. */
  setScale: (factor: number) => void
  dispose: () => void
}

export const createAtmosphere = (
  body: BodyDesc,
  atmosphere: AtmosphereDesc,
  lighting: SurfaceLighting,
): Atmosphere => {
  const planetRadius = uniform(float(body.radiusEq)) as FloatUniform
  const shellRadius = uniform(float(body.radiusEq + atmosphere.shellHeight)) as FloatUniform
  const centre = uniform(vec3(0, 0, 0)) as Vec3Uniform
  const scaleHeight = uniform(float(atmosphere.scaleHeight)) as FloatUniform

  // sqrt(2 pi R / H): the ratio between a grazing column and a vertical one.
  // For Earth it is about 69, which is why the limb is so much brighter than
  // the sky overhead.
  const columnRatio = uniform(
    float(Math.sqrt((2 * Math.PI * body.radiusEq) / atmosphere.scaleHeight)),
  ) as FloatUniform

  const [tr, tg, tb] = atmosphere.verticalOpticalDepth
  const verticalTau = uniform(vec3(tr, tg, tb)) as Vec3Uniform

  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })

  // The camera is always at the origin, so the view ray is just the direction
  // to the fragment.
  const direction = positionWorld.normalize()
  // Ray origin relative to the body centre, which is the usual `oc` term.
  const toCentre = centre.negate()

  // `b` is the projection of that offset onto the ray, so -b is the parameter
  // at closest approach.
  const b = toCentre.dot(direction)
  const originSq = toCentre.dot(toCentre)

  const shellSq = shellRadius.mul(shellRadius)
  const shellDisc = b.mul(b).sub(originSq.sub(shellSq)).max(0)
  const shellRoot = shellDisc.sqrt()
  const enter = b.negate().sub(shellRoot).max(0)
  const shellExit = b.negate().add(shellRoot)

  // Clip at the planet surface, so the far wall of the shell is not counted
  // through solid ground.
  const planetSq = planetRadius.mul(planetRadius)
  const planetDisc = b.mul(b).sub(originSq.sub(planetSq))
  const planetHit = b.negate().sub(planetDisc.max(0).sqrt())
  const hitsPlanet = planetDisc.greaterThan(0).and(planetHit.greaterThan(enter))
  const exit = hitsPlanet.select(planetHit.min(shellExit), shellExit)

  const insideShell = exit.sub(enter).greaterThan(0)

  // Altitude of closest approach. A ray that meets the planet has its own
  // closest approach underground, so for those the surface is the right place
  // to sample, which max(0) gives.
  const closest = direction.mul(b.negate()).sub(centre)
  const altitude = closest.length().sub(planetRadius).max(0)

  // A ray that ends at the ground only traverses the near half of the column.
  const halfColumn = hitsPlanet.select(float(0.5), float(1))
  const column = columnRatio.mul(altitude.div(scaleHeight).negate().exp()).mul(halfColumn)
  const tau = verticalTau.mul(column)

  // Sun angle at the point of closest approach, softened across the
  // terminator. That softness is real: the atmosphere is lit well past the
  // geometric terminator, which is exactly why twilight exists.
  const upAtClosest = closest.normalize()
  const lit = smoothstep(-0.35, 0.25, upAtClosest.dot(lighting.sunDirection))

  // Rayleigh phase. cos(theta) is between the incoming photon direction
  // (-sunDirection) and the outgoing one (-direction), which reduces to the
  // dot product of the two as written.
  const cosTheta = lighting.sunDirection.dot(direction)
  const phase = float(PHASE_SCALE).mul(cosTheta.mul(cosTheta).add(1))

  const scattered = tau.negate().exp().oneMinus().mul(phase)
  const visible = insideShell.select(float(1), float(0))

  material.colorNode = scattered.mul(lit).mul(lighting.irradiance).mul(visible)

  const geometry = new SphereGeometry(1, 64, 32)
  const object = new Mesh(geometry, material)
  object.name = `${body.id}-atmosphere`
  object.matrixAutoUpdate = false
  object.frustumCulled = false
  object.renderOrder = 10

  const baseRadius = body.radiusEq + atmosphere.shellHeight

  return {
    object,
    setCentre: (x, y, z) => {
      centre.value.set(x, y, z)
      object.position.set(x, y, z)
      object.updateMatrix()
    },
    setScale: (factor) => {
      // Radii scale with the render transform, but the column ratio does not:
      // it is R/H, and both scale together, so it is invariant.
      object.scale.setScalar(baseRadius * factor)
      planetRadius.value = body.radiusEq * factor
      shellRadius.value = baseRadius * factor
      scaleHeight.value = atmosphere.scaleHeight * factor
      object.updateMatrix()
    },
    dispose: () => { geometry.dispose(); material.dispose() },
  }
}
