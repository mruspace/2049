/**
 * Reference-frame attachment.
 *
 * Earth moves at about 30 km/s. A ship parked beside it in a purely
 * heliocentric frame is a thousand kilometres behind by the end of the
 * minute, so parking in orbit would be impossible. Inside a body's influence
 * radius the ship is carried by that body's motion instead.
 *
 * The carry is done as a delta, not by storing a second body-relative
 * position. Both are equivalent, but the delta keeps one canonical position
 * and removes a whole class of conversion bugs. The numerical cost is a
 * random walk of roughly a millimetre over a long session, which is nothing
 * against a 6378 km planet.
 */

import type { Ephemeris } from '../ephem/ephemeris'
import { meanRadius } from '../ephem/bodies'
import { SPHERE_OF_INFLUENCE_RADII } from './constants'
import type { ShipState } from './state'
import { forward } from './quat'
import { distance, dot, sub, type Vec3 } from './vec3'

export interface ProximityState {
  /** Body whose frame the ship is riding, or null in deep space. */
  attachedTo: string | null
  /** Nearest body by surface gap, whether or not the ship is attached. */
  nearestId: string | null
  /** Metres from the ship to the nearest body's surface. Negative inside it. */
  distanceToSurface: number
  /** Metres from the ship to that body's centre. */
  distanceToCentre: number
  /** True when inside the influence radius, which is what gates the speed clamp. */
  withinInfluence: boolean
  /**
   * True when the nearest body is behind the nose, so the ship is leaving it.
   *
   * The near-mass clamp exists to make arriving at something flyable. Leaving
   * is not the same problem: nothing is going to be overshot on the way out,
   * so holding the ship to an arrival speed while it departs is pure delay. It
   * cost ten seconds at the start of every journey, with the distance to the
   * destination visibly unchanged.
   */
  receding: boolean
  /**
   * Body the ship is heading at, if any, and how far along its own heading the
   * surface of that body is.
   *
   * This is what stops a planet being overshot. It is separate from
   * `nearestId` because the nearest body is very often behind the ship, and
   * slowing down for something already passed is exactly wrong.
   */
  approachId: string | null
  /** Metres along the nose to the approaching body's surface, or Infinity. */
  approachGap: number
  /**
   * True range to the selected target's surface, or Infinity when there is no
   * body target or it is behind the ship. This is what decides arrival.
   */
  targetGap: number
}

export const createProximityState = (): ProximityState => ({
  attachedTo: null,
  nearestId: null,
  distanceToSurface: Number.POSITIVE_INFINITY,
  distanceToCentre: Number.POSITIVE_INFINITY,
  withinInfluence: false,
  receding: false,
  approachId: null,
  approachGap: Number.POSITIVE_INFINITY,
  targetGap: Number.POSITIVE_INFINITY,
})

/**
 * How wide a corridor counts as heading at a body, in multiples of its radius.
 *
 * This is the near-field term: it catches a body the ship is about to run
 * into. On its own it is nowhere near enough, which is the point of the
 * angular term below.
 */
export const APPROACH_CORRIDOR_RADII = 120

/**
 * Half-angle of the corridor at range, radians. About three degrees.
 *
 * A corridor defined only as a multiple of the body's radius is a cylinder,
 * and at interplanetary range a cylinder is absurdly thin: 120 Mars radii at
 * 1.75 AU is a cone of one twentieth of a degree. Aiming by eye misses that
 * every time, so the clamp never engaged, and full throttle took the ship
 * straight past Mars and several thousand parsecs out of the galaxy.
 *
 * The corridor is the wider of the cylinder and this cone, so it is generous
 * close in and still meaningful at range.
 */
export const APPROACH_CORRIDOR_ANGLE = 0.052

/**
 * The selected target gets a much wider cone: anything at all in front.
 *
 * Flying at your own target is the entire loop of the product, and the ship
 * should manage that arrival however roughly it is aimed. Thirty degrees off
 * still costs only 13% of the closing distance, and the aim can be corrected
 * on the way in. Turning away from the target releases it immediately.
 */
export const TARGET_CORRIDOR_COSINE = 0

/**
 * How much further than the nearest hazard the selected target may be and
 * still be the one named. See the tie-break below.
 */
const TARGET_TIE_MARGIN = 1.1

/**
 * Find the nearest body and decide whether the ship rides its frame.
 *
 * Attachment uses a small hysteresis: it engages at the influence radius and
 * releases at 1.15x that. Without it, a ship hovering exactly on the boundary
 * flickers between frames and the view judders.
 */
const nose: Vec3 = Float64Array.of(0, 0, -1)
const toBody: Vec3 = Float64Array.of(0, 0, 0)

/**
 * @param targetId the body the player has selected, if any. It is treated far
 *                 more generously than anything else: see the corridor
 *                 constants.
 */
