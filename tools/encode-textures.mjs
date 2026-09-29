#!/usr/bin/env node
/**
 * Textures to KTX2 with Basis Universal.
 *
 * KTX2 is the highest-leverage optimisation in the project. It cuts the
 * download several times over, and because the format stays compressed in VRAM
 * it also fixes memory on low-end GPUs. Retrofitting a texture pipeline later
 * is tedious, so this exists from the start.
 *
 * Encoding is `ktx2-encoder`, a WebAssembly build of Basis Universal that
 * installs from npm with no compiler and no platform binary. `toktx` was the
 * obvious choice and is the wrong one now: KTX-Software deprecated the legacy
 * tools in 4.3 and removes them in 4.5, and there is no Homebrew formula for
 * the replacement.
 *
 * Decoding and resizing is ImageMagick, which is a build-time-only
 * prerequisite. `sharp` would have been the pure-npm option, but its installer
 * finds any globally installed libvips and then tries to compile from source,
 * which fails on a machine that has ImageMagick. Since the encoded output is
 * committed, a contributor never runs this, so one documented prerequisite is
 * the better trade.
 *
 * Format choice per kind:
 *   color   ETC1S. Roughly six to eight times smaller, and the difference is
 *           invisible on a planet sphere at any distance you can fly to.
 *   normal  UASTC with Zstd. ETC1S mangles normals: it quantises to a shared
 *           codebook, and a normal map's channels are not perceptual data.
 *   mask    UASTC. A land-sea mask drives specular; ETC1S banding on it shows
 *           up as glinting continents.
 *   ring    UASTC with Zstd. The strip carries its silhouette in alpha, which
 *           ETC1S would destroy.
 *   sky     ETC1S, blurred and small. See the note on the blur below.
 */

import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { encodeToKTX2 } from 'ktx2-encoder'
import { TEXTURES } from './sources.mjs'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'tools', '.cache')
const OUT = join(ROOT, 'public', 'tex')

/**
 * Which resolutions each texture is published at.
 *
 * 4k is the ceiling, and it is a hard one: the Basis WebAssembly encoder
 * refuses anything over about 12.6 megapixels in a single image, and an
 * 8192x4096 equirectangular map is 33.5. Tiling around it would mean a tiled
 * sampler in every planet shader, for detail that does not exist in the source
 * anyway: at 4k, Earth's map is about 9.8 km per pixel, and 8k would be 4.9.
 * Neither resolves anything at low altitude, which is what terrain LOD would
 * be for, and terrain LOD is out of scope.
 *
 * If 8k is ever wanted, the route is the KTX-Software `ktx create` CLI, which
 * has no such limit. The encoded files are committed, so that would be a
 * one-off manual step rather than a new build dependency.
 */
const MAX_TIER = 4096

const tiersFor = (tex) => {
  if (tex.kind === 'sky') return [2048]
  return [2048, 4096].filter((t) => t <= Math.min(tex.res, MAX_TIER))
}

/** Equirectangular maps are 2:1. The ring strip is its own shape. */
const sizeFor = (tex, width) =>
  tex.kind === 'ring'
    // Height padded to a multiple of four for the block encoder. The strip is
    // sampled at a single row, so the vertical stretch is not observable.
    ? [width, Math.max(4, Math.round(width / 16))]
    : [width, width / 2]

/**
 * Decode and resize through ImageMagick, straight to raw RGBA.
 *
 * The sky panorama gets a blur as well, and that blur is the point of it.
 * This texture has real stars baked into the photograph, and they would double
 * up against the 109,000 catalogue sprites drawn on top: two slightly
 * different star fields at once, which reads as a smeared mess. Blurring keeps
 * the diffuse band, which is the only thing the catalogue cannot supply, and
 * removes every point source. It is also why the sky ships at 2k: after the
 * blur there is nothing left to resolve.
 */
const decode = async (file, width, height, blur) => {
  const args = [
    file,
    '-resize', `${width}x${height}!`,
    ...(blur ? ['-blur', `0x${blur}`] : []),
    '-colorspace', 'sRGB',
    '-alpha', 'set',
    '-depth', '8',
    'RGBA:-',
  ]
  const { stdout } = await run('magick', args, {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 512,
  })
  const expected = width * height * 4
  if (stdout.length !== expected) {
    throw new Error(`ImageMagick returned ${stdout.length} bytes, expected ${expected}`)
  }
  return new Uint8Array(stdout)
}

/**
 * Mean linear reflectance of a colour map.
 *
 * This is needed because the source textures are photographs and artwork
 * prepared to look right on a screen, not measured reflectance. Decoding them
 * from sRGB gives correct colour but badly understated brightness: Earth's
 * oceans come out around 0.02 in linear terms when the planet's real geometric
 * albedo is 0.434. Lit by a physically correct Sun, the whole planet then
 * renders darker than the cockpit frame, and auto-exposure faithfully exposes
 * for the frame.
 *
 * So each colour map gets its mean recorded here, and the shader scales it so
 * the mean matches the albedo in the body table. The map keeps its detail and
 * its colour; only its overall level is anchored to a published number. That
 * keeps the same rule as the rest of the light pipeline: nothing is tuned by
 * eye.
 *
 * `-colorspace RGB` is ImageMagick's linear RGB, so the mean is taken in
 * linear light. It has to be computed with `fx:mean` rather than by resizing
 * to one pixel and reading the bytes back: ImageMagick re-encodes raw output
 * into sRGB on the way out, which silently returns the gamma-encoded mean.
 * That read 0.50 for every planet in the solar system, which was the clue.
 *
 * The average is unweighted, so an equirectangular map over-represents the
 * poles. For a planet seen as a disc the error is a few percent, well below
 * the disagreement between published albedo values.
 */
