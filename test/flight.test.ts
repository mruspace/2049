/**
 * The flight model: throttle, clamp, frames and units.
 *
 * All of this is pure and imports no three.js, which is the point of keeping
 * `sim` free of it.
 */

import { describe, expect, it } from 'vitest'
import {
  CLAMP_FLOOR_SPEED, LIGHT_YEAR, SPEED_MAX, SPEED_MIN,
} from '../src/sim/constants'
import { clampSpeedNearMass, speedToThrottle, throttleToSpeed } from '../src/sim/throttle'
import { formatDistance, formatDuration, formatSpeed, timeToTarget } from '../src/sim/units'
import { integrateRotation, integrateThrottle, MAX_TURN_RATE, THROTTLE_RATE } from '../src/sim/flight'
import { createControlInput, createShipState } from '../src/sim/state'
import { forward } from '../src/sim/quat'
import { vec3 } from '../src/sim/vec3'
import { MAX_FOV, MIN_FOV, verticalFovFor } from '../src/render/renderer'
import { BEARING_DEAD_ZONE, screenBearing } from '../src/sim/targeting'
import { Quaternion, Vector3 } from 'three/webgpu'

describe('logarithmic throttle', () => {
  it('stops at zero rather than creeping at 1 m/s', () => {
    expect(throttleToSpeed(0)).toBe(0)
  })

  it('spans 1 m/s to 1000 light years per second', () => {
    expect(throttleToSpeed(Number.EPSILON)).toBeGreaterThanOrEqual(SPEED_MIN * 0.999)
    expect(throttleToSpeed(1)).toBeCloseTo(SPEED_MAX, -12)
    expect(SPEED_MAX / LIGHT_YEAR).toBeCloseTo(1000, 6)
  })

  it('is monotonic across the whole range', () => {
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const speed = throttleToSpeed(Math.min(1, t))
      expect(speed).toBeGreaterThan(previous)
      previous = speed
    }
  })

  /**
   * The reason for the log scale: equal travel gives equal ratio, so the
   * control is as usable at walking pace as at a thousand light years a
   * second. On a linear scale the first 99.99% of the travel would all be
   * "effectively stopped".
   */
  it('gives equal speed ratios for equal throttle steps', () => {
    const a = throttleToSpeed(0.3) / throttleToSpeed(0.2)
    const b = throttleToSpeed(0.8) / throttleToSpeed(0.7)
    expect(a).toBeCloseTo(b, 6)
  })

  it('round-trips through speedToThrottle', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(speedToThrottle(throttleToSpeed(t))).toBeCloseTo(t, 9)
    }
  })
})

describe('near-mass speed clamp', () => {
  it('does nothing outside a body’s influence', () => {
    expect(clampSpeedNearMass(1e3, false)).toBe(SPEED_MAX)
  })

  it('keeps at least two seconds of approach time', () => {
    const gap = 1e7
    expect(clampSpeedNearMass(gap, true)).toBeCloseTo(gap / 2, 6)
  })

  it('never falls below the manoeuvring floor, even inside the surface', () => {
    expect(clampSpeedNearMass(0, true)).toBe(CLAMP_FLOOR_SPEED)
    expect(clampSpeedNearMass(-5000, true)).toBe(CLAMP_FLOOR_SPEED)
  })

  it('is never higher than the global maximum', () => {
    expect(clampSpeedNearMass(1e30, true)).toBe(SPEED_MAX)
  })
})

describe('unit formatting', () => {
  it('picks the unit that keeps the number readable', () => {
    expect(formatSpeed(12).unit).toBe('m/s')
    expect(formatSpeed(7800).unit).toBe('km/s')
    expect(formatSpeed(2e8).unit).toBe('c')
    expect(formatSpeed(5 * LIGHT_YEAR).unit).toBe('ly/s')
  })

  it('reports familiar distances in familiar units', () => {
    expect(formatDistance(400e3).text).toBe('400 km')
    const mars = formatDistance(0.52 * 1.495978707e11)
    expect(mars.unit).toBe('AU')
    expect(mars.value).toBeCloseTo(0.52, 6)
    expect(formatDistance(8.6 * LIGHT_YEAR).unit).toBe('ly')
    expect(formatDistance(2000 * LIGHT_YEAR).unit).toBe('pc')
  })

  it('shows an em dash rather than Infinity when stopped', () => {
    expect(timeToTarget(1e9, 0)).toBe(Infinity)
    expect(formatDuration(Infinity).text).toBe('—')
  })

  it('reports plausible travel times', () => {
    // Earth to the Moon at 10 km/s is about eleven hours.
    const hours = timeToTarget(3.844e8, 1e4) / 3600
    expect(hours).toBeCloseTo(10.7, 1)
    expect(formatDuration(hours * 3600).unit).toBe('h')
  })
})

