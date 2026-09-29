/**
 * Star catalogue loading.
 *
 * `stars.bin` is a packed binary built from HYG v4.4 by tools/pack-stars.mjs.
 * It goes straight into GPU buffers with no parse pass: the CSV it came from
 * is 20 MB of text, this is 2.19 MB of records.
 *
 * Record layout, 20 bytes, little-endian:
 *   0  float32 x, y, z   parsecs, J2000 equatorial (EQJ)
 *  12  float32 absmag
 *  16  uint8   r, g, b   linear sRGB, already desaturated
 *  19  uint8   pad
 *
 * Positions stay in parsecs and never become metres. At 1e16 m a star is past
 * the point where metres are a sensible unit, and nothing here needs them: the
 * star field is drawn on a shell around the camera and only the direction and
 * the distance in parsecs matter.
 *
 * These files are CC BY-SA 4.0, inherited from HYG, and carry their own
 * LICENSE next to them. Do not inline them into the source tree.
 */

export const STAR_RECORD_BYTES = 20

export interface StarCatalogue {
  count: number
  /** xyz in parsecs, w is absolute magnitude. Four floats per star. */
  positionMag: Float32Array
  /** Linear sRGB. Three floats per star. */
  colour: Float32Array
}

export interface StarNameEntry {
  /** Index into the catalogue arrays. */
  i: number
  /** Apparent magnitude as catalogued. */
  m: number
  /** Proper name, if it has one. */
  n?: string
  /** Bayer or Flamsteed designation, e.g. "Alp CMa". */
  b?: string
  /** Constellation abbreviation. */
  c?: string
  hip?: number
  hd?: number
}

export interface StarNames {
  version: string
  count: number
  entries: StarNameEntry[]
}

/**
 * Read the packed binary into two GPU-ready arrays.
 *
 * De-interleaving costs one pass over 2 MB and buys a simple attribute layout
 * that behaves identically on the WebGPU and WebGL2 backends. Keeping the
 * mixed float and byte record interleaved would need two views of different
 * types over one buffer, which the node attribute path does not express.
 */
export const decodeStars = (buffer: ArrayBuffer): StarCatalogue => {
  if (buffer.byteLength % STAR_RECORD_BYTES !== 0) {
    throw new Error(
      `stars.bin is ${buffer.byteLength} bytes, not a multiple of ${STAR_RECORD_BYTES}. ` +
      'Rebuild it with `npm run data:stars`.',
    )
  }
  const count = buffer.byteLength / STAR_RECORD_BYTES
  const view = new DataView(buffer)
  const positionMag = new Float32Array(count * 4)
  const colour = new Float32Array(count * 3)

  const INV_255 = 1 / 255
  for (let i = 0; i < count; i++) {
    const o = i * STAR_RECORD_BYTES
    const p = i * 4
    positionMag[p] = view.getFloat32(o, true)
    positionMag[p + 1] = view.getFloat32(o + 4, true)
    positionMag[p + 2] = view.getFloat32(o + 8, true)
    positionMag[p + 3] = view.getFloat32(o + 12, true)
    const c = i * 3
    colour[c] = view.getUint8(o + 16) * INV_255
    colour[c + 1] = view.getUint8(o + 17) * INV_255
    colour[c + 2] = view.getUint8(o + 18) * INV_255
  }

  return { count, positionMag, colour }
}

export const loadStarCatalogue = async (url = '/data/stars/stars.bin'): Promise<StarCatalogue> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load the star catalogue: ${res.status} ${res.statusText}`)
  return decodeStars(await res.arrayBuffer())
}

export const loadStarNames = async (url = '/data/stars/star-names.json'): Promise<StarNames> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load star names: ${res.status} ${res.statusText}`)
  return (await res.json()) as StarNames
}

/**
 * HD and HIP numbers for every star, in catalogue order.
 *
 * Two int32 per star, about 875 KB. Only fetched when someone types a bare
 * catalogue number, which most sessions never do.
 */
export interface StarIdIndex {
  hip: Int32Array
  hd: Int32Array
}

export const loadStarIds = async (url = '/data/stars/star-ids.bin'): Promise<StarIdIndex> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load the star id index: ${res.status} ${res.statusText}`)
  const buffer = await res.arrayBuffer()
  const pairs = new Int32Array(buffer)
  const count = pairs.length / 2
  const hip = new Int32Array(count)
  const hd = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    hip[i] = pairs[i * 2]!
    hd[i] = pairs[i * 2 + 1]!
  }
  return { hip, hd }
}

/** Apparent magnitude of star `i` seen from a point given in parsecs. */
export const apparentMagnitude = (
  cat: StarCatalogue, i: number, camX: number, camY: number, camZ: number,
): number => {
  const p = i * 4
  const d = Math.hypot(cat.positionMag[p]! - camX, cat.positionMag[p + 1]! - camY, cat.positionMag[p + 2]! - camZ)
  // Below about a milliparsec the formula runs away, and nothing is that close.
  return cat.positionMag[p + 3]! + 5 * Math.log10(Math.max(d, 1e-4) / 10)
}
