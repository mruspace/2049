#!/usr/bin/env node
/**
 * Copy the Basis transcoder into public/basis.
 *
 * KTX2Loader resolves its two transcoder files with
 * `new URL('../libs/basis/basis_transcoder.js', import.meta.url)`. In a
 * production build Vite rewrites that to an emitted asset and it works. In dev
 * it does not: the loader is served from Vite's optimised dependency cache, so
 * the URL resolves to /node_modules/.vite/libs/basis/basis_transcoder.js,
 * which does not exist. Vite answers the 404 with index.html, the browser
 * tries to parse HTML as JavaScript, and the only symptom is
 * "Uncaught SyntaxError: Unexpected identifier 'html'" with no mention of
 * textures at all.
 *
 * So the transcoder is served from a fixed path instead, which behaves the
 * same in both modes. The build still emits its own unused copy of these two
 * files; 585 KB of dead assets is worth a loader that works in dev.
 *
 * The loader fetches them by exact filename, so they must not be renamed, and
 * the path it is given must end in a slash.
 *
 * The transcoder is Apache-2.0 (Basis Universal), separate from three.js's
 * MIT. Both are in CREDITS.md.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FROM = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis')
const TO = join(ROOT, 'public', 'basis')

const FILES = ['basis_transcoder.js', 'basis_transcoder.wasm']

const main = async () => {
  await mkdir(TO, { recursive: true })
  for (const file of FILES) {
    await copyFile(join(FROM, file), join(TO, file))
    console.info(`  ${file}`)
  }
  console.info('Basis transcoder copied to public/basis/')
}

main().catch((err) => {
  console.error(`copy-basis failed: ${err.message}`)
  process.exit(1)
})
