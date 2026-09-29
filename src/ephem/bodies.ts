/**
 * The body table.
 *
 * One descriptor, four shaders. Adding Titan later is a row in this file, not
 * a new class. Radii are IAU values in metres; GM is the standard
 * gravitational parameter in m³/s², used only to give the kinematic orbit a
 * believable period.
 *
 * Axial tilt and rotation phase are not read from here at run time:
 * astronomy-engine's RotationAxis gives both, and it is more accurate. The
 * fields stay for documentation and as a fallback for the Galilean moons,
 * which RotationAxis does not cover.
 */

import { Body } from 'astronomy-engine'

export type ShaderKind = 'EMISSIVE' | 'ROCKY' | 'CLOUDY' | 'GAS_GIANT'

export type EphemSource =
  /** At the origin of the heliocentric frame, by definition. */
  | { kind: 'sun' }
  /** astronomy-engine HelioVector. */
  | { kind: 'helio'; body: Body }
  /** GeoMoon, offset by Earth's heliocentric position. */
  | { kind: 'moon' }
  /** JupiterMoons, offset by Jupiter's heliocentric position. */
  | { kind: 'jovian'; moon: 'io' | 'europa' | 'ganymede' | 'callisto' }

export interface AtmosphereDesc {
  /** Scale height, metres. */
  scaleHeight: number
  /**
   * Vertical optical depth at the surface, per channel, for R G B.
   *
   * This is the whole colour and density model, and it is a measured
   * quantity rather than a tuning knob. Earth's Rayleigh optical depths at
   * 680, 550 and 440 nm are about 0.042, 0.103 and 0.232, and that ratio is
   * why the sky is blue and the setting Sun is red. Mars is dust rather than
   * Rayleigh, so its ordering is reversed. Venus is opaque, so every channel
   * saturates and only the limb shape is left.
   */
  verticalOpticalDepth: [number, number, number]
  /** Thickness of the rendered shell above the surface, metres. */
  shellHeight: number
}

export interface RingDesc {
  /** Inner and outer radius, metres, from the planet centre. */
  inner: number
  outer: number
  /** Texture key. The ring map is a 1-D radial strip with alpha. */
  texture: string
}

export interface BodyTextures {
  albedo?: string
  night?: string
  clouds?: string
  normal?: string
  /** Land-sea mask, so specular lands on water only. */
  specMask?: string
}

export interface BodyDesc {
  id: string
  name: string
  source: EphemSource
  /** Equatorial radius, metres. */
  radiusEq: number
  /** Polar radius, metres. Gas giants are visibly oblate and must not be spheres. */
  radiusPolar: number
  /** Sidereal rotation period, seconds. Negative means retrograde. */
  rotationPeriod: number
  /** Obliquity to its orbit, radians. Documentation only; RotationAxis is authoritative. */
  axialTilt: number
  /** Standard gravitational parameter, m³/s². Drives the kinematic orbit period. */
  gm: number
  /** Geometric albedo. Tints planetshine on the hull. */
  albedo: number
  shader: ShaderKind
  textures: BodyTextures
  atmosphere?: AtmosphereDesc
  rings?: RingDesc
  /** Parent body id, for moons. Used by targeting and the orbit camera. */
  parent?: string
  /** Bodies loaded with the first flight. Everything else streams in on demand. */
  preload?: boolean
}

const deg = (d: number): number => (d * Math.PI) / 180
const hours = (h: number): number => h * 3600
const days = (d: number): number => d * 86400

