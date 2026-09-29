/**
 * Click and tap to target.
 *
 * Bodies are a ray-sphere test against their rendered position, which already
 * has the distant-body rescale applied. Testing against the true position
 * instead would miss, because the rescale is what puts Neptune inside the far
 * plane.
 *
 * Stars are an angular search over the whole catalogue. 109,000 direction
 * comparisons on a click is nothing, and it avoids maintaining a spatial index
 * that would have to be rebuilt as apparent magnitudes change with the ship's
 * position. The tolerance is generous and ties break on brightness, so aiming
 * at a constellation lands on the star a person meant.
 */

import type { Camera } from 'three/webgpu'
import { Raycaster, Vector2, Vector3 } from 'three/webgpu'
import { PARSEC } from '../sim/constants'
import type { StarCatalogue } from '../stars/catalog'
import { apparentMagnitude } from '../stars/catalog'
import type { Vec3 } from '../sim/vec3'
import type { BodyVisual } from './bodyVisual'

/** Angular tolerance for picking a star, radians. About 0.9 degrees. */
const STAR_TOLERANCE = 0.016

export interface PickResult {
  kind: 'body' | 'star'
  /** Body id, or catalogue index as a string. */
  id: string
  /** Metres from the camera, for choosing between overlapping hits. */
  distance: number
}

const raycaster = new Raycaster()
const pointer = new Vector2()
const direction = new Vector3()

export const pick = (
  clientX: number, clientY: number,
  element: HTMLElement,
  camera: Camera,
  visuals: Iterable<BodyVisual>,
  catalogue: StarCatalogue,
  shipPosition: Vec3,
): PickResult | null => {
  const rect = element.getBoundingClientRect()
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)

  // Bodies first: a planet in front of a star should win, and it is the
  // cheaper test.
  let best: PickResult | null = null
  for (const visual of visuals) {
    const hits = raycaster.intersectObject(visual.object, false)
    const hit = hits[0]
    if (hit === undefined) continue
    if (best === null || hit.distance < best.distance) {
      best = { kind: 'body', id: visual.desc.id, distance: visual.distance }
    }
  }
  if (best !== null) return best

  direction.copy(raycaster.ray.direction).normalize()

  const camX = shipPosition[0]! / PARSEC
  const camY = shipPosition[1]! / PARSEC
  const camZ = shipPosition[2]! / PARSEC

  let bestIndex = -1
  let bestScore = Number.POSITIVE_INFINITY

  for (let i = 0; i < catalogue.count; i++) {
    const p = i * 4
    const dx = catalogue.positionMag[p]! - camX
    const dy = catalogue.positionMag[p + 1]! - camY
    const dz = catalogue.positionMag[p + 2]! - camZ
    const length = Math.hypot(dx, dy, dz)
    if (length === 0) continue

    // Cosine of the angle between the ray and the star.
    const cosine = (dx * direction.x + dy * direction.y + dz * direction.z) / length
    if (cosine < 1 - STAR_TOLERANCE * STAR_TOLERANCE * 0.5) continue

    const angle = Math.acos(Math.min(1, cosine))
    if (angle > STAR_TOLERANCE) continue

    // Score prefers a close angular match, but a much brighter star slightly
    // further off the ray still wins, which is what a person aiming at a
    // constellation actually means.
    const magnitude = apparentMagnitude(catalogue, i, camX, camY, camZ)
    const score = angle / STAR_TOLERANCE + magnitude * 0.05
    if (score < bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  if (bestIndex < 0) return null
  const p = bestIndex * 4
  const pc = Math.hypot(
    catalogue.positionMag[p]! - camX,
    catalogue.positionMag[p + 1]! - camY,
    catalogue.positionMag[p + 2]! - camZ,
  )
  return { kind: 'star', id: String(bestIndex), distance: pc * PARSEC }
}