const meanLinearReflectance = async (file) => {
  const { stdout } = await run('magick', [
    file, '-colorspace', 'RGB',
    '-format', '%[fx:mean.r],%[fx:mean.g],%[fx:mean.b]', 'info:',
  ], { maxBuffer: 1 << 16 })

  const channels = stdout.trim().split(',').map(Number)
  if (channels.length !== 3 || channels.some((c) => !Number.isFinite(c))) {
    throw new Error(`could not measure the mean reflectance of ${file}`)
  }
  // Equal channel weighting for the scalar: this is a reflectance, not a
  // luminance. The per-channel means are kept as well, because they are what
  // colours the body's point-source sprite at distances where it is smaller
  // than a pixel and there is no texture to sample.
  const [r, g, b] = channels
  const mean = (r + g + b) / 3
  if (mean <= 0) throw new Error(`${file} has no reflectance`)
  return { mean, rgb: channels }
}

const optionsFor = (kind) => {
  switch (kind) {
    case 'normal':
      return { isUASTC: true, needSupercompression: true, isNormalMap: true, isSetKTX2SRGBTransferFunc: false }
    case 'mask':
      return { isUASTC: true, needSupercompression: true, isSetKTX2SRGBTransferFunc: false }
    case 'ring':
      return { isUASTC: true, needSupercompression: true, isSetKTX2SRGBTransferFunc: true }
    default:
      return {
        isUASTC: false,
        qualityLevel: 210,
        compressionLevel: 2,
        isPerceptual: true,
        isSetKTX2SRGBTransferFunc: true,
      }
  }
}

const main = async () => {
  await mkdir(OUT, { recursive: true })

  try {
    await run('magick', ['-version'])
  } catch {
    console.error(
      'ImageMagick is required to build textures. Install it with `brew install imagemagick`.\n' +
      'The encoded textures are committed, so this is only needed to regenerate them.')
    process.exit(1)
  }

  const manifest = {}
  let totalBytes = 0

  for (const tex of TEXTURES) {
    const source = join(CACHE, tex.file)
    if (!existsSync(source)) {
      throw new Error(`${tex.file} is missing. Run \`npm run data:fetch\` first.`)
    }

    const published = []
    for (const tier of tiersFor(tex)) {
      const [width, height] = sizeFor(tex, tier)
      const dir = join(OUT, String(tier))
      await mkdir(dir, { recursive: true })
      const dest = join(dir, `${tex.key}.ktx2`)

      // Skip an encode whose output is already newer than its input. The
      // manifest is still rewritten, so measurements and tier lists stay
      // current without paying ten minutes to re-encode unchanged art.
      if (existsSync(dest) && statSync(dest).mtimeMs > statSync(source).mtimeMs) {
        const bytes = (await stat(dest)).size
        totalBytes += bytes
        published.push(tier)
        console.info(`  ${tex.key.padEnd(18)} ${String(tier).padStart(5)}  ${width}x${height}  ${(bytes / 1e6).toFixed(2)} MB  (cached)`)
        continue
      }

      const raw = await decode(source, width, height, tex.kind === 'sky' ? 2.5 : 0)

      const ktx2 = await encodeToKTX2(raw, {
        ...optionsFor(tex.kind),
        generateMipmap: true,
        isKTX2File: true,
        // Raw RGBA needs the dimensions handed over; the decoder hook is the
        // supported way to do that in Node.
        imageDecoder: async () => ({ width, height, data: raw }),
      })

      await writeFile(dest, ktx2)
      totalBytes += ktx2.byteLength
      published.push(tier)
      console.info(`  ${tex.key.padEnd(18)} ${String(tier).padStart(5)}  ${width}x${height}  ${(ktx2.byteLength / 1e6).toFixed(2)} MB`)
    }
    const entry = { tiers: published, kind: tex.kind }
    if (tex.kind === 'sky') {
      // The brightest part of the band, so the renderer can scale the whole
      // panorama to a real surface brightness rather than a guessed gain.
      const { stdout } = await run('magick', [
        source, '-colorspace', 'RGB', '-blur', '0x6',
        '-format', '%[fx:maxima]', 'info:',
      ], { maxBuffer: 1 << 16 })
      entry.peakLinear = Number(Number(stdout.trim()).toFixed(5))
    }
    if (tex.kind === 'color') {
      const measured = await meanLinearReflectance(source)
      entry.meanLinear = Number(measured.mean.toFixed(5))
      // Normalised so the brightest channel is 1: this is a hue, and the
      // overall level comes from the body's albedo.
      const peak = Math.max(...measured.rgb)
      entry.meanRgb = measured.rgb.map((c) => Number((c / peak).toFixed(4)))
    }
    manifest[tex.key] = entry
  }

  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.info(`\nTotal ${(totalBytes / 1e6).toFixed(1)} MB across ${Object.keys(manifest).length} textures`)
  console.info(`Manifest written to public/tex/manifest.json`)
}

main().catch((err) => {
  console.error(`encode-textures failed: ${err.message}`)
  process.exit(1)
})
