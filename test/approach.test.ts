/**
 * How a body looks from far away, and how the ship closes on one.
 *
 * Both of these exist because of the same complaint: planets did not appear to
 * approach. A planet was drawn only once its disc covered a few pixels, so
 * most of a journey was spent looking at nothing, and the speed was
 * unconstrained until a hundred radii out, so the last part happened in a
 * single frame. Neither is a rendering detail; they are the difference between
 * a flight and a teleport.
 */

import { describe, expect, it } from 'vitest'
import {
  angularDiameter, apparentBodyMagnitude, effectiveAreaSquared,
  lambertPhase, pointSourceWeight, regolithPhase, SUN_APPARENT_MAGNITUDE,
} from '../src/scene/bodyMagnitude'
import { BODY_BY_ID, meanRadius } from '../src/ephem/bodies'
import { APPROACH_SECONDS, clampSpeedForApproach, clampSpeedNearMass } from '../src/sim/throttle'
import {
  APPROACH_CORRIDOR_ANGLE, APPROACH_CORRIDOR_RADII, createProximityState, updateProximity,
} from '../src/sim/frames'
import { AU, CLAMP_FLOOR_SPEED, SPEED_MAX } from '../src/sim/constants'
import { Ephemeris } from '../src/ephem/ephemeris'
import { SimClock } from '../src/sim/time'
import { createShipState } from '../src/sim/state'
import { Quaternion, Vector3 } from 'three/webgpu'

const body = (id: string) => BODY_BY_ID.get(id)!

/** Apparent magnitude at a given geometry, in AU, with the phase angle in degrees. */
const magnitudeAt = (
  id: string, sunAU: number, observerAU: number, phaseDegrees = 0, ringTilt = 0,
): number => apparentBodyMagnitude({
  body: body(id),
  sunDistance: sunAU * AU,
  observerDistance: observerAU * AU,
  phaseAngle: (phaseDegrees * Math.PI) / 180,
  ringTiltCosine: ringTilt,
})

describe('phase functions', () => {
  it('are 1 at full phase and 0 at back-lit', () => {
    expect(lambertPhase(0)).toBeCloseTo(1, 9)
    expect(lambertPhase(Math.PI)).toBeCloseTo(0, 9)
    expect(regolithPhase(0)).toBeCloseTo(1, 9)
  })

  it('both fall monotonically with phase angle', () => {
    for (const phase of [lambertPhase, regolithPhase]) {
      let previous = Infinity
      for (let degrees = 0; degrees <= 150; degrees += 10) {
        const value = phase((degrees * Math.PI) / 180)
        expect(value).toBeLessThan(previous)
        previous = value
      }
    }
  })

  /**
   * Regolith backscatters hard, so a rocky body away from full phase is much
   * dimmer than a cloud deck would be. This is the whole reason for having two
   * phase functions rather than one.
   */
  it('makes bare rock far dimmer than a cloud deck at quarter phase', () => {
    const quarter = Math.PI / 2
    expect(regolithPhase(quarter)).toBeLessThan(lambertPhase(quarter) / 3)
  })
})

