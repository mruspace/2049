/**
 * The ephemeris, the clock and body orientation.
 *
 * These are checked against published values rather than against themselves,
 * because the whole product rests on the claim that the positions are real.
 */

import { describe, expect, it } from 'vitest'
import { HelioVector, Body } from 'astronomy-engine'
import { Ephemeris } from '../src/ephem/ephemeris'
import { BODIES, BODY_BY_ID, meanRadius } from '../src/ephem/bodies'
import { bodyOrientation } from '../src/scene/bodyVisual'
import { AU, JD_J2000, JD_MAX, JD_MIN } from '../src/sim/constants'
import { dateToJulian, julianToDate, SimClock } from '../src/sim/time'
import { createProximityState, carryWithFrame, updateProximity } from '../src/sim/frames'
import { createShipState } from '../src/sim/state'
import { Vector3 } from 'three/webgpu'

describe('simulation clock', () => {
  it('round-trips a date through the Julian date', () => {
    const date = new Date('2049-07-04T12:00:00.000Z')
    expect(julianToDate(dateToJulian(date)).toISOString()).toBe(date.toISOString())
  })

  it('agrees with the standard Julian date for J2000.0', () => {
    expect(dateToJulian(new Date('2000-01-01T12:00:00.000Z'))).toBeCloseTo(JD_J2000, 9)
  })

  /**
   * The trap this file exists for.
   *
   * astronomy-engine's numeric time is days since J2000, not a raw Julian
   * date. Handing it a JD gives a date about 6700 years out, and its own error
   * message points the wrong way.
   */
  it('hands astronomy-engine days since J2000, not a Julian date', () => {
    const clock = new SimClock(new Date('2049-12-31T12:00:00.000Z'))
    const time = clock.astroTime()
    expect(time.ut).toBeCloseTo(clock.julianDate - JD_J2000, 6)
    expect(time.date.toISOString()).toBe('2049-12-31T12:00:00.000Z')
  })

  it('clamps to the supported window', () => {
    const clock = new SimClock()
    clock.setJulianDate(JD_MIN - 10000)
    expect(clock.julianDate).toBe(JD_MIN)
    clock.setJulianDate(JD_MAX + 10000)
    expect(clock.julianDate).toBe(JD_MAX)
  })

  it('advances by simulated seconds scaled by the rate', () => {
    const clock = new SimClock(new Date('2026-01-01T00:00:00.000Z'))
    const start = clock.julianDate
    clock.advance(86400)
    expect(clock.julianDate - start).toBeCloseTo(1, 9)
    clock.rate = 0
    const held = clock.julianDate
    clock.advance(86400)
    expect(clock.julianDate).toBe(held)
  })

  /**
   * Why this matters: MakeTime evaluates the delta-T polynomial, so building
   * one per body per frame costs more than all the position maths together.
   * Every ephemeris call in a frame has to share the same object.
   */
  it('reuses one AstroTime within a frame and rebuilds it after a step', () => {
    const clock = new SimClock()
    const first = clock.astroTime()
    expect(clock.astroTime()).toBe(first)

    clock.advance(60)
    const second = clock.astroTime()
    expect(second).not.toBe(first)
    expect(clock.astroTime()).toBe(second)
  })
})

