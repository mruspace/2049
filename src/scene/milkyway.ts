/**
 * The Milky Way band.
 *
 * The HYG catalogue contains no diffuse emission, so without this the sky is
 * a scatter of points and deep space looks sparse and wrong.
 *
 * The texture's orientation was determined empirically rather than assumed.
 * Sampling it showed the galactic centre at the image centre, the plane
 * horizontal, and a bright compact off-plane blob at u=0.721. That blob is the
 * Large Magellanic Cloud, which pins both conventions at once:
 *
 *   u = fract(0.5 - l / 360)   galactic longitude increases to the LEFT
 *   v = (b + 90) / 180         v = 0 is the galactic SOUTH pole
 *
 * Checked against the LMC (l 280.5, b -32.9), the SMC (l 302.8, b -44.3) and
 * M31 (l 121.2, b -21.6): all three land on real features, and every
 * alternative convention puts them on empty sky.
 *
 * Its brightness is derived from a real surface brightness rather than picked.
 * That matters more than it sounds: the original hand-set gain of 0.02 was
 * three million times too bright, and once the exposure was pinned to the
 * naked-eye star limit, deep space came out as a blank white screen with the
 * cockpit silhouetted against it.
 */

import {
  BackSide,
  LinearFilter,
  type Mesh,
  MeshBasicNodeMaterial,
  Mesh as ThreeMesh,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three/webgpu'
import { asin, atan, float, positionWorld, texture, uniform, vec2, vec3 } from 'three/tsl'
import { STAR_SHELL_RADIUS } from '../stars/starfield'

/** Just outside the star shell, so stars always draw in front of the band. */
export const SKY_RADIUS = STAR_SHELL_RADIUS * 1.1

/**
 * Rotation from J2000 equatorial (EQJ) to galactic, as three row vectors.
 *
 * Taken from astronomy-engine's Rotation_EQJ_GAL and verified numerically: it
 * sends the galactic centre to (1,0,0) and the galactic north pole to
 * RA 192.859, Dec +27.128, which are the textbook values.
 *
 * Applied as three dot products rather than a mat3, so there is no chance of a
 * row-major against column-major mistake.
 */
const EQJ_TO_GAL_ROW0 = [-0.054862477971134, 0.494109594638876, -0.867666881352902] as const
const EQJ_TO_GAL_ROW1 = [-0.873457278424678, -0.444793811229683, -0.198067787029410] as const
const EQJ_TO_GAL_ROW2 = [-0.483800052994852, 0.747003463163042, 0.455986112447079] as const

const INV_TWO_PI = 1 / (2 * Math.PI)
const INV_PI = 1 / Math.PI

/** The Sun's apparent magnitude from 1 AU, which anchors the photometric scale. */
const SUN_APPARENT_MAGNITUDE = -26.74
/** Solid angle of one square arcsecond, steradians. */
const SQUARE_ARCSECOND = (1 / 206265) ** 2

/**
 * Surface brightness of the bright parts of the band, magnitudes per square
 * arcsecond. The Milky Way runs from about 20.5 through the star clouds to
 * 22 in the darker reaches; this is the value the panorama's peak is scaled
 * to represent.
 */
export const BAND_SURFACE_BRIGHTNESS = 20.5

/**
 * How much brighter than life the band is drawn.
 *
 * Physically it belongs at about 1.7e-8 on the scene scale, which against an
 * exposure pinned to the naked-eye star limit renders at roughly 0.005: very
 * nearly invisible. That is honest and it is also wrong for this product,
 * because a dark-adapted eye integrates the band over a huge area and sees it
 * plainly, and a display cannot reproduce that.
 *
 * So it is lifted, deliberately and by a stated amount, in the same way the
 * enhanced star preset is. The slider in the settings panel moves it.
 */
export const BAND_VISIBILITY = 9

/** Scene luminance for a given surface brightness in magnitudes per square arcsecond. */
export const surfaceBrightnessToLuminance = (magnitudesPerArcsec: number): number =>
  (Math.PI * 10 ** (-0.4 * (magnitudesPerArcsec - SUN_APPARENT_MAGNITUDE))) / SQUARE_ARCSECOND

/**
 * Default gain for a panorama whose brightest pixel is `peakLinear`.
 *
 * Scaling by the measured peak is what lets a different sky map be dropped in
 * without re-tuning anything.
 */
export const defaultSkyGain = (peakLinear: number): number => {
  if (!(peakLinear > 0)) return 0
  return (surfaceBrightnessToLuminance(BAND_SURFACE_BRIGHTNESS) * BAND_VISIBILITY) / peakLinear
}

export interface MilkyWay {
  object: Mesh
  /** Current gain, so the settings panel can start from the derived value. */
  readonly brightness: number
  setBrightness: (value: number) => void
  dispose: () => void
}

/**
 * @param map an equirectangular sky panorama in galactic coordinates.
 *            Mipmaps are disabled on purpose: the longitude wrap makes the
 *            screen-space derivative jump at the seam, which a mipmapped
 *            sample turns into a visible line down the sky. The band is low
 *            frequency, so there is nothing to lose.
 */
export const createMilkyWay = (map: Texture, brightness: number): MilkyWay => {
  map.colorSpace = SRGBColorSpace
  map.wrapS = RepeatWrapping
  map.wrapT = RepeatWrapping
  map.generateMipmaps = false
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.needsUpdate = true

  const gain = uniform(float(brightness))

  // The sphere is centred on the camera, so the world position of a fragment
  // is already the direction to it.
  const dir = positionWorld.normalize()

  const gx = dir.dot(vec3(...EQJ_TO_GAL_ROW0))
  const gy = dir.dot(vec3(...EQJ_TO_GAL_ROW1))
  const gz = dir.dot(vec3(...EQJ_TO_GAL_ROW2))

  const longitude = atan(gy, gx)
  const latitude = asin(gz.clamp(-1, 1))

  const u = float(0.5).sub(longitude.mul(INV_TWO_PI)).fract()
  const v = latitude.mul(INV_PI).add(0.5)

  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  material.colorNode = texture(map, vec2(u, v)).rgb.mul(gain)

  // A coarse sphere is plenty: the shader does the mapping, so the geometry
  // only has to be round enough that the linear interpolation of position
  // does not bend the band. 64x32 is well past that.
  const geometry = new SphereGeometry(SKY_RADIUS, 64, 32)
  const object = new ThreeMesh(geometry, material)
  object.frustumCulled = false
  object.matrixAutoUpdate = false
  object.renderOrder = -200
  object.name = 'milkyway'

  return {
    object,
    get brightness() { return gain.value },
    setBrightness: (value) => { gain.value = value },
    dispose: () => { geometry.dispose(); material.dispose() },
  }
}
