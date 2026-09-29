/**
 * The cloud layer.
 *
 * A separate sphere a few kilometres above the surface, not a layer painted
 * into the albedo map, and the separation is the whole point. Clouds at a real
 * altitude cast a shadow onto the ground below them, cross the terminator
 * slightly before the surface does, and stand off the edge of the planet near
 * the limb. Painted into the albedo they do none of those things and the
 * planet reads as a decal.
 *
 * The shadow is analytic and lives in the surface shader. From a surface point
 * it steps toward the Sun as far as the cloud shell and samples the cloud
 * coverage there: whatever is overhead in that direction is what shades it.
 * One ray-sphere intersection and one texture fetch.
 *
 * Sampling the cloud map from the surface shader means converting a world
 * direction into the cloud sphere's own frame, so this module owns both sides
 * and hands the surface material a ready-made node. The frame is uploaded as
 * three row vectors rather than a matrix, so there is no chance of a
 * row-major against column-major mistake.
 */

import {
  FrontSide,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  SphereGeometry,
  type Texture,
  Vector3,
} from 'three/webgpu'
import {
  acos, atan, float, positionWorld, texture, uniform, uv, vec2, vec3,
} from 'three/tsl'
import type { BodyDesc } from '../ephem/bodies'
import { bounceLight, sunlight, type SurfaceLighting } from './materials/lighting'
import type { FloatNode, FloatUniform, Vec3Uniform } from './materials/nodes'

/**
 * Cloud deck altitude, metres.
 *
 * Earth's weather clouds sit mostly between 2 and 12 km. 7 km is high enough
 * that the shadow offset and the limb stand-off are visible from orbit, and
 * low enough not to read as a separate shell.
 */
export const CLOUD_ALTITUDE = 7000

/**
 * Cloud drift relative to the surface, radians per second.
 *
 * Prevailing winds move weather systems at tens of metres per second against a
 * surface turning at 465 m/s at the equator, so the deck lags the ground by a
 * few percent of its rotation. Far too slow to watch, and it means a long
 * session does not keep the same weather over the same coastline.
 */
const DRIFT_RATE = -1.4e-6

/** Albedo of a thick cloud deck. They are the first thing on a planet to blow out. */
const CLOUD_ALBEDO = 0.72

const INV_TWO_PI = 1 / (2 * Math.PI)
const INV_PI = 1 / Math.PI

export interface CloudLayer {
  object: Mesh
  /** Planet centre in camera-relative metres. */
  setCentre: (x: number, y: number, z: number) => void
  /** Uniform scale from the distant-body rescale. */
  setScale: (factor: number) => void
  /** The planet's orientation. The drift is added on top of it. */
  setPlanetOrientation: (x: number, y: number, z: number, w: number) => void
  /** Advance the independent drift. */
  advance: (dtSeconds: number) => void
  /**
   * Shadow multiplier for the surface below, in [0,1], as a TSL node.
   *
   * Pass this into the surface material. It shares this layer's uniforms, so
   * the shadow always matches where the clouds actually are.
   */
  surfaceShadow: () => FloatNode
  dispose: () => void
}

/**
 * Direction to the equirectangular UV of a three.js SphereGeometry.
 *
 * SphereGeometry places the vertex at (u, v) along
 *   (-cos(2 pi u) sin(pi v), cos(pi v), sin(2 pi u) sin(pi v))
 * so inverting it gives u from atan2(z, -x) and v from acos(y). Checked at
 * u = 0, which is -X, and u = 0.25, which is +Z.
 */
const directionToSphereUv = (
  dx: FloatNode, dy: FloatNode, dz: FloatNode,
): ReturnType<typeof vec2> => {
  const u = atan(dz, dx.negate()).mul(INV_TWO_PI).fract()
  const v = acos(dy.clamp(-1, 1)).mul(INV_PI)
  return vec2(u, v)
}

