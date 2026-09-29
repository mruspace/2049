/**
 * The manifest of every upstream file this project builds from.
 *
 * Each entry is pinned by SHA-256. The star catalogue is versioned upstream,
 * but the texture site is a CMS with no versioning or immutability guarantee,
 * so a hash is the only thing standing between a rebuild and silently
 * different art. A hash of null means "record it on first fetch", which is how
 * a new entry is bootstrapped; paste the printed digest back in here.
 */

export const HYG = {
  name: 'hyg_v44.csv.gz',
  url: 'https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz',
  sha256: '00b349893b9a53106dd488d8371e8d2fa586043e500bb3cdb8bff3931682197d',
  bytes: 13636362,
  // CC BY-SA 4.0. The packed output inherits this; see public/data/stars/LICENSE.
  license: 'CC BY-SA 4.0',
}

/**
 * Solar System Scope textures, CC BY 4.0.
 *
 * Two traps here. A HEAD request returns an HTML page with status 200, so
 * these must be fetched with GET. And the site answers 403 to requests that
 * carry a spoofed browser User-Agent or Referer, so send neither.
 *
 * `res` is the highest resolution the site actually publishes for that file.
 * Uranus, Neptune and the Venus cloud deck are 2k or 4k only, so a blanket
 * "8k_" prefix would 404.
 */
export const TEXTURE_BASE = 'https://www.solarsystemscope.com/textures/download'

export const TEXTURES = [
  { key: 'sun', file: '8k_sun.jpg', sha256: 'f22b1cfb306ddce72a7e3b628668a0175b745038ce6268557cb2f7f1bdf98b9d', res: 8192, kind: 'color' },
  { key: 'mercury', file: '8k_mercury.jpg', sha256: '5c8bd885ae3571c6ba2cd34b3446b9c6d767e314bf0ee8c1d5c147cadd388fc3', res: 8192, kind: 'color' },
  { key: 'venus_atmosphere', file: '4k_venus_atmosphere.jpg', sha256: 'a14aeba3c6ad7a56f989bb32008dec548077aeded420495b34df98f2dc14ba91', res: 4096, kind: 'color' },
  { key: 'earth_daymap', file: '8k_earth_daymap.jpg', sha256: '88ab060b6e7d241cfc590c69f528fab2b3247b738d40124cb590999a6fe44abc', res: 8192, kind: 'color' },
  { key: 'earth_nightmap', file: '8k_earth_nightmap.jpg', sha256: '9894e83a585a22c1c425e7ca4f987a9ba625bf08ecee45d3c9dcacae3c2ad5f7', res: 8192, kind: 'color' },
  { key: 'earth_clouds', file: '8k_earth_clouds.jpg', sha256: 'c792eca228989d36ebb45d3ea6ff1198be5e21a25d70d2fbcb2124ffd14ba7f5', res: 8192, kind: 'color' },
  { key: 'earth_normal', file: '8k_earth_normal_map.tif', sha256: '79d6dbbde340c653f435f5a012c026a9bed94bdcfd9714e77885f4cba046635a', res: 8192, kind: 'normal' },
  { key: 'earth_specular', file: '8k_earth_specular_map.tif', sha256: '194e67ef7f14dd50b402a1a6f8c7ed55810e16515b95f7736091951efe8dc3fb', res: 8192, kind: 'mask' },
  { key: 'moon', file: '8k_moon.jpg', sha256: 'd1875bcec83588ca25e4802e576f6bb9f88b39e1e403cb41ff55867419c54796', res: 8192, kind: 'color' },
  { key: 'mars', file: '8k_mars.jpg', sha256: '4cc52149924abc6ae507d63032f994e1d42a55cb82c09e002d1a567ff66c23ee', res: 8192, kind: 'color' },
  { key: 'jupiter', file: '8k_jupiter.jpg', sha256: '0bd844bf20822c4e3e80882b077859833c0dac44c7e4e1e0cd63d1b1b6d43085', res: 8192, kind: 'color' },
  { key: 'saturn', file: '8k_saturn.jpg', sha256: '0d39a4a490c87c3edabe00a3881a29bb3418364178c79c534fe0986e97e09853', res: 8192, kind: 'color' },
  // A 1-D radial strip with alpha, 8192x500. It must not go through the
  // square-mipmap path, and ETC1S would destroy its alpha, so it is UASTC.
  { key: 'saturn_ring', file: '8k_saturn_ring_alpha.png', sha256: 'f1f826933c9ff87d64ecf0518d6256b8ed990b003722794f67e96e3d2b876ae4', res: 8192, kind: 'ring' },
  { key: 'uranus', file: '2k_uranus.jpg', sha256: 'd15239d46f82d3ea13d2b260b5b29b2a382f42f2916dae0694d0387b1204a09d', res: 2048, kind: 'color' },
  { key: 'neptune', file: '2k_neptune.jpg', sha256: 'cb42ea82709741d28b0af44d8b283cbc6dbd0c521a7f0e1e1e010ade00977df6', res: 2048, kind: 'color' },
  { key: 'milkyway', file: '8k_stars_milky_way.jpg', sha256: '1fd005ddd6d53364cc5106e0121b83fd3bca236b1503f6b51f5501d9d51eafaf', res: 8192, kind: 'sky' },
]

/** Resolution tiers shipped for each texture. A device picks one at load time. */
export const TIERS = [
  { name: '2k', size: 2048 },
  { name: '4k', size: 4096 },
  { name: '8k', size: 8192 },
]