describe('apparent magnitude of a body', () => {
  /**
   * Against published values. These are the numbers that make a planet's
   * brightness a measurement rather than a choice.
   */
  it('matches published magnitudes across the solar system', () => {
    const checks: [string, number, number][] = [
      ['Jupiter at opposition', magnitudeAt('jupiter', 5.20, 4.20), -2.7],
      ['Jupiter at conjunction', magnitudeAt('jupiter', 5.20, 6.20), -1.8],
      ['Mars at mean opposition', magnitudeAt('mars', 1.52, 0.52), -2.0],
      ['Mars at close opposition', magnitudeAt('mars', 1.38, 0.38), -2.9],
      ['Venus at greatest brilliancy', magnitudeAt('venus', 0.72, 0.43, 118), -4.5],
      ['Neptune at opposition', magnitudeAt('neptune', 30.1, 29.1), 7.8],
      ['full Moon from Earth', magnitudeAt('moon', 1.0, 0.00257), -12.7],
    ]
    for (const [label, computed, published] of checks) {
      expect(computed, label).toBeGreaterThan(published - 0.35)
      expect(computed, label).toBeLessThan(published + 0.35)
    }
  })

  it('gets the quarter Moon right, which needs the regolith phase law', () => {
    // Published first-quarter Moon is about -10.0. A Lambert sphere would say
    // -11.6, which is nearly five times too bright.
    expect(magnitudeAt('moon', 1.0, 0.00257, 90)).toBeCloseTo(-10.2, 0)
  })

  it('treats the Sun as emitting rather than reflecting', () => {
    expect(magnitudeAt('sun', 0, 1)).toBeCloseTo(SUN_APPARENT_MAGNITUDE, 6)
    // Inverse square: ten times further is five magnitudes fainter.
    expect(magnitudeAt('sun', 0, 10) - magnitudeAt('sun', 0, 1)).toBeCloseTo(5, 6)
  })

  it('follows the inverse square law in both distances', () => {
    const near = magnitudeAt('jupiter', 5.2, 4.2)
    // Doubling the observer distance costs 1.505 magnitudes.
    expect(magnitudeAt('jupiter', 5.2, 8.4) - near).toBeCloseTo(2.5 * Math.log10(4), 6)
    // Doubling the Sun distance costs the same again.
    expect(magnitudeAt('jupiter', 10.4, 4.2) - near).toBeCloseTo(2.5 * Math.log10(4), 6)
  })

  /**
   * Jupiter outshining Sirius is the detail that tells you the magnitudes are
   * real, and it only works because the point sprites use the same luminance
   * scale as the star field.
   */
  it('makes Jupiter brighter than the brightest star', () => {
    expect(magnitudeAt('jupiter', 5.20, 4.20)).toBeLessThan(-1.44)
  })

  it('returns something invisible rather than a NaN for a degenerate geometry', () => {
    expect(magnitudeAt('mars', 0, 1)).toBe(Number.POSITIVE_INFINITY)
    expect(magnitudeAt('mars', 1.5, 0)).toBe(Number.POSITIVE_INFINITY)
    // Exactly back-lit. The phase function's limit at 180 degrees is a
    // rounding error rather than a clean zero, so this comes out as a finite
    // but utterly invisible magnitude, which is the same thing in practice:
    // the faintest object any telescope has ever seen is about 32.
    expect(magnitudeAt('mars', 1.5, 0.5, 180)).toBeGreaterThan(30)
  })
})

describe('ring contribution', () => {
  it('adds nothing when the rings are edge on', () => {
    const saturn = body('saturn')
    expect(effectiveAreaSquared(saturn, 0)).toBeCloseTo(saturn.radiusEq ** 2, 6)
  })

  /**
   * Saturn's published magnitude at opposition runs from about -0.5 with the
   * rings wide open to +0.8 with them edge on. A planet-only model gives the
   * edge-on figure and is more than a magnitude wrong the rest of the time.
   */
  it('spans Saturn’s real brightness range as the tilt changes', () => {
    const edgeOn = magnitudeAt('saturn', 9.55, 8.55, 0, 0)
    const wideOpen = magnitudeAt('saturn', 9.55, 8.55, 0, 1)
    expect(edgeOn).toBeGreaterThan(0.3)
    expect(edgeOn).toBeLessThan(1.0)
    expect(wideOpen).toBeGreaterThan(-1.0)
    expect(wideOpen).toBeLessThan(-0.1)
    expect(edgeOn - wideOpen).toBeGreaterThan(1)
  })

  it('leaves a ringless planet alone whatever the tilt', () => {
    const jupiter = body('jupiter')
    expect(effectiveAreaSquared(jupiter, 1)).toBe(jupiter.radiusEq ** 2)
  })
})

describe('point to disc crossfade', () => {
  it('is fully a point while sub-pixel and fully a disc once resolved', () => {
    expect(pointSourceWeight(0)).toBe(1)
    expect(pointSourceWeight(1)).toBe(1)
    expect(pointSourceWeight(20)).toBe(0)
  })

  it('hands over smoothly, with no jump', () => {
    let previous = 1
    for (let pixels = 0; pixels <= 8; pixels += 0.25) {
      const weight = pointSourceWeight(pixels)
      expect(weight).toBeLessThanOrEqual(previous + 1e-9)
      expect(weight).toBeGreaterThanOrEqual(0)
      expect(weight).toBeLessThanOrEqual(1)
      previous = weight
    }
  })

  it('agrees with the angular size of a real approach', () => {
    const jupiter = body('jupiter')
    // At 5 AU Jupiter is a fifth of a pixel, so it must be a point.
    const far = angularDiameter(jupiter.radiusEq, 5 * AU) * (1080 / (65 * Math.PI / 180))
    expect(far).toBeLessThan(0.5)
    expect(pointSourceWeight(far)).toBe(1)

    // At a hundred radii it is a disc, so the point must be gone.
    const near = angularDiameter(jupiter.radiusEq, jupiter.radiusEq * 100) *
      (1080 / (65 * Math.PI / 180))
    expect(near).toBeGreaterThan(10)
    expect(pointSourceWeight(near)).toBe(0)
  })
})