describe('rate-based rotation', () => {
  /**
   * The defining property: holding the stick keeps turning the ship. With
   * position-based steering the nose would stop the moment the input stopped
   * changing, which is unflyable when a turn takes several seconds.
   */
  it('keeps turning while the stick is held', () => {
    const ship = createShipState()
    const input = createControlInput()
    input.yaw = 1

    const angles: number[] = []
    const nose = vec3()
    for (let step = 0; step < 3; step++) {
      integrateRotation(ship, input, 0.5)
      forward(nose, ship.orientation)
      angles.push(Math.atan2(nose[0]!, -nose[2]!))
    }

    // The angle keeps growing at a constant rate for as long as the input is
    // held. That is the whole property.
    expect(Math.abs(angles[0]!)).toBeCloseTo(MAX_TURN_RATE * 0.5, 6)
    expect(Math.abs(angles[1]!)).toBeCloseTo(MAX_TURN_RATE * 1.0, 6)
    expect(Math.abs(angles[2]!)).toBeCloseTo(MAX_TURN_RATE * 1.5, 6)
  })

  /**
   * Steering direction, which is easy to invert and very obvious when wrong.
   *
   * The input layer sets `yaw = -stickX`, so moving the pointer to the right
   * of centre gives a negative yaw, and that has to turn the nose toward +X,
   * which is screen right.
   */
  it('turns the nose right when the pointer is right of centre', () => {
    const ship = createShipState()
    const input = createControlInput()
    input.yaw = -1

    integrateRotation(ship, input, 0.5)
    const nose = vec3()
    forward(nose, ship.orientation)

    expect(nose[0]!).toBeGreaterThan(0)
    expect(nose[2]!).toBeLessThan(0)
  })

  it('pitches the nose up when the pointer is above centre', () => {
    const ship = createShipState()
    const input = createControlInput()
    // The input layer sets `pitch = -stickY`, and screen Y grows downward, so
    // a pointer above centre gives a positive pitch.
    input.pitch = 1

    integrateRotation(ship, input, 0.5)
    const nose = vec3()
    forward(nose, ship.orientation)

    expect(nose[1]!).toBeGreaterThan(0)
  })

  it('keeps the orientation quaternion normalised', () => {
    const ship = createShipState()
    const input = createControlInput()
    input.pitch = 1
    input.yaw = -0.7
    input.roll = 0.3
    for (let step = 0; step < 2000; step++) integrateRotation(ship, input, 1 / 60)
    const length = Math.hypot(
      ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
    )
    expect(length).toBeCloseTo(1, 12)
  })
})

describe('throttle control', () => {
  it('moves at the documented rate and clamps to [0,1]', () => {
    const ship = createShipState()
    const input = createControlInput()
    input.throttleRate = 1

    integrateThrottle(ship, input, 1)
    expect(ship.throttle).toBeCloseTo(THROTTLE_RATE, 9)

    integrateThrottle(ship, input, 1000)
    expect(ship.throttle).toBe(1)

    input.throttleRate = -1
    integrateThrottle(ship, input, 1000)
    expect(ship.throttle).toBe(0)
  })

  it('cuts to zero on a full stop, whatever the throttle input says', () => {
    const ship = createShipState()
    ship.throttle = 0.8
    const input = createControlInput()
    input.throttleRate = 1
    input.fullStop = true
    integrateThrottle(ship, input, 1)
    expect(ship.throttle).toBe(0)
  })
})

describe('field of view', () => {
  /**
   * three.js specifies field of view vertically, which is the wrong way round
   * for a phone held upright: a 65 degree vertical view at an aspect of 0.5 is
   * only 35 degrees across. The horizontal field is what gets held roughly
   * constant instead.
   */
  it('keeps a wide window at the angle the cockpit is designed around', () => {
    expect(verticalFovFor(16 / 9)).toBe(MIN_FOV)
    expect(verticalFovFor(21 / 9)).toBe(MIN_FOV)
  })

  it('opens up on a tall window so the horizontal view stays usable', () => {
    const portrait = verticalFovFor(390 / 844)
    expect(portrait).toBeGreaterThan(MIN_FOV)
    expect(portrait).toBeLessThanOrEqual(MAX_FOV)

    const horizontal = (aspect: number, fov: number): number =>
      (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * aspect) * 180) / Math.PI

    // Without the correction a phone would see 35 degrees across.
    expect(horizontal(390 / 844, MIN_FOV)).toBeLessThan(40)
    expect(horizontal(390 / 844, portrait)).toBeGreaterThan(55)
  })

  it('never exceeds the fisheye limit', () => {
    expect(verticalFovFor(0.05)).toBe(MAX_FOV)
    expect(verticalFovFor(0)).toBeLessThanOrEqual(MAX_FOV)
  })

  it('is monotonic: a taller window never narrows the vertical view', () => {
    let previous = 0
    for (const aspect of [3, 2, 1.6, 1.2, 1, 0.8, 0.6, 0.45, 0.3]) {
      const fov = verticalFovFor(aspect)
      expect(fov).toBeGreaterThanOrEqual(previous)
      previous = fov
    }
  })
})