export const createCloudLayer = (
  body: BodyDesc,
  map: Texture,
  lighting: SurfaceLighting,
): CloudLayer => {
  const shellRadius = uniform(float(body.radiusEq + CLOUD_ALTITUDE)) as FloatUniform
  const surfaceRadius = uniform(float(body.radiusEq)) as FloatUniform
  const centre = uniform(vec3(0, 0, 0)) as Vec3Uniform

  // Rows of the world-to-cloud rotation, so the surface shader can turn a
  // world direction into the cloud sphere's own frame.
  const cloudRow0 = uniform(vec3(1, 0, 0)) as Vec3Uniform
  const cloudRow1 = uniform(vec3(0, 1, 0)) as Vec3Uniform
  const cloudRow2 = uniform(vec3(0, 0, 1)) as Vec3Uniform

  const material = new MeshBasicNodeMaterial({
    side: FrontSide,
    transparent: true,
    // Written by the surface beneath, not by the deck: the deck is
    // semi-transparent, and writing depth would hide the sky behind its
    // transparent parts.
    depthWrite: false,
    depthTest: true,
    fog: false,
  })

  const coverage = texture(map, uv()).r
  material.colorNode = vec3(1, 1, 1)
    .mul(CLOUD_ALBEDO)
    .mul(sunlight(lighting).add(bounceLight(lighting)))
  material.opacityNode = coverage

  const geometry = new SphereGeometry(1, 96, 48)
  const object = new Mesh(geometry, material)
  object.name = `${body.id}-clouds`
  object.matrixAutoUpdate = false
  object.frustumCulled = false
  // After the surface, before the atmosphere shell.
  object.renderOrder = 5

  const baseShell = body.radiusEq + CLOUD_ALTITUDE

  const planetOrientation = new Quaternion()
  const driftQuaternion = new Quaternion()
  const combined = new Quaternion()
  const inverseMatrix = new Matrix4()
  const northAxis = new Vector3(0, 1, 0)
  let drift = 0

  const writeFrame = (): void => {
    driftQuaternion.setFromAxisAngle(northAxis, drift)
    combined.copy(planetOrientation).multiply(driftQuaternion)
    object.quaternion.copy(combined)
    object.updateMatrix()

    // The inverse of a rotation is its transpose, so the rows of the inverse
    // are the columns of the forward matrix.
    inverseMatrix.makeRotationFromQuaternion(combined).invert()
    const m = inverseMatrix.elements
    cloudRow0.value.set(m[0]!, m[4]!, m[8]!)
    cloudRow1.value.set(m[1]!, m[5]!, m[9]!)
    cloudRow2.value.set(m[2]!, m[6]!, m[10]!)
  }

  const surfaceShadow = (): FloatNode => {
    // Surface point relative to the planet centre. Its length is the surface
    // radius, up to the ellipsoid's flattening.
    const offset = positionWorld.sub(centre)
    const sun = lighting.sunDirection

    // Ray-sphere from the surface outward to the cloud shell. The origin is
    // inside the shell, so the discriminant is always positive and the far
    // root is the one that matters.
    const b = offset.dot(sun)
    const c = offset.dot(offset).sub(shellRadius.mul(shellRadius))
    const t = b.mul(b).sub(c).max(0).sqrt().sub(b)

    const hit = offset.add(sun.mul(t)).normalize()
    // Into the cloud sphere's frame, then to its UVs.
    const local = vec3(hit.dot(cloudRow0), hit.dot(cloudRow1), hit.dot(cloudRow2))
    const shadowUv = directionToSphereUv(local.x, local.y, local.z)

    // Coverage overhead becomes shade below. Not fully opaque: a cloud deck
    // scatters plenty of light downward, so its shadow is grey, not black.
    const overhead = texture(map, shadowUv).r
    return overhead.mul(0.62).oneMinus()
  }

  return {
    object,
    setCentre: (x, y, z) => { centre.value.set(x, y, z); object.position.set(x, y, z); object.updateMatrix() },
    setScale: (factor) => {
      object.scale.setScalar(baseShell * factor)
      shellRadius.value = baseShell * factor
      surfaceRadius.value = body.radiusEq * factor
      object.updateMatrix()
    },
    setPlanetOrientation: (x, y, z, w) => {
      planetOrientation.set(x, y, z, w)
      writeFrame()
    },
    advance: (dt) => { drift = (drift + DRIFT_RATE * dt) % (Math.PI * 2) },
    surfaceShadow,
    dispose: () => { geometry.dispose(); material.dispose() },
  }
}