describe('ephemeris', () => {
  it('puts every planet at a plausible distance from the Sun', () => {
    const clock = new SimClock(new Date('2026-09-17T12:00:00.000Z'))
    const ephem = new Ephemeris()
    ephem.update(clock, 0)

    // Semi-major axes in AU, with generous room for eccentricity.
    const expected: Record<string, [number, number]> = {
      mercury: [0.30, 0.47], venus: [0.71, 0.73], earth: [0.98, 1.02],
      mars: [1.38, 1.67], jupiter: [4.95, 5.46], saturn: [9.02, 10.07],
      uranus: [18.3, 20.1], neptune: [29.8, 30.4], pluto: [29.6, 49.4],
    }

    for (const [id, [low, high]] of Object.entries(expected)) {
      const entry = ephem.get(id)
      expect(entry, id).toBeDefined()
      const au = Math.hypot(
        entry!.position[0]!, entry!.position[1]!, entry!.position[2]!,
      ) / AU
      expect(au, id).toBeGreaterThan(low)
      expect(au, id).toBeLessThan(high)
    }
  })

  it('keeps the Sun at the origin, which is what heliocentric means', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)
    const sun = ephem.get('sun')!
    expect(Math.hypot(sun.position[0]!, sun.position[1]!, sun.position[2]!)).toBe(0)
  })

  it('matches astronomy-engine exactly, in metres', () => {
    const clock = new SimClock(new Date('2030-03-15T06:00:00.000Z'))
    const ephem = new Ephemeris()
    ephem.update(clock, 0)
    const reference = HelioVector(Body.Mars, clock.astroTime())
    const mars = ephem.get('mars')!
    expect(mars.position[0]!).toBeCloseTo(reference.x * AU, 3)
    expect(mars.position[1]!).toBeCloseTo(reference.y * AU, 3)
    expect(mars.position[2]!).toBeCloseTo(reference.z * AU, 3)
  })

  it('puts the Moon at a lunar distance from Earth, not from the Sun', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)
    const earth = ephem.get('earth')!
    const moon = ephem.get('moon')!
    const separation = Math.hypot(
      moon.position[0]! - earth.position[0]!,
      moon.position[1]! - earth.position[1]!,
      moon.position[2]! - earth.position[2]!,
    )
    // Perigee 3.63e8 m, apogee 4.06e8 m.
    expect(separation).toBeGreaterThan(3.5e8)
    expect(separation).toBeLessThan(4.1e8)
  })

  it('puts the Galilean moons around Jupiter at their own radii', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)
    const jupiter = ephem.get('jupiter')!

    // Semi-major axes in metres.
    const orbits: Record<string, number> = {
      io: 4.217e8, europa: 6.709e8, ganymede: 1.0704e9, callisto: 1.8827e9,
    }
    for (const [id, radius] of Object.entries(orbits)) {
      const moon = ephem.get(id)!
      const separation = Math.hypot(
        moon.position[0]! - jupiter.position[0]!,
        moon.position[1]! - jupiter.position[1]!,
        moon.position[2]! - jupiter.position[2]!,
      )
      // Well inside a factor of 1.3, which covers eccentricity and projection.
      expect(separation / radius, id).toBeGreaterThan(0.75)
      expect(separation / radius, id).toBeLessThan(1.3)
    }
  })

  it('reports a velocity of about 30 km/s for Earth', () => {
    const clock = new SimClock()
    const ephem = new Ephemeris()
    ephem.update(clock, 0)
    clock.advance(60)
    ephem.update(clock, 60)
    const earth = ephem.get('earth')!
    const speed = Math.hypot(earth.velocity[0]!, earth.velocity[1]!, earth.velocity[2]!)
    expect(speed).toBeGreaterThan(2.8e4)
    expect(speed).toBeLessThan(3.1e4)
  })

  it('wraps the IAU spin angle, which is unbounded upstream', () => {
    const clock = new SimClock(new Date('2049-07-04T12:00:00.000Z'))
    const ephem = new Ephemeris()
    ephem.update(clock, 0)
    for (const id of ['earth', 'saturn', 'mars']) {
      const spin = ephem.get(id)!.spinDeg
      expect(spin, id).toBeGreaterThanOrEqual(0)
      expect(spin, id).toBeLessThan(360)
    }
  })

  it('gives every body a unit north vector', () => {
    const ephem = new Ephemeris()
    ephem.update(new SimClock(), 0)
    for (const entry of ephem.bodies.values()) {
      const length = Math.hypot(entry.north[0]!, entry.north[1]!, entry.north[2]!)
      expect(length, entry.desc.id).toBeCloseTo(1, 9)
    }
  })
})

describe('body orientation', () => {
  /**
   * The check that the IAU construction is right: where the Sun is overhead.
   *
   * At noon UTC the sub-solar point is near the Greenwich meridian, off by the
   * equation of time, and its latitude is the solar declination. Both are
   * independently known, so this catches a wrong pole, a wrong prime meridian
   * and a wrong handedness.
   */
  it('puts the sub-solar point at the right longitude and latitude', () => {
    const cases: [string, number, number][] = [
      // date, expected longitude, expected latitude
      ['2026-09-17T12:00:00.000Z', -2, 2.1],
      ['2026-09-17T00:00:00.000Z', 178, 2.3],
      ['2026-09-17T18:00:00.000Z', -92, 2.0],
      ['2026-03-20T12:00:00.000Z', 1, 0],
    ]

    for (const [iso, expectLon, expectLat] of cases) {
      const clock = new SimClock(new Date(iso))
      const ephem = new Ephemeris()
      ephem.update(clock, 0)
      const earth = ephem.get('earth')!

      const quaternion = bodyOrientation(
        earth.north[0]!, earth.north[1]!, earth.north[2]!, earth.spinDeg,
      ).clone()

      // Body axes in world space: local +X is the prime meridian, +Y is north.
      const primeMeridian = new Vector3(1, 0, 0).applyQuaternion(quaternion)
      const north = new Vector3(0, 1, 0).applyQuaternion(quaternion)
      const third = new Vector3(0, 0, 1).applyQuaternion(quaternion)

      const toSun = new Vector3(
        -earth.position[0]!, -earth.position[1]!, -earth.position[2]!,
      ).normalize()

      // Increasing u on the sphere is eastward, and that takes +X toward -Z.
      const longitude = Math.atan2(-toSun.dot(third), toSun.dot(primeMeridian)) * 180 / Math.PI
      const latitude = Math.asin(Math.max(-1, Math.min(1, toSun.dot(north)))) * 180 / Math.PI

      expect(longitude, `${iso} longitude`).toBeCloseTo(expectLon, 0)
      expect(latitude, `${iso} latitude`).toBeCloseTo(expectLat, 0)
    }
  })
})

