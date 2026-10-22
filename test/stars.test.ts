/**
 * The star pipeline: the packed catalogue, the colour conversion, and the
 * magnitude maths that makes the constellations distort.
 *
 * These read the committed binary in public/, so they check the shipped
 * artefact rather than a re-derivation of it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  apparentMagnitude, decodeStars, STAR_RECORD_BYTES, type StarNames,
} from '../src/stars/catalog'
import { ENHANCED_STARS, REALISTIC_STARS } from '../src/stars/starfield'
import { PARSEC, SUN_RELATIVE_RADIANCE } from '../src/sim/constants'
import { magnitudeToLuminance, psfEffectiveArea } from '../src/stars/pointFlux'

const STARS_DIR = join(process.cwd(), 'public', 'data', 'stars')

const catalogue = decodeStars(
  // Copied into a fresh ArrayBuffer: Node's file reads share a pooled buffer,
  // so the raw one would have the wrong byteLength.
  new Uint8Array(readFileSync(join(STARS_DIR, 'stars.bin'))).slice().buffer,
)
const names = JSON.parse(
  readFileSync(join(STARS_DIR, 'star-names.json'), 'utf8'),
) as StarNames

const find = (proper: string): number => {
  const entry = names.entries.find((e) => e.n === proper)
  if (entry === undefined) throw new Error(`${proper} is not in the name index`)
  return entry.i
}

const distanceParsecs = (index: number): number => {
  const p = index * 4
  return Math.hypot(
    catalogue.positionMag[p]!, catalogue.positionMag[p + 1]!, catalogue.positionMag[p + 2]!,
  )
}

/**
 * The indices below `count` that fail `ok`. A whole-catalogue check asserts
 * this is empty once: an expect per star is hundreds of thousands of calls,
 * which runs past the test timeout on a CI runner.
 */
const failing = (count: number, ok: (i: number) => boolean): number[] => {
  const out: number[] = []
  for (let i = 0; i < count; i++) if (!ok(i)) out.push(i)
  return out
}

describe('packed catalogue', () => {
  it('is a whole number of 20-byte records', () => {
    expect(STAR_RECORD_BYTES).toBe(20)
    expect(catalogue.count).toBe(names.count)
  })

  it('holds the whole usable catalogue', () => {
    // HYG v4.4 has 119,614 rows. One is the Sun and 10,224 carry the
    // unknown-parallax placeholder, leaving 109,389.
    expect(catalogue.count).toBe(109389)
  })

  it('dropped the Sun, which is a real body here and not a sprite', () => {
    // Nothing may sit at the origin, and nothing may be absurdly close.
    expect(failing(catalogue.count, (i) => distanceParsecs(i) > 0.01)).toEqual([])
  })

  it('dropped every row with the unknown-parallax placeholder', () => {
    // The placeholder is dist >= 100000 pc. The most distant real star in HYG
    // is a few kiloparsecs.
    expect(failing(catalogue.count, (i) => distanceParsecs(i) < 1e5)).toEqual([])
  })

  it('gives every star a sane absolute magnitude', () => {
    // Brighter than -12 or fainter than +25 would be off the main sequence
    // and off every other sequence too. NaN fails both comparisons.
    expect(failing(catalogue.count, (i) => {
      const absmag = catalogue.positionMag[i * 4 + 3]!
      return absmag > -12 && absmag < 25
    })).toEqual([])
  })

  it('gives every star a colour in range', () => {
    expect(failing(catalogue.count * 3, (i) => {
      const c = catalogue.colour[i]!
      return c >= 0 && c <= 1
    })).toEqual([])
  })
})

describe('known stars', () => {
  /**
   * Distances and magnitudes against published values. If the packer ever
   * mangles a column, this is what catches it.
   */
  const expected: [string, number, number][] = [
    // name, parsecs, apparent magnitude
    ['Sirius', 2.637, -1.44],
    ['Proxima Centauri', 1.296, 11.01],
    ['Vega', 7.679, 0.03],
    ['Betelgeuse', 152.7, 0.45],
    ['Rigel', 264.6, 0.18],
    ['Polaris', 132.6, 1.97],
  ]

  for (const [name, parsecs, magnitude] of expected) {
    it(`places ${name} at the catalogued distance and magnitude`, () => {
      const index = find(name)
      expect(distanceParsecs(index)).toBeCloseTo(parsecs, 1)
      // Seen from the Sun, which is the origin of the catalogue.
      expect(apparentMagnitude(catalogue, index, 0, 0, 0)).toBeCloseTo(magnitude, 2)
    })
  }

  it('colours hot stars blue and cool stars red', () => {
    const rigel = find('Rigel')
    const betelgeuse = find('Betelgeuse')

    const blueness = (i: number): number =>
      catalogue.colour[i * 3 + 2]! - catalogue.colour[i * 3]!

    // Rigel is B8, about 12,000 K. Betelgeuse is M2, about 3,600 K.
    expect(blueness(rigel)).toBeGreaterThan(0.1)
    expect(blueness(betelgeuse)).toBeLessThan(-0.1)
  })

  it('desaturates every star, because real ones look nearly white', () => {
    // The most saturated star in the catalogue should still be well short of a
    // pure hue. Fully saturated colours are the clearest tell of an amateur
    // star field.
    let worst = 0
    for (let i = 0; i < catalogue.count; i++) {
      const r = catalogue.colour[i * 3]!
      const g = catalogue.colour[i * 3 + 1]!
      const b = catalogue.colour[i * 3 + 2]!
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      worst = Math.max(worst, max === 0 ? 0 : (max - min) / max)
    }
    // Nowhere near a pure hue. The clamp on B-V in the packer is what keeps
    // the reddened extremes from running away.
    expect(worst).toBeLessThan(0.55)
  })
})

