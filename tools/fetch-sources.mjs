#!/usr/bin/env node
/**
 * Download every upstream source into tools/.cache and verify its hash.
 *
 * Nothing here is committed. Only the packed and encoded output in public/ is.
 * Run this once, then `npm run data:stars` and `npm run data:textures`.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HYG, TEXTURES, TEXTURE_BASE } from './sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'tools', '.cache')

/**
 * Send no custom headers.
 *
 * Counter-intuitively, spoofing a browser User-Agent and Referer makes the
 * texture site return 403 with an HTML error body. A plain request succeeds.
 * Do not "fix" this by adding a User-Agent back.
 */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const download = async (url, dest, headers) => {
  if (existsSync(dest)) {
    return { buf: await readFile(dest), cached: true }
  }
  // GET, never HEAD: the texture site answers HEAD with an HTML page and a 200.
  const res = await fetch(url, headers ? { headers } : undefined)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return { buf, cached: false }
}

const fetchOne = async (label, url, name, expected, headers) => {
  const dest = join(CACHE, name)
  const { buf, cached } = await download(url, dest, headers)
  const digest = sha256(buf)
  const size = (buf.length / 1e6).toFixed(2)

  if (expected && digest !== expected) {
    throw new Error(
      `${label}: hash mismatch.\n  expected ${expected}\n  got      ${digest}\n` +
      `  The upstream file changed. Check it, then update tools/sources.mjs.`)
  }
  const mark = expected ? 'ok' : `NEW sha256 ${digest}`
  console.info(`  ${label.padEnd(22)} ${size.padStart(8)} MB  ${cached ? 'cached' : 'fetched'}  ${mark}`)
  return buf
}

const main = async () => {
  await mkdir(CACHE, { recursive: true })

  console.info('Star catalogue')
  await fetchOne('HYG v4.4', HYG.url, HYG.name, HYG.sha256)

  console.info('\nTextures (Solar System Scope, CC BY 4.0)')
  const digests = {}
  for (const tex of TEXTURES) {
    const buf = await fetchOne(tex.key, `${TEXTURE_BASE}/${tex.file}`, tex.file, tex.sha256)
    digests[tex.file] = sha256(buf)
  }

  // Emit the digests so a first run can be pinned by pasting them back.
  await writeFile(join(CACHE, 'digests.json'), JSON.stringify(digests, null, 2))
  console.info('\nDigests written to tools/.cache/digests.json')
}

main().catch((err) => {
  console.error(`\nfetch-sources failed: ${err.message}`)
  process.exit(1)
})