describe('approach speed clamp', () => {
  it('does not restrain a ship heading at nothing', () => {
    expect(clampSpeedForApproach(Number.POSITIVE_INFINITY)).toBe(SPEED_MAX)
  })

  it('allows the remaining gap to be closed in a fixed time', () => {
    expect(clampSpeedForApproach(1e10)).toBeCloseTo(1e10 / APPROACH_SECONDS, 6)
  })

  it('never falls below the manoeuvring floor', () => {
    expect(clampSpeedForApproach(0)).toBe(CLAMP_FLOOR_SPEED)
    expect(clampSpeedForApproach(-1e6)).toBe(CLAMP_FLOOR_SPEED)
  })

  /**
   * The property that makes overshooting impossible.
   *
   * The cap is proportional to the distance left, so integrating it gives
   * exponential decay: the gap falls by a factor of e every APPROACH_SECONDS,
   * so the speed reaches zero as the distance does. A ship at full throttle
   * cannot pass the thing it is flying at.
   *
   * The one exception is deliberate. CLAMP_FLOOR_SPEED means the ship can
   * always manoeuvre at 300 m/s however close it is, so it can reach a
   * surface at all. Without that floor an approach would asymptote forever
   * and arriving would be impossible. So the bound on a single step is what
   * remains plus one frame of the floor speed.
   *
   * Nothing stops the ship continuing through the surface afterwards, because
   * there is no collision: landing and terrain are out of scope.
   */
  it('never crosses more than the distance remaining', () => {
    const jupiter = body('jupiter')
    let gap = 5 * AU
    const dt = 1 / 60
    const allowance = CLAMP_FLOOR_SPEED * dt
    let steps = 0

    while (gap > 0 && steps < 60 * 600) {
      const speed = Math.min(
        clampSpeedForApproach(gap),
        clampSpeedNearMass(gap, gap < meanRadius(jupiter) * 100),
      )
      // At no point may the ship cross more than what is left, plus that one
      // frame of slack. This is the no-overshoot property.
      expect(speed * dt).toBeLessThanOrEqual(gap + allowance)
      gap -= speed * dt
      steps++
    }

    // And it does arrive, rather than asymptoting forever.
    expect(gap).toBeLessThanOrEqual(0)
    expect(steps).toBeLessThan(60 * 600)
  })

  it('takes a watchable amount of time from a realistic distance', () => {
    const jupiter = body('jupiter')
    let gap = 5 * AU
    const dt = 1 / 60
    let seconds = 0

    while (gap > 0 && seconds < 600) {
      const speed = Math.min(
        clampSpeedForApproach(gap),
        clampSpeedNearMass(gap, gap < meanRadius(jupiter) * 100),
      )
      gap -= speed * dt
      seconds += dt
    }

    // Long enough to watch a dot become a world, short enough not to be a
    // chore. Measured in the browser at about 25 seconds from low Earth orbit,
    // most of the difference being the climb out of Earth's own clamp.
    expect(seconds).toBeGreaterThan(8)
    expect(seconds).toBeLessThan(120)
  })
})