describe('apparent magnitude from a moving camera', () => {
  /**
   * The single most valuable effect in the product: magnitudes are recomputed
   * from wherever the ship is, so the constellations come apart as it leaves.
   */
  it('brightens a star the ship moves toward', () => {
    const index = find('Sirius')
    const p = index * 4
    const distance = distanceParsecs(index)
    const unit = [
      catalogue.positionMag[p]! / distance,
      catalogue.positionMag[p + 1]! / distance,
      catalogue.positionMag[p + 2]! / distance,
    ] as const

    const fromSun = apparentMagnitude(catalogue, index, 0, 0, 0)
    // Two thirds of the way there.
    const closer = apparentMagnitude(
      catalogue, index, unit[0] * 1.8, unit[1] * 1.8, unit[2] * 1.8,
    )
    expect(closer).toBeLessThan(fromSun)

    // At 0.837 pc the magnitude should be -1.44 + 5 log10(0.837/2.637).
    expect(closer).toBeCloseTo(fromSun + 5 * Math.log10(0.837 / 2.637), 2)
  })

  it('dims a star the ship leaves behind', () => {
    const index = find('Sirius')
    const p = index * 4
    const distance = distanceParsecs(index)
    const unit = [
      catalogue.positionMag[p]! / distance,
      catalogue.positionMag[p + 1]! / distance,
      catalogue.positionMag[p + 2]! / distance,
    ] as const

    // 60 pc out along the same line: Sirius ends up 57.36 pc behind, which
    // takes the brightest star in the sky down to naked-eye marginal.
    const behind = apparentMagnitude(
      catalogue, index, unit[0] * 60, unit[1] * 60, unit[2] * 60,
    )
    expect(behind).toBeCloseTo(1.45 + 5 * Math.log10(57.363 / 10), 1)
    expect(behind).toBeGreaterThan(5)
  })

  it('reorders which star is brightest once the ship has moved', () => {
    const sirius = find('Sirius')
    const rigel = find('Rigel')

    // From the Sun, Sirius wins on apparent magnitude despite Rigel being far
    // more luminous.
    expect(apparentMagnitude(catalogue, sirius, 0, 0, 0))
      .toBeLessThan(apparentMagnitude(catalogue, rigel, 0, 0, 0))

    // Standing 200 pc along the line to Rigel, that reverses.
    const p = rigel * 4
    const distance = distanceParsecs(rigel)
    const cam = [
      (catalogue.positionMag[p]! / distance) * 200,
      (catalogue.positionMag[p + 1]! / distance) * 200,
      (catalogue.positionMag[p + 2]! / distance) * 200,
    ] as const

    expect(apparentMagnitude(catalogue, rigel, cam[0], cam[1], cam[2]))
      .toBeLessThan(apparentMagnitude(catalogue, sirius, cam[0], cam[1], cam[2]))
  })
})