export const updateProximity = (
  ship: ShipState,
  ephem: Ephemeris,
  out: ProximityState,
  targetId: string | null = null,
): ProximityState => {
  let bestId: string | null = null
  let bestSurfaceGap = Number.POSITIVE_INFINITY
  let bestCentre = Number.POSITIVE_INFINITY
  let bestRadius = 0
  let bestAlong = 0

  // Where the ship is pointed, which is also where it is going: velocity is
  // set straight from the throttle along the nose.
  forward(nose, ship.orientation)
  let approachId: string | null = null
  let approachGap = Number.POSITIVE_INFINITY
  // Tracked separately, because the target is resolved against the minimum
  // after the loop rather than during it.
  let targetGap = Number.POSITIVE_INFINITY

  for (const entry of ephem.bodies.values()) {
    if (!entry.initialised) continue
    const centre = distance(ship.position, entry.position)
    const radius = meanRadius(entry.desc)
    const gap = centre - radius
    if (gap < bestSurfaceGap) {
      bestSurfaceGap = gap
      bestCentre = centre
      bestId = entry.desc.id
      bestRadius = radius
    }

    // Along-track and across-track distance to this body.
    sub(toBody, entry.position, ship.position)
    const along = dot(toBody, nose)
    if (entry.desc.id === bestId) bestAlong = along
    if (along <= 0) continue

    const isTarget = entry.desc.id === targetId
    if (!isTarget) {
      const across = Math.sqrt(Math.max(0, centre * centre - along * along))
      const corridor = Math.max(
        radius * APPROACH_CORRIDOR_RADII,
        along * Math.tan(APPROACH_CORRIDOR_ANGLE),
      )
      if (across > corridor) continue
    } else if (along / centre <= TARGET_CORRIDOR_COSINE) {
      continue
    }

    // Hazards use the along-track distance, because what matters is when the
    // ship would reach them. The selected target uses its true range instead.
    //
    // The difference is the whole arrival. Along-track distance goes to zero
    // at closest approach whatever the aim, so a heading four degrees off had
    // the ship decelerate to a dead stop eighteen million kilometres from
    // Mars and announce that it had arrived. True range keeps falling only
    // while the ship is actually getting closer, so it slows for what it is
    // near rather than for what it is abeam of.
    const ahead = isTarget ? Math.max(0, centre - radius) : Math.max(0, along - radius)
    if (isTarget) targetGap = ahead
    if (ahead < approachGap) {
      approachGap = ahead
      approachId = entry.desc.id
    }
  }

  out.nearestId = bestId
  out.distanceToSurface = bestSurfaceGap
  out.distanceToCentre = bestCentre
  // A target's own moons sit at very nearly the same distance and routinely
  // win the minimum by a fraction of a percent. The clamp behaves identically
  // either way, but the HUD reporting "slowing for Ganymede" while the player
  // is flying to Jupiter is needless confusion, so a near tie goes to the
  // thing that was actually asked for.
  if (
    targetId !== null &&
    // Finite means the target was actually ahead. Without this check, a target
    // behind the ship ties Infinity against Infinity and wins.
    Number.isFinite(targetGap) &&
    targetGap <= approachGap * TARGET_TIE_MARGIN
  ) {
    approachId = targetId
    approachGap = Math.min(approachGap, targetGap)
  }
  out.targetGap = targetGap

  out.approachId = approachId
  out.approachGap = approachGap
  out.receding = bestAlong <= 0

  if (bestId === null) {
    out.withinInfluence = false
    out.attachedTo = null
    return out
  }

  const engage = bestRadius * SPHERE_OF_INFLUENCE_RADII
  const release = engage * 1.15
  const wasAttachedHere = out.attachedTo === bestId
  const threshold = wasAttachedHere ? release : engage

  out.withinInfluence = bestCentre < threshold
  out.attachedTo = out.withinInfluence ? bestId : null
  return out
}

const carryDelta: Vec3 = Float64Array.of(0, 0, 0)

/**
 * Move the ship by the attached body's motion since the last update.
 *
 * Must run after Ephemeris.update and before flight integration, so the ship
 * starts the tick already in the right place relative to the body.
 */
export const carryWithFrame = (
  ship: ShipState,
  ephem: Ephemeris,
  proximity: ProximityState,
): void => {
  const id = proximity.attachedTo
  ship.attachedTo = id
  if (id === null) return
  const entry = ephem.get(id)
  if (entry === undefined || !entry.initialised) return

  sub(carryDelta, entry.position, entry.previous)
  ship.position[0] = ship.position[0]! + carryDelta[0]!
  ship.position[1] = ship.position[1]! + carryDelta[1]!
  ship.position[2] = ship.position[2]! + carryDelta[2]!
}
