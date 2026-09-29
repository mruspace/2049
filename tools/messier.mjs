#!/usr/bin/env node
/**
 * The Messier catalogue, for the search box.
 *
 * Positions and distances come from SIMBAD's TAP service rather than from a
 * typed-in table, because a hand-entered coordinate is a silent error that
 * only shows up as an object in the wrong constellation.
 *
 * SIMBAD returns ICRS right ascension and declination in degrees. ICRS and
 * J2000 mean equator agree to well under an arcsecond, which is far below
 * anything visible here, so these drop straight into the project's EQJ frame
 * with no rotation.
 *
 * Distances have many published measurements per object with mixed units. The
 * median in parsecs is used: robust against the occasional outlier, and only
 * needs to be good enough to fly to.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'tools', '.cache')
const OUT = join(ROOT, 'public', 'data')

const TAP = 'https://simbad.u-strasbg.fr/simbad/sim-tap/sync'

const POSITION_QUERY =
  'SELECT i.id AS mid, b.ra AS ra, b.dec AS dec, b.otype_txt AS otype ' +
  'FROM ident AS i JOIN basic AS b ON i.oidref = b.oid WHERE i.id LIKE \'M %\''

const DISTANCE_QUERY =
  'SELECT i.id AS mid, d.dist AS dist, d.unit AS unit ' +
  'FROM ident AS i JOIN mesDistance AS d ON i.oidref = d.oidref WHERE i.id LIKE \'M %\''

/** The ones people actually type. Everything else is searchable as "M31". */
const COMMON_NAMES = {
  M1: 'Crab Nebula', M8: 'Lagoon Nebula', M11: 'Wild Duck Cluster',
  M13: 'Hercules Globular Cluster', M16: 'Eagle Nebula', M17: 'Omega Nebula',
  M20: 'Trifid Nebula', M27: 'Dumbbell Nebula', M31: 'Andromeda Galaxy',
  M32: 'Andromeda Satellite', M33: 'Triangulum Galaxy', M42: 'Orion Nebula',
  M43: 'De Mairan’s Nebula', M44: 'Beehive Cluster', M45: 'Pleiades',
  M51: 'Whirlpool Galaxy', M57: 'Ring Nebula', M63: 'Sunflower Galaxy',
  M64: 'Black Eye Galaxy', M65: 'Leo Triplet Member', M76: 'Little Dumbbell Nebula',
  M77: 'Cetus A', M81: 'Bode’s Galaxy', M82: 'Cigar Galaxy',
  M87: 'Virgo A', M97: 'Owl Nebula', M101: 'Pinwheel Galaxy',
  M104: 'Sombrero Galaxy', M108: 'Surfboard Galaxy', M109: 'Vacuum Cleaner Galaxy',
}

/** SIMBAD object type codes, shortened for the HUD. */
const TYPE_LABELS = {
  SNR: 'supernova remnant', GlC: 'globular cluster', OpC: 'open cluster',
  Cl: 'star cluster', 'Cl*': 'star cluster', PN: 'planetary nebula',
  HII: 'emission nebula', RNe: 'reflection nebula', GNe: 'nebula',
  G: 'galaxy', GiG: 'galaxy', GiP: 'galaxy', GiC: 'galaxy', Sy2: 'galaxy',
  AGN: 'active galaxy', LIN: 'galaxy', SBG: 'galaxy', IG: 'galaxy',
  'As*': 'asterism', PoG: 'galaxy',
}

const query = async (adql, cacheName) => {
  const path = join(CACHE, cacheName)
  if (existsSync(path)) return readFile(path, 'utf8')
  const url = `${TAP}?request=doQuery&lang=adql&format=csv&query=${encodeURIComponent(adql)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SIMBAD ${res.status} ${res.statusText}`)
  const text = await res.text()
  if (text.includes('QUERY_STATUS" value="ERROR"')) {
    throw new Error(`SIMBAD rejected the query:\n${text.slice(0, 400)}`)
  }
  await writeFile(path, text)
  return text
}

const parseCsv = (text) => {
  const lines = text.trim().split('\n')
  const head = lines[0].split(',')
  return lines.slice(1).map((line) => {
    // SIMBAD quotes text fields and never embeds a comma in them.
    const cells = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim())
    return Object.fromEntries(head.map((h, i) => [h.trim(), cells[i] ?? '']))
  })
}

/** "M   1" to "M1". SIMBAD pads the number to a fixed width. */
const normaliseId = (raw) => raw.replace(/\s+/g, '')

const TO_PARSEC = { pc: 1, kpc: 1e3, Mpc: 1e6, ly: 0.3066013937798954, kly: 306.6013937798954 }

const median = (values) => {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

const main = async () => {
  await mkdir(CACHE, { recursive: true })
  await mkdir(OUT, { recursive: true })

  const positions = parseCsv(await query(POSITION_QUERY, 'messier-positions.csv'))
  const distances = parseCsv(await query(DISTANCE_QUERY, 'messier-distances.csv'))

  const byId = new Map()
  for (const row of distances) {
    const id = normaliseId(row.mid)
    const factor = TO_PARSEC[row.unit.trim()]
    const value = Number(row.dist)
    if (factor === undefined || !Number.isFinite(value) || value <= 0) continue
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(value * factor)
  }

  const objects = positions.map((row) => {
    const id = normaliseId(row.mid)
    const measurements = byId.get(id)
    const otype = row.otype.trim()
    const entry = {
      id,
      ra: Number(row.ra),
      dec: Number(row.dec),
      type: TYPE_LABELS[otype] ?? otype.toLowerCase(),
    }
    if (COMMON_NAMES[id] !== undefined) entry.name = COMMON_NAMES[id]
    // Parsecs. Rounded: three significant figures is far better than the
    // underlying agreement between published measurements.
    if (measurements !== undefined && measurements.length > 0) {
      entry.pc = Number(median(measurements).toPrecision(3))
    }
    return entry
  })

  objects.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))

  await writeFile(join(OUT, 'messier.json'), JSON.stringify({
    source: 'SIMBAD (CDS, Strasbourg)',
    frame: 'ICRS, degrees',
    count: objects.length,
    objects,
  }))

  const withDistance = objects.filter((o) => o.pc !== undefined).length
  console.info(`Messier -> public/data/messier.json`)
  console.info(`  objects          ${objects.length}`)
  console.info(`  with a distance  ${withDistance}`)
  console.info(`  with a name      ${objects.filter((o) => o.name !== undefined).length}`)
}

main().catch((err) => {
  console.error(`messier failed: ${err.message}`)
  process.exit(1)
})