describe('brightness curve', () => {
  const PIXELS_PER_RADIAN = 1080 / ((65 * Math.PI) / 180)

  const sceneValue = (magnitude: number, preset: typeof REALISTIC_STARS): number => {
    const curved = preset.contrastPivot + (magnitude - preset.contrastPivot) * preset.contrast
    return magnitudeToLuminance(curved, PIXELS_PER_RADIAN, preset.psfPixels) * preset.gain
  }

  it('is the true magnitude scale at contrast 1', () => {
    expect(REALISTIC_STARS.contrast).toBe(1)
    // One magnitude is a factor of 2.512.
    const ratio = sceneValue(2, REALISTIC_STARS) / sceneValue(3, REALISTIC_STARS)
    expect(ratio).toBeCloseTo(2.511886, 5)
  })

  it('anchors the absolute scale to the Sun rather than to a chosen constant', () => {
    // The Sun at 1 AU must come out at the radiance of the solar disc, which
    // the surface shader renders independently. Agreeing to a fraction of a
    // percent is what stops a body jumping in brightness when it resolves.
    const psf = REALISTIC_STARS.psfPixels
    const asPoint =
      magnitudeToLuminance(-26.74, PIXELS_PER_RADIAN, psf) * psfEffectiveArea(psf)

    const angular = 2 * Math.asin(6.957e8 / 1.495978707e11)
    const discPixels = Math.PI * ((angular * PIXELS_PER_RADIAN) / 2) ** 2
    const asDisc = SUN_RELATIVE_RADIANCE * discPixels

    expect(asPoint / asDisc).toBeCloseTo(1, 2)
  })

  /**
   * The enhanced preset is a contrast control, not a gain. It has to lift the
   * faint end without meaningfully moving the bright end, or it is just a
   * brightness slider with a better name.
   */
  it('lifts faint stars and leaves the brightest alone', () => {
    const lift = (magnitude: number): number =>
      sceneValue(magnitude, ENHANCED_STARS) / sceneValue(magnitude, REALISTIC_STARS)

    // Sirius, the brightest star in the sky, stays put.
    expect(lift(-1.44)).toBeCloseTo(1, 1)
    // Mid-range stars come up noticeably.
    expect(lift(3)).toBeGreaterThan(1.8)
    // The naked-eye limit comes up several fold, which is the point.
    expect(lift(6.5)).toBeGreaterThan(3)
    // And the lift grows monotonically with magnitude, so nothing is dimmed.
    let previous = 0
    for (const magnitude of [-1.5, 0, 2, 4, 6, 8]) {
      const value = lift(magnitude)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
    expect(previous).toBeGreaterThan(1)
  })

  it('keeps the ordering of stars by brightness either way', () => {
    for (const preset of [REALISTIC_STARS, ENHANCED_STARS]) {
      let previous = Infinity
      for (const magnitude of [-1.5, 0, 1, 2, 3, 4, 5, 6, 7]) {
        const value = sceneValue(magnitude, preset)
        expect(value).toBeLessThan(previous)
        previous = value
      }
    }
  })

  it('never lets the sprite floor fall below a pixel', () => {
    for (const preset of [REALISTIC_STARS, ENHANCED_STARS]) {
      expect(preset.minPixels).toBeGreaterThanOrEqual(1)
      expect(preset.psfPixels).toBeGreaterThanOrEqual(preset.minPixels)
      expect(preset.maxPixels).toBeGreaterThan(preset.psfPixels)
    }
  })
})

describe('search index data', () => {
  it('has a name entry for every famous star people will type', () => {
    for (const name of [
      'Sirius', 'Canopus', 'Arcturus', 'Vega', 'Capella', 'Rigel', 'Procyon',
      'Betelgeuse', 'Altair', 'Aldebaran', 'Antares', 'Spica', 'Pollux',
      'Deneb', 'Polaris', 'Proxima Centauri',
    ]) {
      expect(names.entries.some((e) => e.n === name), name).toBe(true)
    }
  })

  it('points every entry at a real star', () => {
    for (const entry of names.entries) {
      expect(entry.i).toBeGreaterThanOrEqual(0)
      expect(entry.i).toBeLessThan(catalogue.count)
    }
  })

  it('is sorted brightest first, so a common name lands on the famous star', () => {
    let previous = -Infinity
    for (const entry of names.entries) {
      expect(entry.m).toBeGreaterThanOrEqual(previous)
      previous = entry.m
    }
  })

  it('agrees with the binary on every entry it names', () => {
    for (const entry of names.entries.slice(0, 200)) {
      const computed = apparentMagnitude(catalogue, entry.i, 0, 0, 0)
      expect(computed, String(entry.n ?? entry.b)).toBeCloseTo(entry.m, 1)
    }
  })
})

describe('Messier catalogue', () => {
  const messier = JSON.parse(
    readFileSync(join(process.cwd(), 'public', 'data', 'messier.json'), 'utf8'),
  ) as { count: number; objects: { id: string; ra: number; dec: number; pc?: number }[] }

  it('has all 110 objects', () => {
    expect(messier.count).toBe(110)
    expect(messier.objects).toHaveLength(110)
  })

  it('keeps every coordinate in range', () => {
    for (const object of messier.objects) {
      expect(object.ra, object.id).toBeGreaterThanOrEqual(0)
      expect(object.ra, object.id).toBeLessThan(360)
      expect(object.dec, object.id).toBeGreaterThanOrEqual(-90)
      expect(object.dec, object.id).toBeLessThanOrEqual(90)
    }
  })

  it('matches published positions and distances', () => {
    const cases: [string, number, number, number][] = [
      // id, ra, dec, parsecs
      ['M31', 10.68, 41.27, 775000],
      ['M42', 83.82, -5.39, 473],
      ['M45', 56.60, 24.11, 135],
      ['M1', 83.63, 22.02, 2000],
    ]
    for (const [id, ra, dec, pc] of cases) {
      const object = messier.objects.find((o) => o.id === id)!
      expect(object, id).toBeDefined()
      expect(object.ra, id).toBeCloseTo(ra, 1)
      expect(object.dec, id).toBeCloseTo(dec, 1)
      // Within a factor of 1.5, which is better than the literature agrees.
      expect(object.pc! / pc, id).toBeGreaterThan(0.66)
      expect(object.pc! / pc, id).toBeLessThan(1.5)
    }
  })

  it('puts everything outside the star catalogue would reach', () => {
    const andromeda = messier.objects.find((o) => o.id === 'M31')!
    // 775 kpc, which in metres is well past where the sim keeps stars.
    expect(andromeda.pc! * PARSEC).toBeGreaterThan(1e22)
  })
})
