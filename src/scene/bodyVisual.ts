/**
 * One body on screen: mesh, material, and optionally an atmosphere and rings.
 *
 * Geometry is a shared unit sphere scaled per body, which is what makes
 * oblateness free: Saturn is 60,268 km equatorial against 54,364 km polar, and
 * a round Saturn is simply wrong. The scale is (equatorial, polar, equatorial)
 * because local +Y is the spin axis.
 *
 * Orientation is built from the IAU pole and prime-meridian angle rather than
 * from an axial tilt and a rotation period, so the sub-solar point lands at the
 * right longitude. That is one of the few things in this scene that can be
 * checked against reality rather than eyeballed.
 */

import {
  Matrix4,
  Mesh,
  type MeshBasicNodeMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { BodyDesc } from '../ephem/bodies'
import type { BodyEphemeris } from '../ephem/ephemeris'
import type { Vec3 } from '../sim/vec3'
import { rebaseBody } from './origin'
import type { Atmosphere } from './materials/atmosphere'
import type { CloudLayer } from './clouds'
import type { Rings } from './rings'
import type { SurfaceLighting } from './materials/lighting'

/**
 * Shared geometry. 128x64 segments: enough that the limb is smooth at any
 * distance you can fly to, and irrelevant to performance at fifteen bodies.
 */
const UNIT_SPHERE = new SphereGeometry(1, 128, 64)

export interface BodyVisual {
  desc: BodyDesc
  object: Mesh
  material: MeshBasicNodeMaterial
  lighting: SurfaceLighting
  atmosphere?: Atmosphere
  rings?: Rings
  clouds?: CloudLayer
  /** Distance from the camera to the body centre on the last update, metres. */
  distance: number
  /** Everything this body contributes to the scene graph. */
  nodes: Object3D[]
}

export const createBodyVisual = (
  desc: BodyDesc,
  material: MeshBasicNodeMaterial,
  lighting: SurfaceLighting,
  extras: { atmosphere?: Atmosphere; rings?: Rings; clouds?: CloudLayer } = {},
): BodyVisual => {
  const object = new Mesh(UNIT_SPHERE, material)
  object.name = desc.id
  object.matrixAutoUpdate = false
  object.frustumCulled = false

  const nodes: Object3D[] = [object]
  if (extras.clouds !== undefined) nodes.push(extras.clouds.object)
  if (extras.atmosphere !== undefined) nodes.push(extras.atmosphere.object)
  if (extras.rings !== undefined) nodes.push(extras.rings.object)

  return {
    desc,
    object,
    material,
    lighting,
    ...extras,
    distance: Number.POSITIVE_INFINITY,
    nodes,
  }
}

const basis = new Matrix4()
const primeMeridian = new Vector3()
const northVector = new Vector3()
const thirdAxis = new Vector3()
const orientation = new Quaternion()

/**
 * Rotation that takes the body's local frame into EQJ.
 *
 * Local +Y is the spin axis and local +X is the prime meridian, which is what
 * puts longitude 0 at u = 0.5 on an equirectangular map. The prime meridian
 * direction comes from the IAU construction: start at the ascending node of the
 * body's equator on the ICRF equator, then rotate by W about the pole.
 *
 * @param northX,northY,northZ the IAU north pole as a unit vector in EQJ.
 * @param spinDegrees          the IAU prime-meridian angle W, already wrapped.
 */
export const bodyOrientation = (
  northX: number, northY: number, northZ: number, spinDegrees: number,
): Quaternion => {
  northVector.set(northX, northY, northZ).normalize()

  // Ascending node of the body equator on the ICRF equator. For a pole at
  // right ascension a0, that node lies at a0 + 90 degrees.
  const nodeRa = Math.atan2(northVector.y, northVector.x) + Math.PI / 2
  const nodeX = Math.cos(nodeRa)
  const nodeY = Math.sin(nodeRa)

  // Rotate the node by W about the pole to reach the prime meridian.
  const w = (spinDegrees * Math.PI) / 180
  const cosW = Math.cos(w)
  const sinW = Math.sin(w)

  // north x node, which completes the orthonormal pair in the body's equator.
  const perpX = northVector.y * 0 - northVector.z * nodeY
  const perpY = northVector.z * nodeX - northVector.x * 0
  const perpZ = northVector.x * nodeY - northVector.y * nodeX

  primeMeridian.set(
    nodeX * cosW + perpX * sinW,
    nodeY * cosW + perpY * sinW,
    perpZ * sinW,
  ).normalize()

  // Right-handed: local Z is local X cross local Y.
  thirdAxis.copy(primeMeridian).cross(northVector).normalize()

  basis.makeBasis(primeMeridian, northVector, thirdAxis)
  return orientation.setFromRotationMatrix(basis)
}

/**
 * Place and orient one body for this frame.
 *
 * @param shipWorld ship position, heliocentric EQJ metres.
 * @param sunWorld  the Sun's position in the same frame. It is the origin, but
 *                  it is passed rather than assumed so a body's lighting does
 *                  not silently depend on that.
 */
export const updateBodyVisual = (
  visual: BodyVisual,
  entry: BodyEphemeris,
  shipWorld: Vec3,
  sunWorld: Vec3,
): void => {
  const { desc, object } = visual

  const placement = rebaseBody(
    object, entry.position, shipWorld,
    desc.radiusEq, desc.radiusPolar, desc.radiusEq,
  )
  visual.distance = placement.trueDistance

  object.quaternion.copy(bodyOrientation(
    entry.north[0]!, entry.north[1]!, entry.north[2]!, entry.spinDeg,
  ))
  object.updateMatrix()

  // Lighting is computed from the true Float64 vectors, never from the
  // rescaled render transform. Getting this wrong would make distant planets
  // silently mis-lit.
  const sunDx = sunWorld[0]! - entry.position[0]!
  const sunDy = sunWorld[1]! - entry.position[1]!
  const sunDz = sunWorld[2]! - entry.position[2]!
  const distanceToSun = Math.hypot(sunDx, sunDy, sunDz)
  visual.lighting.update(sunDx, sunDy, sunDz, distanceToSun)

  if (visual.clouds !== undefined) {
    visual.clouds.setScale(placement.factor)
    visual.clouds.setCentre(object.position.x, object.position.y, object.position.z)
    visual.clouds.setPlanetOrientation(
      object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w,
    )
  }

  if (visual.atmosphere !== undefined) {
    visual.atmosphere.setScale(placement.factor)
    visual.atmosphere.setCentre(object.position.x, object.position.y, object.position.z)
  }

  if (visual.rings !== undefined) {
    visual.rings.setScale(placement.factor)
    visual.rings.setCentre(object.position.x, object.position.y, object.position.z)
    visual.rings.setPlaneNormal(entry.north[0]!, entry.north[1]!, entry.north[2]!)
    // The ring plane is the body's equator, so the annulus is rotated out of
    // its own local XY plane onto that equator.
    visual.rings.object.quaternion.copy(object.quaternion).multiply(RING_TILT)
    visual.rings.object.updateMatrix()
  }
}

/** RingGeometry lies in local XY; the equator is local XZ. */
const RING_TILT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)

export const disposeSharedGeometry = (): void => { UNIT_SPHERE.dispose() }
