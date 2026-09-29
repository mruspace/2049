#!/usr/bin/env node
/**
 * HYG v4.4 CSV to a packed binary the GPU can take without a parse pass.
 *
 * Record layout, 20 bytes, little-endian:
 *   0  float32 x    parsecs, J2000 equatorial (EQJ), straight from the CSV
 *   4  float32 y
 *   8  float32 z
 *  12  float32 absmag
 *  16  uint8   r     linear sRGB, already desaturated
 *  17  uint8   g
 *  18  uint8   b
 *  19  uint8   pad   keeps the stride at a 4-byte multiple
 *
 * No frame rotation happens here. HYG xyz, astronomy-engine's HelioVector and
 * RotationAxis are all EQJ already, so the whole project uses EQJ and converts
 * nothing. See src/sim/constants.ts.
 *
 * Two filters matter:
 *   - id 0 is the Sun. It is a real body in this sim, not a sprite.
 *   - dist >= 100000 is the catalogue's "parallax missing or negative"
 *     placeholder, about 10k rows. Left in, they form a shell of junk stars at
 *     100 kpc that is immediately obvious from outside the solar system.
 *
 * Output is CC BY-SA 4.0, inherited from HYG. It lives in its own directory
 * with its own LICENSE so the share-alike term stays contained and never
 * reaches the source tree.
 */

import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BV, bvToRgbBytes } from './star-color.mjs'
import { HYG } from './sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'tools', '.cache')
const OUT = join(ROOT, 'public', 'data', 'stars')

export const RECORD_BYTES = 20
/** The catalogue's placeholder for an unusable parallax. */
const BOGUS_DISTANCE = 100000

/**
 * Which stars get a searchable name entry.
 * Everything with a proper name or a Bayer/Flamsteed designation, plus
 * anything naked-eye bright. That is a few thousand rows, small enough to ship
 * as JSON. Bare HD and HIP numbers are served from the id index instead.
 */
const NAME_MAG_CUTOFF = 5.0

const stripQuotes = (s) => (s.length > 1 && s.charCodeAt(0) === 34 ? s.slice(1, -1) : s)

