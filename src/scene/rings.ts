/**
 * Planetary rings.
 *
 * Rings must self-shadow and cast onto the planet, or they look like a
 * sticker. Both are analytic tests, and both are cheap:
 *
 *   planet shadows rings  a ring point is in shadow when it lies behind the
 *                         planet along the Sun direction and within the
 *                         planet's radius of that axis. A cylinder test.
 *   rings shadow planet   a surface point is shaded when the line from it
 *                         toward the Sun crosses the ring plane between the
 *                         inner and outer radius. A ray-plane test.
 *
 * Brightness follows the optically thin slab model rather than a surface
 * normal dot product, and that turns out to matter a great deal in this
 * decade. Saturn's rings passed through the Sun's plane in 2025, so their
 * solar elevation is a couple of degrees for years either side. A cosine model
 * multiplies them by about 0.04 and they vanish; a first version did exactly
 * that and Saturn appeared with no rings at all.
 *
 * The slab model is what is physically going on: at a grazing angle the light
 * path through the ring is longer, so the ring gets optically thicker rather
 * than dimmer. Its brightness is 1 - exp(-tau / mu), which saturates toward 1
 * as mu goes to zero instead of collapsing. The projected area still shrinks,
 * which is why a near edge-on ring reads as a bright thin line, and that is
 * what it looks like through a telescope.
 *
 * The texture is a one-dimensional radial strip, 8192x500 with alpha, so the
 * shader samples it by radius rather than by the geometry's UVs. Those map to
 * a square bounding box and would smear the bands.
 */

import {
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  type Texture,
} from 'three/webgpu'
import { float, positionLocal, positionWorld, texture, uniform, vec2, vec3 } from 'three/tsl'
import type { BodyDesc, RingDesc } from '../ephem/bodies'
import type { SurfaceLighting } from './materials/lighting'
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from './materials/nodes'

export interface Rings {
  object: Mesh
  /** Shadow the rings cast on the planet, for the surface material. */
  surfaceShadow: () => FloatNode
  /** Planet centre in camera-relative metres. */
  setCentre: (x: number, y: number, z: number) => void
  /** The ring plane normal in world space: the body's spin axis. */
  setPlaneNormal: (x: number, y: number, z: number) => void
  setScale: (factor: number) => void
  dispose: () => void
}

