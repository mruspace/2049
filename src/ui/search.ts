/**
 * Name search.
 *
 * Three sources in one index: the fifteen bodies, the 3,409 catalogue stars
 * that have a proper name, a Bayer or Flamsteed designation, or are naked-eye
 * bright, and the 110 Messier objects.
 *
 * Bare HD and HIP numbers are handled separately. Putting all 109,000 of them
 * in this index would mean shipping a megabyte of JSON for a feature most
 * sessions never touch, so the id index is a packed binary fetched on the
 * first numeric query.
 */

import { BODIES } from '../ephem/bodies'
import { loadStarIds, type StarIdIndex, type StarNames } from '../stars/catalog'

export interface SearchEntry {
  kind: 'body' | 'star' | 'messier'
  /** Body id, catalogue index, or Messier number. */
  key: string
  label: string
  /** Secondary line: designation, constellation, object type. */
  detail: string
  /** Apparent magnitude, where it is known. Used for ranking and display. */
  magnitude?: number
  /** Lower-cased haystack. */
  haystack: string
}

export interface MessierObject {
  id: string
  ra: number
  dec: number
  type: string
  name?: string
  pc?: number
}

export interface MessierFile { objects: MessierObject[] }

export interface SearchIndex {
  entries: SearchEntry[]
  messier: Map<string, MessierObject>
  query: (text: string, limit?: number) => Promise<SearchEntry[]>
}

const CONSTELLATIONS: Record<string, string> = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila',
  Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga', Boo: 'Bootes', Cae: 'Caelum',
  Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major',
  CMi: 'Canis Minor', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia',
  Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus',
  Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis',
  Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux', Cyg: 'Cygnus', Del: 'Delphinus',
  Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax',
  Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra',
  Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor',
  Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra',
  Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma',
  Oct: 'Octans', Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus',
  Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus',
  Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius',
  Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum', Ser: 'Serpens', Sex: 'Sextans',
  Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe',
  Tuc: 'Tucana', UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo',
  Vol: 'Volans', Vul: 'Vulpecula',
}

export const buildSearchIndex = async (starNames: StarNames): Promise<SearchIndex> => {
  const entries: SearchEntry[] = []

  for (const body of BODIES) {
    entries.push({
      kind: 'body',
      key: body.id,
      label: body.name,
      detail: body.parent === undefined ? 'solar system' : `moon of ${body.parent}`,
      haystack: body.name.toLowerCase(),
    })
  }

  for (const star of starNames.entries) {
    const constellation = star.c === undefined ? undefined : CONSTELLATIONS[star.c]
    const bits = [star.b, constellation].filter((b) => b !== undefined)
    // Everything a person might type goes into the haystack: the proper name,
    // the Bayer designation, the constellation abbreviation and its full name,
    // and the catalogue numbers with and without their prefix.
    const haystack = [
      star.n, star.b, star.c, constellation,
      star.hd === undefined ? undefined : `hd ${star.hd}`,
      star.hd === undefined ? undefined : String(star.hd),
      star.hip === undefined ? undefined : `hip ${star.hip}`,
      star.hip === undefined ? undefined : String(star.hip),
    ].filter((b) => b !== undefined).join(' ').toLowerCase()

    entries.push({
      kind: 'star',
      key: String(star.i),
      label: star.n ?? star.b ?? `HD ${star.hd ?? star.hip ?? star.i}`,
      detail: bits.length > 0 ? bits.join(' · ') : 'star',
      magnitude: star.m,
      haystack,
    })
  }

  let messier = new Map<string, MessierObject>()
  try {
    const file = (await (await fetch('/data/messier.json')).json()) as MessierFile
    for (const object of file.objects) {
      messier.set(object.id, object)
      entries.push({
        kind: 'messier',
        key: object.id,
        label: object.name ?? object.id,
        detail: object.name === undefined ? object.type : `${object.id} · ${object.type}`,
        haystack: `${object.id} ${object.name ?? ''} ${object.type}`.toLowerCase(),
      })
    }
  } catch {
    // The Messier catalogue is a nice-to-have. Search still works without it.
    messier = new Map()
  }

  let ids: StarIdIndex | null = null
  let idsPending: Promise<StarIdIndex> | null = null

  /**
   * Resolve a bare catalogue number against the full id index.
   *
   * Only reached when the query looks like `HD 12345`, `HIP 500` or a bare
   * number that matched nothing in the main index, so the 875 KB download
   * happens for the people who actually want it and nobody else.
   */
  const lookupCatalogueNumber = async (text: string): Promise<SearchEntry[]> => {
    const match = /^\s*(hd|hip)?\s*(\d{1,6})\s*$/i.exec(text)
    if (match === null) return []
    const prefix = match[1]?.toLowerCase()
    const number = Number(match[2])

    if (ids === null) {
      idsPending ??= loadStarIds()
      try {
        ids = await idsPending
      } catch {
        return []
      }
    }

    const found: SearchEntry[] = []
    const check = (array: Int32Array, label: string): void => {
      for (let i = 0; i < array.length && found.length < 8; i++) {
        if (array[i] === number) {
          found.push({
            kind: 'star',
            key: String(i),
            label: `${label} ${number}`,
            detail: 'star',
            haystack: '',
          })
        }
      }
    }

    if (prefix === undefined || prefix === 'hd') check(ids.hd, 'HD')
    if (prefix === undefined || prefix === 'hip') check(ids.hip, 'HIP')
    return found
  }

  const query = async (text: string, limit = 40): Promise<SearchEntry[]> => {
    const needle = text.trim().toLowerCase()
    if (needle === '') {
      // An empty box shows the bodies, which is what most people want first.
      return entries.filter((e) => e.kind === 'body').slice(0, limit)
    }

    const scored: { entry: SearchEntry; score: number }[] = []
    for (const entry of entries) {
      const at = entry.haystack.indexOf(needle)
      if (at < 0) continue
      // A prefix match beats a match in the middle; bodies beat stars; a
      // brighter star beats a fainter one. So "mars" finds the planet, and
      // "alp" finds Alpha Centauri before an obscure Alpha Sextantis.
      let score = at === 0 ? 0 : 10 + at
      if (entry.kind === 'body') score -= 6
      if (entry.magnitude !== undefined) score += Math.max(0, entry.magnitude) * 0.35
      scored.push({ entry, score })
    }

    scored.sort((a, b) => a.score - b.score)
    const results = scored.slice(0, limit).map((s) => s.entry)

    if (results.length < 5 && /\d/.test(needle)) {
      const numeric = await lookupCatalogueNumber(needle)
      for (const entry of numeric) {
        if (!results.some((r) => r.kind === 'star' && r.key === entry.key)) results.push(entry)
      }
    }

    return results
  }

  return { entries, messier, query }
}