const main = async () => {
  await mkdir(OUT, { recursive: true })

  const src = join(CACHE, HYG.name)
  const rl = createInterface({
    input: createReadStream(src).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let header = null
  let col = {}
  let rows = 0, kept = 0, bogus = 0, sun = 0, noColour = 0

  // Grow-as-needed rather than two passes over 13 MB of gzip.
  let capacity = 1 << 17
  let buf = Buffer.alloc(capacity * RECORD_BYTES)
  const names = []
  let ids = Buffer.alloc(capacity * 8)

  const grow = () => {
    capacity *= 2
    const nb = Buffer.alloc(capacity * RECORD_BYTES); buf.copy(nb); buf = nb
    const ni = Buffer.alloc(capacity * 8); ids.copy(ni); ids = ni
  }

  for await (const line of rl) {
    if (header === null) {
      header = line.split(',').map((h) => stripQuotes(h))
      header.forEach((h, i) => { col[h] = i })
      const required = ['id', 'proper', 'dist', 'mag', 'absmag', 'ci', 'x', 'y', 'z']
      const missing = required.filter((r) => col[r] === undefined)
      if (missing.length > 0) throw new Error(`HYG header is missing: ${missing.join(', ')}`)
      continue
    }
    if (line === '') continue
    rows++

    // Verified: this file has no embedded commas in any field, so a plain
    // split is safe. Quoting is inconsistent per field, so strip per field.
    const f = line.split(',')

    if (f[col.id] === '0') { sun++; continue }

    const dist = Number(f[col.dist])
    if (!Number.isFinite(dist) || dist >= BOGUS_DISTANCE || dist <= 0) { bogus++; continue }

    const x = Number(f[col.x]), y = Number(f[col.y]), z = Number(f[col.z])
    const absmag = Number(f[col.absmag])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(absmag)) {
      bogus++; continue
    }

    const ciRaw = f[col.ci]
    let bv = Number(ciRaw)
    if (ciRaw === '' || !Number.isFinite(bv)) { bv = DEFAULT_BV; noColour++ }
    const [r, g, b] = bvToRgbBytes(bv)

    if (kept >= capacity) grow()
    const o = kept * RECORD_BYTES
    buf.writeFloatLE(x, o)
    buf.writeFloatLE(y, o + 4)
    buf.writeFloatLE(z, o + 8)
    buf.writeFloatLE(absmag, o + 12)
    buf[o + 16] = r; buf[o + 17] = g; buf[o + 18] = b; buf[o + 19] = 0

    const hip = Number(f[col.hip]) || 0
    const hd = Number(f[col.hd]) || 0
    ids.writeInt32LE(hip, kept * 8)
    ids.writeInt32LE(hd, kept * 8 + 4)

    const proper = stripQuotes(f[col.proper] ?? '')
    const bf = stripQuotes(f[col.bf] ?? '').trim()
    const mag = Number(f[col.mag])
    if (proper !== '' || bf !== '' || (Number.isFinite(mag) && mag <= NAME_MAG_CUTOFF)) {
      const entry = { i: kept, m: Number(mag.toFixed(2)) }
      if (proper !== '') entry.n = proper
      if (bf !== '') entry.b = bf
      const con = stripQuotes(f[col.con] ?? '').trim()
      if (con !== '') entry.c = con
      if (hip) entry.hip = hip
      if (hd) entry.hd = hd
      names.push(entry)
    }
    kept++
  }

  const stars = buf.subarray(0, kept * RECORD_BYTES)
  await writeFile(join(OUT, 'stars.bin'), stars)
  await writeFile(join(OUT, 'star-ids.bin'), ids.subarray(0, kept * 8))

  // Brightest first, so a search for a common name lands on the famous star.
  names.sort((a, b) => a.m - b.m)
  await writeFile(join(OUT, 'star-names.json'), JSON.stringify({
    version: 'hyg_v44',
    count: kept,
    record: RECORD_BYTES,
    entries: names,
  }))

  await writeFile(join(OUT, 'LICENSE'), LICENSE_TEXT)

  const named = names.filter((n) => n.n !== undefined).length
  console.info(`HYG v4.4 -> public/data/stars`)
  console.info(`  rows read          ${rows}`)
  console.info(`  Sun row dropped    ${sun}`)
  console.info(`  bogus distance     ${bogus}   (dist >= ${BOGUS_DISTANCE})`)
  console.info(`  no colour index    ${noColour}   (defaulted to B-V ${DEFAULT_BV})`)
  console.info(`  stars packed       ${kept}`)
  console.info(`  stars.bin          ${(stars.length / 1e6).toFixed(2)} MB`)
  console.info(`  star-ids.bin       ${((kept * 8) / 1e6).toFixed(2)} MB`)
  console.info(`  search entries     ${names.length}   (${named} with proper names)`)
}

const LICENSE_TEXT = `These files are derived from the HYG Database v4.4.

    stars.bin
    star-ids.bin
    star-names.json

Source:  https://codeberg.org/astronexus/hyg
Author:  David Nash (astronexus)
License: Creative Commons Attribution-ShareAlike 4.0 International
         https://creativecommons.org/licenses/by-sa/4.0/

Changes made: the CSV was filtered (the Sun and rows with unusable parallax
were removed) and repacked into a binary layout, and the B-V colour index was
converted to a linear sRGB triple.

These data files are licensed CC BY-SA 4.0, separately from the source code of
this project, which is Apache-2.0. The share-alike term applies to these files
and to adaptations of them. It does not apply to the rest of the repository.
`

main().catch((err) => {
  console.error(`pack-stars failed: ${err.message}`)
  process.exit(1)
})