describe('reference frame attachment', () => {
  it('carries the ship with a body it is parked beside', () => {
    const clock = new SimClock()
    const ephem = new Ephemeris()
    const ship = createShipState()
    const proximity = createProximityState()

    ephem.update(clock, 0)
    const earth = ephem.get('earth')!
    const altitude = meanRadius(BODY_BY_ID.get('earth')!) * 3

    ship.position[0] = earth.position[0]! + altitude
    ship.position[1] = earth.position[1]!
    ship.position[2] = earth.position[2]!

    updateProximity(ship, ephem, proximity)
    expect(proximity.attachedTo).toBe('earth')

    // One minute of simulated time. Earth moves about 1800 km.
    const before = Math.hypot(
      ship.position[0]! - earth.position[0]!,
      ship.position[1]! - earth.position[1]!,
      ship.position[2]! - earth.position[2]!,
    )
    clock.advance(60)
    ephem.update(clock, 60)
    carryWithFrame(ship, ephem, proximity)

    const after = Math.hypot(
      ship.position[0]! - ephem.get('earth')!.position[0]!,
      ship.position[1]! - ephem.get('earth')!.position[1]!,
      ship.position[2]! - ephem.get('earth')!.position[2]!,
    )

    // The body-relative position is preserved to well under a metre, against a
    // 1800 km move of the frame itself.
    expect(Math.abs(after - before)).toBeLessThan(1)
  })

  it('does not carry the ship when it is nowhere near anything', () => {
    const ephem = new Ephemeris()
    const clock = new SimClock()
    const ship = createShipState()
    const proximity = createProximityState()

    ephem.update(clock, 0)
    ship.position[0] = 500 * AU

    updateProximity(ship, ephem, proximity)
    expect(proximity.attachedTo).toBeNull()
    expect(proximity.withinInfluence).toBe(false)

    const before = ship.position[0]!
    clock.advance(3600)
    ephem.update(clock, 3600)
    carryWithFrame(ship, ephem, proximity)
    expect(ship.position[0]!).toBe(before)
  })

  it('never differences across a date jump', () => {
    const clock = new SimClock(new Date('2026-01-01T00:00:00.000Z'))
    const ephem = new Ephemeris()
    ephem.update(clock, 0)

    // A jump of a decade, applied the way the date control does it.
    clock.setJulianDate(clock.julianDate + 3650)
    ephem.update(clock, 0)

    const earth = ephem.get('earth')!
    // dt of 0 means the velocity is discarded rather than computed from a
    // ten-year position difference, which would read as 3000 km/s.
    expect(Math.hypot(earth.velocity[0]!, earth.velocity[1]!, earth.velocity[2]!)).toBe(0)
    // And `previous` equals `position`, so a frame carry cannot teleport.
    expect(earth.previous[0]!).toBe(earth.position[0]!)
  })
})

describe('body table', () => {
  it('has unique ids and a resolvable parent for every moon', () => {
    const ids = new Set<string>()
    for (const body of BODIES) {
      expect(ids.has(body.id), body.id).toBe(false)
      ids.add(body.id)
      if (body.parent !== undefined) {
        expect(BODY_BY_ID.has(body.parent), `${body.id} parent`).toBe(true)
      }
    }
  })

  it('never has a polar radius larger than the equatorial one', () => {
    for (const body of BODIES) {
      expect(body.radiusPolar, body.id).toBeLessThanOrEqual(body.radiusEq)
    }
  })

  it('keeps Saturn visibly oblate, because a round Saturn is wrong', () => {
    const saturn = BODY_BY_ID.get('saturn')!
    expect(saturn.radiusEq / saturn.radiusPolar).toBeGreaterThan(1.09)
  })

  it('puts every ring system outside its planet', () => {
    for (const body of BODIES) {
      if (body.rings === undefined) continue
      expect(body.rings.inner, body.id).toBeGreaterThan(body.radiusEq)
      expect(body.rings.outer, body.id).toBeGreaterThan(body.rings.inner)
    }
  })
})
