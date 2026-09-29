/**
 * The ROCKY, CLOUDY and GAS_GIANT shaders.
 *
 * They share a Lambertian core and differ in what they layer on top, so they
 * live together: splitting them would duplicate the lighting three times and
 * let the three copies drift.
 *
 *   ROCKY       Mercury, the Moon, Mars, Pluto, the Galilean moons.
 *               Albedo, an optional normal map, planetshine.
 *   CLOUDY      Venus and Earth. Day and night blended across the terminator,
 *               specular on water only, through a land-sea mask.
 *   GAS_GIANT   Jupiter to Neptune. Latitude-dependent band scrolling, and
 *               visible oblateness, which comes from the mesh, not from here.
 */

import { FrontSide, MeshBasicNodeMaterial, type Texture } from 'three/webgpu'
import { float, normalWorld, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl'
import { bounceLight, sunlight, viewDirection, type SurfaceLighting } from './lighting'
import type { FloatNode } from './nodes'

export interface SurfaceOptions {
  lighting: SurfaceLighting
  albedoMap?: Texture
  /** Fallback colour when no albedo map has loaded yet. */
  baseColour?: [number, number, number]
  /** Published geometric albedo, from the body table. */
  albedo: number
  /**
   * Scale that brings the albedo map's mean up to `albedo`.
   *
   * The source maps are display-tuned images, not reflectance measurements,
   * so their linear means are wrong by factors of two either way. Without
   * this, Earth renders darker than the cockpit frame it is seen through and
   * auto-exposure dutifully exposes for the frame. See TextureStore.
   */
  albedoScale?: number
  /** Tangent-space normal map, if the body has one. */
  normalMap?: Texture
  /** How far the normal map is allowed to tilt the normal. 1 is as authored. */
  normalStrength?: number
}

export interface CloudyOptions extends SurfaceOptions {
  nightMap?: Texture
  /** White where water, black where land. Keeps specular off the continents. */
  specularMask?: Texture
  /**
   * Shadow cast by the cloud deck above, in [0,1], from CloudLayer.
   * Omitted when the body has no cloud layer.
   */
  cloudShadow?: FloatNode
}

export interface GasGiantOptions extends SurfaceOptions {
  /** Radians per second of differential rotation at the equator, relative to the body. */
  bandShear?: number
  /**
   * Shadow cast by the ring system, in [0,1], from Rings.
   * Omitted for a planet with no rings.
   */
  ringShadow?: FloatNode
}

/**
 * The terminator.
 *
 * The geometric shadow line on an airless body is razor sharp, and that is the
 * correct look. A small amount of softening is still needed in the shader,
 * because a hard step on a sphere aliases badly along the day-night line where
 * the normal is nearly perpendicular to the light. This is the smallest value
 * that removes the stair-stepping.
 */
const TERMINATOR_SOFTNESS = 0.035

const albedoOf = (options: SurfaceOptions) => {
  const fallback = options.baseColour ?? [options.albedo, options.albedo, options.albedo]
  if (options.albedoMap === undefined) {
    return vec3(fallback[0], fallback[1], fallback[2])
  }
  return texture(options.albedoMap, uv()).rgb.mul(options.albedoScale ?? 1)
}

export const createRockyMaterial = (options: SurfaceOptions): MeshBasicNodeMaterial => {
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false })
  const albedo = albedoOf(options)
  const lit = surfaceRelief(options).mul(options.lighting.irradiance)
  material.colorNode = albedo.mul(lit).add(albedo.mul(bounceLight(options.lighting)))
  return material
}

/**
 * Lambert term, with a normal map folded in when the body has one.
 *
 * The perturbation is applied directly to the geometric normal rather than
 * through a tangent basis. On a sphere the tangent frame is the local east and
 * north directions, and for an equirectangular map those are exactly the u and
 * v axes, so the shortcut is not an approximation here. It is what lets a
 * 4k Mars read as having relief at all: at that resolution the map is about
 * 10 km per pixel, and without shading from the normals Olympus Mons is a
 * colour change rather than a mountain.
 */
const surfaceRelief = (options: SurfaceOptions): FloatNode => {
  const light = options.lighting
  if (options.normalMap === undefined) {
    return normalWorld.dot(light.sunDirection).max(0)
  }

  // Tangent-space normal, unpacked from [0,1] to [-1,1].
  const packed = texture(options.normalMap, uv()).rgb.mul(2).sub(1)

  // East and north on a sphere, in world space. `up` is the geometric normal.
  const up = normalWorld
  const east = vec3(0, 1, 0).cross(up).normalize()
  const north = up.cross(east)

  const perturbed = east.mul(packed.x.mul(options.normalStrength ?? 1))
    .add(north.mul(packed.y.mul(options.normalStrength ?? 1)))
    .add(up.mul(packed.z))
    .normalize()

  return perturbed.dot(light.sunDirection).max(0)
}

