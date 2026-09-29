/**
 * Texture loading.
 *
 * Everything ships as KTX2 with Basis Universal. It cuts the download several
 * times over, and because the format stays compressed in VRAM it also fixes
 * texture memory on low-end GPUs, which is what would otherwise stop this
 * running on a phone.
 *
 * Two things about KTX2Loader in r186 that fail unhelpfully if missed:
 *   - `detectSupport(renderer)` is mandatory; the loader throws without it,
 *     because it has to ask the GPU which compressed formats it takes before
 *     it can pick a transcode target.
 *   - under WebGPU, `renderer.init()` must be awaited first.
 *
 * The transcoder path is set explicitly, and it has to be. KTX2Loader resolves
 * its two transcoder files with `new URL(..., import.meta.url)`, which a Vite
 * production build rewrites correctly but the dev server does not: the loader
 * is served from the optimised dependency cache, so the URL points at
 * /node_modules/.vite/libs/basis/, Vite answers the 404 with index.html, and
 * the browser reports "Uncaught SyntaxError: Unexpected identifier 'html'"
 * without ever mentioning textures. A fixed path behaves the same in both
 * modes. tools/copy-basis.mjs puts the files there, from postinstall.
 *
 * Loading is lazy and per body. The star field, the sky and the cockpit are
 * all that is needed to start flying; a planet's textures are fetched the
 * first time it is targeted. Nobody visits all eight in one session.
 */

import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { LinearSRGBColorSpace, SRGBColorSpace, type Texture, type WebGPURenderer } from 'three/webgpu'

export type TextureTier = 2048 | 4096

export interface TextureManifestEntry {
  tiers: number[]
  kind: 'color' | 'normal' | 'mask' | 'ring' | 'sky'
  /**
   * Mean linear reflectance of the source image, measured at build time.
   *
   * Only present for colour maps. The source textures are photographs and
   * artwork prepared to look right on a screen, not measured reflectance, so
   * decoding them from sRGB gives correct colour but the wrong overall level:
   * Earth's daymap averages 0.219 where the planet's published geometric
   * albedo is 0.434, and the Moon's averages 0.326 where the real figure is
   * 0.136. Shaders divide by this and multiply by the albedo in the body
   * table, so each body's brightness is anchored to a published number
   * instead of to how an artist exported a JPEG.
   */
  meanLinear?: number
  /**
   * Mean linear reflectance per channel, peak-normalised to a hue.
   *
   * Used to colour a body's point-source sprite, at the distances where it is
   * smaller than a pixel and there is no texture to sample.
   */
  meanRgb?: [number, number, number]
  /**
   * Brightest linear value in a sky panorama, measured at build time.
   *
   * Lets the renderer scale the whole map to a real surface brightness instead
   * of a chosen gain, so a different sky map can be substituted without
   * re-tuning anything.
   */
  peakLinear?: number
}

export type TextureManifest = Record<string, TextureManifestEntry>

export interface TextureStore {
  /** Fetch and transcode one texture, or return the cached one. */
  get: (key: string) => Promise<Texture>
  /** True when the key exists in the manifest at all. */
  has: (key: string) => boolean
  /**
   * Scale that turns a colour map into reflectance matching `targetAlbedo`.
   * Returns 1 for an unmeasured or missing texture, which leaves it alone.
   */
  albedoScale: (key: string, targetAlbedo: number) => number
  /** Mean hue of a colour map, or undefined if it was never measured. */
  meanRgb: (key: string) => readonly [number, number, number] | undefined
  /** Brightest linear value in a sky panorama, or undefined. */
  peakLinear: (key: string) => number | undefined
  tier: TextureTier
  dispose: () => void
}

/**
 * @param tier the resolution to prefer. A texture published at fewer
 *             resolutions falls back to its largest.
 */
export const createTextureStore = async (
  renderer: WebGPURenderer,
  tier: TextureTier,
  manifestUrl = '/tex/manifest.json',
): Promise<TextureStore> => {
  const manifest = (await (await fetch(manifestUrl)).json()) as TextureManifest

  const loader = new KTX2Loader()
    // The trailing slash is required: the loader appends the filenames to it.
    .setTranscoderPath('/basis/')
    .detectSupport(renderer)

  // A 4k transcode is not free. Without a limit the loader spawns one worker
  // per hardware thread during the load screen, which is exactly when the main
  // thread can least afford the contention.
  loader.setWorkerLimit(3)

  const cache = new Map<string, Promise<Texture>>()

  const resolveTier = (entry: TextureManifestEntry): number => {
    const available = [...entry.tiers].sort((a, b) => a - b)
    const fit = available.filter((t) => t <= tier).pop()
    return fit ?? available[0] ?? 2048
  }

  const get = (key: string): Promise<Texture> => {
    const cached = cache.get(key)
    if (cached !== undefined) return cached

    const entry = manifest[key]
    if (entry === undefined) {
      return Promise.reject(new Error(`No texture named "${key}" in the manifest`))
    }

    const url = `/tex/${resolveTier(entry)}/${key}.ktx2`
    const promise = loader.loadAsync(url).then((texture) => {
      // Albedo and sky maps are colour and must decode from sRGB. Normal maps,
      // masks and height data are not colour and must stay linear; treating
      // them as sRGB is a subtle, hard-to-see bug that shows up as lighting
      // that is slightly wrong everywhere.
      texture.colorSpace = entry.kind === 'color' || entry.kind === 'sky' || entry.kind === 'ring'
        ? SRGBColorSpace
        : LinearSRGBColorSpace
      texture.name = key
      texture.anisotropy = 8
      return texture
    })

    cache.set(key, promise)
    return promise
  }

  return {
    get,
    has: (key) => manifest[key] !== undefined,
    albedoScale: (key, targetAlbedo) => {
      const mean = manifest[key]?.meanLinear
      if (mean === undefined || mean <= 0 || targetAlbedo <= 0) return 1
      return targetAlbedo / mean
    },
    meanRgb: (key) => {
      const rgb = manifest[key]?.meanRgb
      return rgb === undefined ? undefined : [rgb[0], rgb[1], rgb[2]] as const
    },
    peakLinear: (key) => manifest[key]?.peakLinear,
    tier,
    dispose: () => {
      loader.dispose()
      for (const pending of cache.values()) {
        void pending.then((t) => { t.dispose() }).catch(() => { /* never loaded */ })
      }
      cache.clear()
    },
  }
}
