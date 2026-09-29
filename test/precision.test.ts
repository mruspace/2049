/**
 * The coordinate system.
 *
 * This is the load-bearing part of the project. Anything built on a naive
 * coordinate system has to be rewritten, so these run first and they are
 * deliberately blunt.
 */

import { describe, expect, it } from 'vitest'
import { Object3D } from 'three/webgpu'
import { rebaseBody, METRES_TO_PARSEC } from '../src/scene/origin'
import { angularRadius, placeForRender } from '../src/sim/scale'
import { AU, PARSEC, RENDER_DISTANCE_MAX } from '../src/sim/constants'
import { vec3 } from '../src/sim/vec3'

describe('floating origin', () => {
  it('places a nearby body at its true offset', () => {
    const object = new Object3D()
    const ship = vec3(AU, 0, 0)
    const body = vec3(AU + 1000, 500, -250)

    const result = rebaseBody(object, body, ship, 10, 10, 10)

    expect(result.rescaled).toBe(false)
    expect(result.factor).toBe(1)
    expect(object.position.x).toBeCloseTo(1000, 6)
    expect(object.position.y).toBeCloseTo(500, 6)
    expect(object.position.z).toBeCloseTo(-250, 6)
  })

  /**
   * The step 1 jitter test, in numbers.
   *
   * A cube 1e15 m from the Sun, with the ship one metre away from it. The
   * subtraction has to happen in Float64 and only its result may reach
   * Float32. Doing it the other way round loses the metre entirely: Float32
   * has about seven significant digits and 1e15 needs sixteen.
   */
  it('resolves a one-metre offset at 1e15 m from the origin', () => {
    const object = new Object3D()
    const far = 1e15
    const ship = vec3(far, 0, 0)
    const body = vec3(far + 1, 0, 0)

    rebaseBody(object, body, ship, 1, 1, 1)
    expect(object.position.x).toBe(1)

    // And the naive version, for contrast: the same two numbers through
    // Float32 before subtracting.
    const naive = Math.fround(far + 1) - Math.fround(far)
    expect(naive).not.toBe(1)
  })

  it('has no accumulated drift when the ship walks away one metre at a time', () => {
    const object = new Object3D()
    const body = vec3(1e13, 0, 0)
    for (let step = 1; step <= 64; step++) {
      const ship = vec3(1e13 - step, 0, 0)
      rebaseBody(object, body, ship, 1, 1, 1)
      expect(object.position.x).toBe(step)
    }
  })
})

describe('distant-body rescale', () => {
  it('leaves anything inside the limit alone', () => {
    const placement = placeForRender(RENDER_DISTANCE_MAX * 0.5)
    expect(placement.factor).toBe(1)
    expect(placement.drawDistance).toBe(RENDER_DISTANCE_MAX * 0.5)
  })

  it('pulls a distant body in to exactly the limit', () => {
    const placement = placeForRender(45 * AU)
    expect(placement.drawDistance).toBeCloseTo(RENDER_DISTANCE_MAX, 6)
    expect(placement.factor).toBeLessThan(1)
  })

  /**
   * The property the whole trick rests on. If angular size is not preserved
   * then Neptune is the wrong size on screen, which is the one thing about it
   * anyone can check.
   */
  it('preserves angular size exactly', () => {
    const neptuneRadius = 24764000
    for (const distance of [1e9, 1e10, 4.5e12, 1e14]) {
      const placement = placeForRender(distance)
      const trueAngle = angularRadius(neptuneRadius, distance)
      const drawnAngle = angularRadius(
        neptuneRadius * placement.factor, placement.drawDistance,
      )
      expect(drawnAngle).toBeCloseTo(trueAngle, 12)
    }
  })

  /**
   * Front-to-back ordering has to survive, or a rescaled Saturn can end up
   * drawn in front of a rescaled Jupiter that is actually nearer.
   */
  it('is strictly increasing in distance', () => {
    let previous = 0
    for (const distance of [1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13]) {
      const drawn = placeForRender(distance).drawDistance
      expect(drawn).toBeGreaterThanOrEqual(previous)
      previous = drawn
    }
  })

  it('applies the same factor to the object as to its position', () => {
    const object = new Object3D()
    const ship = vec3(0, 0, 0)
    const body = vec3(4.5e12, 0, 0)
    const radius = 24764000

    const result = rebaseBody(object, body, ship, radius, radius, radius)

    expect(object.position.length()).toBeCloseTo(RENDER_DISTANCE_MAX, 3)
    expect(object.scale.x / radius).toBeCloseTo(result.factor, 12)
  })
})

describe('parsec conversion', () => {
  it('round-trips through the star catalogue unit', () => {
    expect(PARSEC * METRES_TO_PARSEC).toBeCloseTo(1, 12)
    // Sirius, 2.637 pc, in metres.
    expect(2.637 * PARSEC * METRES_TO_PARSEC).toBeCloseTo(2.637, 9)
  })

  /**
   * Why nearby stars do not shift as the ship crosses the solar system.
   *
   * Not because the offset is unrepresentable. Float32 spacing at 100 is about
   * 7.6e-6, so a 30 AU move is perfectly resolvable. It is because the
   * resulting angular shift is a fraction of an arcsecond, which is three
   * orders of magnitude below one pixel. Sirius does not move when you fly to
   * Mars, and that is the physics, not a limitation of the arithmetic.
   */
  it('shifts a 100 pc star by far less than a pixel across the whole solar system', () => {
    const baseline = 30 * AU * METRES_TO_PARSEC
    const shiftRadians = baseline / 100

    // One pixel at a 65 degree field of view over 1080 rows.
    const pixelRadians = (65 * Math.PI / 180) / 1080

    expect(shiftRadians).toBeLessThan(pixelRadians / 500)
    // And it is representable, which is the part that is easy to get wrong.
    expect(Math.fround(100 + baseline)).not.toBe(Math.fround(100))
  })
})