export const createCloudyMaterial = (options: CloudyOptions): MeshBasicNodeMaterial => {
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false })
  const light = options.lighting

  const cosIncidence = normalWorld.dot(light.sunDirection)
  // Relief for the lit term, but the raw geometric normal for the terminator:
  // the day-night blend should follow the planet's shape, not every hill.
  const day = surfaceRelief(options).mul(light.irradiance)

  // Blend to the night map across the terminator rather than switching at
  // exactly zero, which would put a hard seam through every city. smoothstep
  // needs its edges in increasing order, so this is written the way round that
  // is defined, and inverted.
  const nightFactor = smoothstep(-TERMINATOR_SOFTNESS, TERMINATOR_SOFTNESS, cosIncidence).oneMinus()

  const albedo = albedoOf(options)
  // The cloud deck shades the ground beneath it before anything else is added.
  const shaded = options.cloudShadow === undefined ? day : day.mul(options.cloudShadow)
  let colour = albedo.mul(shaded)

  if (options.nightMap !== undefined) {
    // City lights are emissive, so they are not multiplied by irradiance. They
    // are the same brightness on Earth's night side whatever the distance from
    // the Sun, which is the whole reason they are visible at all.
    const lights = texture(options.nightMap, uv()).rgb.mul(0.22)
    colour = colour.add(lights.mul(nightFactor))
  }

  if (options.specularMask !== undefined) {
    // A Blinn-Phong lobe, restricted to water by the mask. The glint off an
    // ocean under a low sun is one of the few specular cues in the solar
    // system that people recognise instantly.
    //
    // The exponent is high because the Sun is small: it subtends about half a
    // degree, so its reflection is a tight bright point, not a soft sheen. An
    // exponent of 80 spreads the lobe over roughly ten degrees, which from
    // orbit reads as a milky smear across a sixth of the ocean.
    const halfway = light.sunDirection.add(viewDirection()).normalize()
    const spec = normalWorld.dot(halfway).max(0).pow(1400)
    const water = texture(options.specularMask, uv()).r
    colour = colour.add(vec3(1, 1, 1).mul(spec).mul(water).mul(light.irradiance).mul(9))
  }

  colour = colour.add(albedo.mul(bounceLight(light)))
  material.colorNode = colour
  return material
}

export const createGasGiantMaterial = (options: GasGiantOptions): MeshBasicNodeMaterial => {
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false })
  const light = options.lighting
  const shear = uniform(float(options.bandShear ?? 0))

  // Bands are a stripe texture scrolled at different rates by latitude. It is
  // cheap and convincing: the visible detail on a gas giant is almost entirely
  // zonal, and differential rotation is what makes it look alive rather than
  // like a painted ball.
  //
  // The profile is symmetric about the equator and falls off toward the poles,
  // which is roughly what the real zonal wind profile does.
  const latitude = uv().y.sub(0.5).mul(2)
  const shearProfile = float(1).sub(latitude.mul(latitude)).max(0)
  const scrolledU = uv().x.add(shear.mul(shearProfile)).fract()

  const albedo = options.albedoMap !== undefined
    ? texture(options.albedoMap, vec2(scrolledU, uv().y)).rgb.mul(options.albedoScale ?? 1)
    : vec3(options.albedo, options.albedo, options.albedo)

  // Rings cast a hard-edged band of shade across the planet. Without it the
  // ring system reads as a decal stuck on the front of the image.
  const lit = sunlight(light)
  const shaded = options.ringShadow === undefined ? lit : lit.mul(options.ringShadow)
  material.colorNode = albedo.mul(shaded).add(albedo.mul(bounceLight(light)))

  // The caller advances this every frame; the material keeps the handle.
  ;(material as unknown as { bandShear: typeof shear }).bandShear = shear
  return material
}

/** Advance a gas giant's band scroll. Safe to call on any material. */
export const advanceBands = (material: MeshBasicNodeMaterial, dtSeconds: number, rate: number): void => {
  const handle = (material as unknown as { bandShear?: { value: number } }).bandShear
  if (handle === undefined) return
  handle.value = (handle.value + rate * dtSeconds) % 1
}