export const BODIES: readonly BodyDesc[] = [
  {
    id: 'sun',
    name: 'Sun',
    source: { kind: 'sun' },
    radiusEq: 6.957e8, radiusPolar: 6.957e8,
    rotationPeriod: days(25.38), axialTilt: deg(7.25),
    gm: 1.32712440018e20, albedo: 0,
    shader: 'EMISSIVE',
    textures: { albedo: 'sun' },
    preload: true,
  },
  {
    id: 'mercury',
    name: 'Mercury',
    source: { kind: 'helio', body: Body.Mercury },
    radiusEq: 2439700, radiusPolar: 2439700,
    rotationPeriod: days(58.646), axialTilt: deg(0.034),
    gm: 2.2032e13, albedo: 0.142,
    shader: 'ROCKY',
    textures: { albedo: 'mercury' },
  },
  {
    id: 'venus',
    name: 'Venus',
    source: { kind: 'helio', body: Body.Venus },
    radiusEq: 6051800, radiusPolar: 6051800,
    rotationPeriod: days(-243.025), axialTilt: deg(177.36),
    gm: 3.24859e14, albedo: 0.689,
    shader: 'CLOUDY',
    // The surface is never visible, so the cloud deck is the only map needed.
    textures: { albedo: 'venus_atmosphere' },
    // Opaque. Every channel saturates, so what is left is a soft limb and a
    // faintly warm cast from the sulphuric acid haze.
    atmosphere: {
      scaleHeight: 15900,
      verticalOpticalDepth: [24, 27, 30],
      shellHeight: 95000,
    },
  },
  {
    id: 'earth',
    name: 'Earth',
    source: { kind: 'helio', body: Body.Earth },
    radiusEq: 6378137, radiusPolar: 6356752.314245,
    rotationPeriod: hours(23.9344696), axialTilt: deg(23.4392911),
    gm: 3.986004418e14, albedo: 0.434,
    shader: 'CLOUDY',
    textures: {
      albedo: 'earth_daymap',
      night: 'earth_nightmap',
      clouds: 'earth_clouds',
      normal: 'earth_normal',
      specMask: 'earth_specular',
    },
    // The blue limb is the strongest realism cue in the solar system.
    atmosphere: {
      scaleHeight: 8500,
      verticalOpticalDepth: [0.042, 0.103, 0.232],
      shellHeight: 80000,
    },
  },
  {
    id: 'moon',
    name: 'Moon',
    source: { kind: 'moon' },
    parent: 'earth',
    radiusEq: 1738100, radiusPolar: 1736000,
    rotationPeriod: days(27.321661), axialTilt: deg(6.68),
    gm: 4.9048695e12, albedo: 0.136,
    shader: 'ROCKY',
    textures: { albedo: 'moon' },
  },
  {
    id: 'mars',
    name: 'Mars',
    source: { kind: 'helio', body: Body.Mars },
    radiusEq: 3396200, radiusPolar: 3376200,
    rotationPeriod: hours(24.622962), axialTilt: deg(25.19),
    gm: 4.282837e13, albedo: 0.17,
    shader: 'ROCKY',
    textures: { albedo: 'mars', normal: 'mars_normal' },
    // 0.6% of Earth's pressure, but suspended dust still gives a soft
    // butterscotch limb. A hard-edged limb is an instant tell.
    // Dust, not Rayleigh, so the channel ordering is the opposite of Earth's.
    // That is why the Martian sky is tan and the sunset is blue.
    atmosphere: {
      scaleHeight: 11100,
      verticalOpticalDepth: [0.34, 0.26, 0.17],
      shellHeight: 70000,
    },
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    source: { kind: 'helio', body: Body.Jupiter },
    radiusEq: 71492000, radiusPolar: 66854000,
    rotationPeriod: hours(9.925), axialTilt: deg(3.13),
    gm: 1.26686534e17, albedo: 0.538,
    shader: 'GAS_GIANT',
    textures: { albedo: 'jupiter' },
  },
  {
    id: 'io', name: 'Io', source: { kind: 'jovian', moon: 'io' }, parent: 'jupiter',
    radiusEq: 1821600, radiusPolar: 1821600,
    rotationPeriod: days(1.769), axialTilt: 0,
    gm: 5.916e12, albedo: 0.63, shader: 'ROCKY', textures: {},
  },
  {
    id: 'europa', name: 'Europa', source: { kind: 'jovian', moon: 'europa' }, parent: 'jupiter',
    radiusEq: 1560800, radiusPolar: 1560800,
    rotationPeriod: days(3.551), axialTilt: 0,
    gm: 3.2027e12, albedo: 0.67, shader: 'ROCKY', textures: {},
  },
  {
    id: 'ganymede', name: 'Ganymede', source: { kind: 'jovian', moon: 'ganymede' }, parent: 'jupiter',
    radiusEq: 2631200, radiusPolar: 2631200,
    rotationPeriod: days(7.155), axialTilt: 0,
    gm: 9.8878e12, albedo: 0.43, shader: 'ROCKY', textures: {},
  },
  {
    id: 'callisto', name: 'Callisto', source: { kind: 'jovian', moon: 'callisto' }, parent: 'jupiter',
    radiusEq: 2410300, radiusPolar: 2410300,
    rotationPeriod: days(16.689), axialTilt: 0,
    gm: 7.1793e12, albedo: 0.17, shader: 'ROCKY', textures: {},
  },
  {
    id: 'saturn',
    name: 'Saturn',
    source: { kind: 'helio', body: Body.Saturn },
    // 60,268 km equatorial against 54,364 km polar. A round Saturn is wrong.
    radiusEq: 60268000, radiusPolar: 54364000,
    rotationPeriod: hours(10.55), axialTilt: deg(26.73),
    gm: 3.7931187e16, albedo: 0.499,
    shader: 'GAS_GIANT',
    textures: { albedo: 'saturn' },
    rings: { inner: 74500000, outer: 140220000, texture: 'saturn_ring' },
  },
  {
    id: 'uranus',
    name: 'Uranus',
    source: { kind: 'helio', body: Body.Uranus },
    radiusEq: 25559000, radiusPolar: 24973000,
    rotationPeriod: hours(-17.24), axialTilt: deg(97.77),
    gm: 5.793939e15, albedo: 0.488,
    shader: 'GAS_GIANT',
    textures: { albedo: 'uranus' },
  },
  {
    id: 'neptune',
    name: 'Neptune',
    source: { kind: 'helio', body: Body.Neptune },
    radiusEq: 24764000, radiusPolar: 24341000,
    rotationPeriod: hours(16.11), axialTilt: deg(28.32),
    gm: 6.836529e15, albedo: 0.442,
    shader: 'GAS_GIANT',
    textures: { albedo: 'neptune' },
  },
  {
    id: 'pluto',
    name: 'Pluto',
    source: { kind: 'helio', body: Body.Pluto },
    radiusEq: 1188300, radiusPolar: 1188300,
    rotationPeriod: days(-6.387), axialTilt: deg(122.53),
    gm: 8.71e11, albedo: 0.52,
    shader: 'ROCKY',
    textures: {},
  },
]

export const BODY_BY_ID: ReadonlyMap<string, BodyDesc> =
  new Map(BODIES.map((b) => [b.id, b]))

/** Mean radius, used wherever an ellipsoid would be overkill (clamps, influence radius). */
export const meanRadius = (b: BodyDesc): number => (2 * b.radiusEq + b.radiusPolar) / 3