export const createRings = (
  body: BodyDesc,
  ring: RingDesc,
  map: Texture,
  lighting: SurfaceLighting,
): Rings => {
  const inner = uniform(float(ring.inner)) as FloatUniform
  const outer = uniform(float(ring.outer)) as FloatUniform
  // The distant-body rescale, shared with the shadow test so both agree.
  const ringScale = uniform(float(1)) as FloatUniform
  const planetRadius = uniform(float(body.radiusEq))
  const centre = uniform(vec3(0, 0, 0)) as Vec3Uniform

  // RingGeometry lies in the local XY plane, so the radius of a fragment is
  // the length of its local position.
  //
  // The geometry is built at true scale in metres and the distant-body rescale
  // is applied through object.scale, so `positionLocal` is always in unscaled
  // metres. The inner and outer radii it is compared against must therefore
  // stay unscaled too. Scaling them was a real bug: past 1e8 m the ratio went
  // above 1, every fragment clamped to the outermost texel of the strip, which
  // is transparent, and the entire ring system disappeared while its shadow on
  // the planet carried on working perfectly.
  const radius = positionLocal.xy.length()
  const u = radius.sub(inner).div(outer.sub(inner)).clamp(0, 1)
  const sampled = texture(map, vec2(u, 0.5))

  // The plane normal is a uniform rather than something derived from the
  // interpolated geometry, because the ring is a flat annulus and its normal
  // is a property of the body's spin axis, not of the fragment.
  const planeNormal = uniform(vec3(0, 1, 0)) as Vec3Uniform

  // Optical depth across the ring, from its own coverage. Saturn's B ring is
  // around 1 to 2 and the C ring nearer 0.1, so scaling the alpha channel by
  // a little under 1 spans the real range.
  const tau = sampled.a.mul(0.9).max(1e-3)

  // Cosines of the Sun and the viewer against the ring plane, floored so a
  // perfectly edge-on ring stays finite rather than dividing by zero.
  const muSun = planeNormal.dot(lighting.sunDirection).abs().max(0.02)
  const muView = planeNormal.dot(positionWorld.normalize()).abs().max(0.02)

  // Fraction of the incident beam scattered, and the fraction of the ring that
  // is opaque along the line of sight. Both saturate at grazing angles.
  const scattered = tau.div(muSun).negate().exp().oneMinus()
  const covered = tau.div(muView).negate().exp().oneMinus()

  // Ring particles are dirty water ice, geometric albedo around 0.5.
  const particleAlbedo = float(0.5)

  // Cylinder shadow test: behind the planet along the Sun direction, and
  // within a planet radius of that axis.
  const toPoint = positionWorld.sub(centre)
  const along = toPoint.dot(lighting.sunDirection)
  const perpendicular = toPoint.sub(lighting.sunDirection.mul(along)).length()
  const inShadow = along.lessThan(0).and(perpendicular.lessThan(planetRadius))
  const shadow = inShadow.select(float(0.06), float(1))

  const material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  // The texture's colour carries the banding; its overall level is set by the
  // particle albedo and the scattering fraction.
  material.colorNode = sampled.rgb
    .mul(particleAlbedo)
    .mul(scattered)
    .mul(shadow)
    .mul(lighting.irradiance)
  material.opacityNode = covered

  // Radial segments only: the bands are radial, so angular tessellation is
  // what matters and there is nothing to gain from rings of quads.
  const geometry = new RingGeometry(ring.inner, ring.outer, 256, 1)
  const object = new Mesh(geometry, material)
  object.name = `${body.id}-rings`
  object.matrixAutoUpdate = false
  object.renderOrder = 20

  return {
    object,
    surfaceShadow: () => ringShadowFactor(ring, lighting, centre, planeNormal, ringScale),
    setPlaneNormal: (x: number, y: number, z: number) => { planeNormal.value.set(x, y, z) },
    setCentre: (x, y, z) => {
      centre.value.set(x, y, z)
      object.position.set(x, y, z)
      object.updateMatrix()
    },
    setScale: (factor) => {
      ringScale.value = factor
      object.scale.setScalar(factor)
      // `inner` and `outer` are deliberately not scaled: see above.
      // `planetRadius` is, because the shadow test works in world space.
      planetRadius.value = body.radiusEq * factor
      object.updateMatrix()
    },
    dispose: () => { geometry.dispose(); material.dispose() },
  }
}

/**
 * The shadow the rings cast onto the planet, as a multiplier in [0,1].
 *
 * Called from the gas giant shader. The surface point is projected toward the
 * Sun onto the ring plane; if it lands between the inner and outer radius, the
 * rings are in the way.
 */
export const ringShadowFactor = (
  ring: RingDesc,
  lighting: SurfaceLighting,
  centre: Vec3Node,
  planeNormal: Vec3Node,
  scale: FloatNode,
): FloatNode => {
  const toPoint = positionWorld.sub(centre)
  const heightAbovePlane = toPoint.dot(planeNormal)
  const cosine = planeNormal.dot(lighting.sunDirection)
  // Grazing sunlight: the ray never reaches the plane, so nothing is shadowed.
  const t = heightAbovePlane.negate().div(cosine)
  const hit = toPoint.add(lighting.sunDirection.mul(t))
  const hitRadius = hit.sub(planeNormal.mul(hit.dot(planeNormal))).length()

  const within = t.greaterThan(0)
    .and(hitRadius.greaterThan(float(ring.inner).mul(scale)))
    .and(hitRadius.lessThan(float(ring.outer).mul(scale)))

  return within.select(float(0.25), float(1))
}