describe('what the ship is heading at', () => {
  const aim = (from: Float64Array, at: Float64Array): Float64Array => {
    const direction = new Vector3(at[0]! - from[0]!, at[1]! - from[1]!, at[2]! - from[2]!).normalize()
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction)
    return Float64Array.of(q.x, q.y, q.z, q.w)
  }

  const standOff = (ephem: Ephemeris, id: string, distanceAU: number) => {
    const entry = ephem.get(id)!
    const ship = createShipState()
    const unit = new Vector3(entry.position[0]!, entry.position[1]!, entry.position[2]!).normalize()
    const distance = distanceAU * AU
    ship.position[0] = entry.position[0]! + unit.x * distance
    ship.position[1] = entry.position[1]! + unit.y * distance
    ship.position[2] = entry.position[2]! + unit.z * distance
    ship.orientation.set(aim(ship.position, entry.position))
    return ship
  }

  it('finds a body dead ahead and reports the gap to its surface', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)
    const ship = standOff(ephem, 'jupiter', 8)

    const proximity = updateProximity(ship, ephem, createProximityState(), 'jupiter')
    expect(proximity.approachId).toBe('jupiter')
    expect(proximity.approachGap / AU).toBeCloseTo(8, 1)
  })

  /**
   * The regression that sent the ship out of the galaxy.
   *
   * The corridor started life as a fixed multiple of the body's radius, which
   * is a cylinder. At 1.75 AU, 120 Mars radii subtends a twentieth of a
   * degree: aiming by eye misses it every time, the clamp never engaged, and
   * full throttle took the ship straight past Mars to 2,665 parsecs.
   */
  it('still engages when the aim is off by a degree or two', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)

    for (const offsetDegrees of [0.05, 0.5, 1, 2]) {
      const ship = standOff(ephem, 'mars', 1.75)
      // Nudge the heading off target by the given angle.
      const nudge = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0), (offsetDegrees * Math.PI) / 180,
      )
      const q = new Quaternion(
        ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
      ).multiply(nudge)
      ship.orientation.set(Float64Array.of(q.x, q.y, q.z, q.w))

      const proximity = updateProximity(ship, ephem, createProximityState(), 'mars')
      expect(proximity.approachId, `${offsetDegrees} degrees off`).toBe('mars')
      expect(proximity.approachGap, `${offsetDegrees} degrees off`).toBeLessThan(2 * AU)
    }
  })

  /**
   * And it keeps working however badly the target is aimed at, because the
   * whole loop of the product is picking something and flying at it.
   */
  it('manages the arrival at a selected target even when aimed well off it', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)

    for (const offsetDegrees of [10, 30, 60]) {
      const ship = standOff(ephem, 'mars', 1.75)
      const nudge = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0), (offsetDegrees * Math.PI) / 180,
      )
      const q = new Quaternion(
        ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
      ).multiply(nudge)
      ship.orientation.set(Float64Array.of(q.x, q.y, q.z, q.w))

      const proximity = updateProximity(ship, ephem, createProximityState(), 'mars')
      expect(proximity.approachId, `${offsetDegrees} degrees off`).toBe('mars')
    }

    // Turned right around, it lets go.
    const ship = standOff(ephem, 'mars', 1.75)
    const away = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)
    const q = new Quaternion(
      ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
    ).multiply(away)
    ship.orientation.set(Float64Array.of(q.x, q.y, q.z, q.w))
    const proximity = updateProximity(ship, ephem, createProximityState(), 'mars')
    expect(proximity.approachId).not.toBe('mars')
  })

  /**
   * Slowing down for something already passed is exactly wrong, and it is what
   * a nearest-body clamp does. This is why the approach clamp looks along the
   * nose rather than in every direction.
   */
  it('ignores a body directly behind the ship', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)

    const ship = createShipState()
    const earth = ephem.get('earth')!
    const radius = meanRadius(body('earth'))
    ship.position[0] = earth.position[0]! + radius * 5
    ship.position[1] = earth.position[1]!
    ship.position[2] = earth.position[2]!
    // Pointed directly away from Earth.
    ship.orientation.set(aim(earth.position, ship.position))

    const proximity = updateProximity(ship, ephem, createProximityState())
    expect(proximity.nearestId).toBe('earth')
    expect(proximity.approachId).not.toBe('earth')
  })

  it('ignores an unselected body it would pass well outside the corridor', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)

    const ship = createShipState()
    const earth = ephem.get('earth')!
    const along = 1e11

    // A long way back, aimed parallel to Earth but offset sideways by well
    // more than the corridor's angular width at that range.
    const across = along * Math.tan(APPROACH_CORRIDOR_ANGLE) * 4
    expect(across).toBeGreaterThan(meanRadius(body('earth')) * APPROACH_CORRIDOR_RADII)

    ship.position[0] = earth.position[0]! + along
    ship.position[1] = earth.position[1]! + across
    ship.position[2] = earth.position[2]!
    ship.orientation.set(aim(
      ship.position,
      Float64Array.of(earth.position[0]!, ship.position[1]!, ship.position[2]!),
    ))

    const proximity = updateProximity(ship, ephem, createProximityState())
    expect(proximity.approachId).not.toBe('earth')
  })
})