describe('screen bearing to a target', () => {
  /**
   * The off-screen arrow is driven by this, and it exists because the obvious
   * alternative is broken. Projecting the target and using the result works in
   * front of the camera and fails behind it, where the perspective divide is
   * by a negative w and the coordinates flip sign. The symptom is an arrow
   * that wanders around the screen as the ship turns away from its target.
   */
  const identity = { x: 0, y: 0, z: 0, w: 1 }
  const degrees = (radians: number): number => (radians * 180) / Math.PI

  it('reads right, left, up and down correctly in front of the camera', () => {
    // Camera looks down -Z, so anything with a negative z is in front.
    const cases: [string, [number, number, number], number][] = [
      ['ahead and right', [0.6, 0, -0.8], 0],
      ['ahead and left', [-0.6, 0, -0.8], 180],
      ['ahead and above', [0, 0.6, -0.8], 90],
      ['ahead and below', [0, -0.6, -0.8], -90],
    ]
    for (const [label, direction, expected] of cases) {
      const bearing = screenBearing(Float64Array.from(direction), identity)
      expect(bearing.inFront, label).toBe(true)
      expect(degrees(bearing.angle), label).toBeCloseTo(expected, 4)
    }
  })

  /**
   * The case that was wrong. A target behind and to the right still needs an
   * arrow that says turn right, and the bearing must not flip as the target
   * crosses from in front to behind.
   */
  it('keeps pointing the same way as a target passes behind', () => {
    const bearings: number[] = []
    // Sweep a target from dead ahead round to dead behind, staying on the
    // right-hand side throughout.
    for (let angle = 5; angle <= 175; angle += 5) {
      const radians = (angle * Math.PI) / 180
      const direction = Float64Array.of(Math.sin(radians), 0, -Math.cos(radians))
      const bearing = screenBearing(direction, identity)
      // Skip the exact boundary: at 90 degrees the forward component is
      // cos(pi/2), which floating point puts on whichever side it likes.
      if (angle < 89) expect(bearing.inFront, `${angle} degrees`).toBe(true)
      if (angle > 91) expect(bearing.inFront, `${angle} degrees`).toBe(false)
      bearings.push(degrees(bearing.angle))
    }
    // Every one of them says "right", on both sides of the crossing.
    for (const value of bearings) expect(Math.abs(value)).toBeLessThan(1e-6)
  })

  it('respects the camera orientation rather than world axes', () => {
    // Camera rolled 90 degrees about its own forward axis: what was up is now
    // to the side.
    const rolled = new Quaternion().setFromAxisAngle(new Vector3(0, 0, -1), Math.PI / 2)
    const above = Float64Array.of(0, 0.6, -0.8)
    const bearing = screenBearing(above, rolled)
    expect(bearing.inFront).toBe(true)
    expect(Math.abs(degrees(bearing.angle))).toBeCloseTo(180, 4)
  })

  it('is continuous as a target sweeps across the view', () => {
    let previous: number | null = null
    for (let angle = 0; angle < 360; angle += 2) {
      const radians = (angle * Math.PI) / 180
      // A target on a cone 45 degrees off the view axis, sweeping around it.
      const direction = Float64Array.of(
        Math.cos(radians) * Math.SQRT1_2,
        Math.sin(radians) * Math.SQRT1_2,
        -Math.SQRT1_2,
      )
      const { angle: bearing } = screenBearing(direction, identity)
      if (previous !== null) {
        // Shortest angular step between samples, which must stay small.
        let delta = bearing - previous
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        expect(Math.abs(degrees(delta))).toBeLessThan(5)
      }
      previous = bearing
    }
  })
})

describe('bearing dead zone', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 }

  it('reports no usable bearing for a target dead ahead or dead behind', () => {
    expect(screenBearing(Float64Array.of(0, 0, -1), identity).lateral)
      .toBeLessThan(BEARING_DEAD_ZONE)
    expect(screenBearing(Float64Array.of(0, 0, 1), identity).lateral)
      .toBeLessThan(BEARING_DEAD_ZONE)
  })

  it('reports a usable bearing as soon as the target is off the axis', () => {
    // One degree off is already well clear of the dead zone.
    const oneDegree = (1 * Math.PI) / 180
    const direction = Float64Array.of(Math.sin(oneDegree), 0, -Math.cos(oneDegree))
    expect(screenBearing(direction, identity).lateral).toBeGreaterThan(BEARING_DEAD_ZONE)
  })

  it('grows to 1 at ninety degrees off the axis', () => {
    expect(screenBearing(Float64Array.of(1, 0, 0), identity).lateral).toBeCloseTo(1, 9)
  })
})
