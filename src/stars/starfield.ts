/**
 * The star field: 109,389 real stars, one draw call.
 *
 * Three decisions carry this file.
 *
 * 1. Instanced sprites, not THREE.Points. WebGPU has no point-size primitive,
 *    and three.js's GLSL fallback hardcodes gl_PointSize to 1, so per-star
 *    size through Points is impossible on either backend. PointsNodeMaterial
 *    on a Sprite gives the same result at four vertices per star, which is
 *    still trivial at this count.
 *
 * 2. Size is a point spread function, not a star size, and the maths for that
 *    lives in ./psf.ts because the body point sprites have to match it exactly.
 *
 * 3. Apparent magnitude is recomputed on the GPU every frame from the camera
 *    position in parsecs. This is what makes the constellations distort as the
 *    ship leaves the solar system, and it is the most valuable single effect
 *    in the product. Nothing is culled on the CPU, because every magnitude
 *    changes as the ship moves; faint stars are discarded in the fragment
 *    shader instead.
 */

import {
  AdditiveBlending, InstancedBufferAttribute, PointsNodeMaterial, Sprite,
} from 'three/webgpu'
import { exp2, float, instancedBufferAttribute, log2, uniform, vec3 } from 'three/tsl'
import { pointSpread, type PsfSettings } from './psf'
import { fluxToLuminanceScale } from './pointFlux'
import type { StarCatalogue } from './catalog'

/**
 * Radius of the shell the sprites sit on, metres.
 *
 * Stars are effectively at infinity, but they still need a depth so that
 * planets occlude them. This sits inside the far plane and outside
 * RENDER_DISTANCE_MAX, so every body is always in front of every star.
 */
export const STAR_SHELL_RADIUS = 8e8

/** log2(10), for turning powers of ten into exp2, which is the cheap one. */
const LOG2_10 = 3.321928094887362

export interface StarFieldSettings {
  /**
   * The brightness curve.
   *
   * 1.0 is physically correct: a magnitude difference of 1 is a factor of
   * 2.512 in luminance. Real magnitudes give a sparse, honest sky, and on a
   * bright screen in a lit room most of it is simply not there.
   *
   * Below 1 the magnitude range is compressed toward `contrastPivot`, which
   * lifts faint stars while leaving the bright ones where they are. It is a
   * contrast control on the sky, not a gain.
   */
  contrast: number
  /**
   * The magnitude the contrast compresses toward, so it does not move.
   *
   * It belongs at the bright end, near the brightest star in the sky. Putting
   * it at the naked-eye limit instead inverts the whole intent: the faint
   * stars then barely move and the bright ones collapse, which took Sirius
   * from 0.33 to 0.024 and made the "enhanced" sky dimmer than the real one.
   */
  contrastPivot: number
  /** Overall multiplier applied after the curve. */
  gain: number
  /** Sprite diameter in CSS pixels at contrast 1. */
  psfPixels: number
  /**
   * Floor on sprite diameter, CSS pixels.
   *
   * A sub-pixel bright point scintillates badly as the camera rotates, and no
   * amount of antialiasing repairs it. Clamping the diameter and lowering
   * intensity to match keeps total energy constant and kills the shimmer.
   */
  minPixels: number
  /** Ceiling on sprite diameter, so a close bright star cannot fill the screen. */
  maxPixels: number
  /** Intensity below which a fragment is discarded. */
  cullIntensity: number
}

/** Physically honest. A sparse sky, which is what the real one looks like. */
export const REALISTIC_STARS: StarFieldSettings = {
  contrast: 1,
  contrastPivot: -1.5,
  gain: 1,
  psfPixels: 2.6,
  minPixels: 1.5,
  maxPixels: 9,
  cullIntensity: 2e-9,
}

/**
 * Compressed magnitude range: more stars visible, bright ones unchanged.
 *
 * This is a deliberate, labelled departure from the data rather than a fudge
 * buried in a constant. The positions, colours and relative order stay exactly
 * as catalogued; only the contrast of the brightness scale moves.
 */
export const ENHANCED_STARS: StarFieldSettings = {
  ...REALISTIC_STARS,
  // The only difference, and deliberately the only one. Sirius is unchanged,
  // magnitude 3 is two and a half times brighter, and the naked-eye limit at
  // 6.5 comes up five-fold.
  //
  // An earlier version also enlarged the sprite, which quietly undid part of
  // the lift: spreading the same energy over a wider point spread function
  // lowers its peak, so the two settings fought each other. This preset is a
  // contrast control and nothing else.
  contrast: 0.78,
}

export interface StarField {
  object: Sprite
  /** Camera position in parsecs, EQJ. Written once per frame. */
  setCameraParsecs: (x: number, y: number, z: number) => void
  /**
   * Tell the field how big a pixel is.
   *
   * The magnitude-to-luminance conversion depends on the solid angle of a
   * pixel, so a resize changes it. Without this the stars would get brighter
   * or dimmer with the window.
   */
  setResolution: (pixelsPerRadian: number) => void
  applySettings: (settings: StarFieldSettings) => void
  dispose: () => void
}

export const createStarField = (
  catalogue: StarCatalogue,
  settings: StarFieldSettings = REALISTIC_STARS,
): StarField => {
  // Updated by setResolution; kept so applySettings can redo the conversion.
  let pixelsPerRadian = 1000
  const cameraPc = uniform(vec3(0, 0, 0))
  // Derived, not chosen: see stars/pointFlux.ts. A hand-picked value here was
  // wrong by a factor of 4,480 against the surface shading scale, which made
  // a planet drop in brightness the moment it stopped being a point.
  const fluxScale = uniform(float(fluxToLuminanceScale(1000, settings.psfPixels)))
  const contrast = uniform(float(settings.contrast))
  const contrastPivot = uniform(float(settings.contrastPivot))
  const gain = uniform(float(settings.gain))
  const psfPx = uniform(float(settings.psfPixels))
  const minPx = uniform(float(settings.minPixels))
  const maxPx = uniform(float(settings.maxPixels))
  const cullIntensity = uniform(float(settings.cullIntensity))

  // xyz in parsecs, w is absolute magnitude.
  //
  // These are wrapped in InstancedBufferAttribute rather than handed over as
  // raw typed arrays, and that is not decoration. In three r186,
  // `instancedBufferAttribute()` only marks mat3 and mat4 attributes as
  // instanced: for a vec3 or vec4 it falls through to a plain
  // BufferAttributeNode and never calls setInstanced, so the data is stepped
  // per vertex instead of per instance. Every sprite then reads the first four
  // stars, one per corner, and 109,000 of them collapse into a single
  // degenerate streak across the sky. BufferAttributeNode does pick up
  // `isInstancedBufferAttribute` from a real attribute object, so passing one
  // is both the fix and the thing that documents itself.
  const data = instancedBufferAttribute<'vec4'>(
    new InstancedBufferAttribute(catalogue.positionMag, 4), 'vec4',
  )
  const tint = instancedBufferAttribute<'vec3'>(
    new InstancedBufferAttribute(catalogue.colour, 3), 'vec3',
  )

  // Camera-relative direction, in parsecs.
  //
  // Crossing the whole solar system moves the camera by about 1.5e-4 pc. That
  // is representable in Float32 against a 100 pc star, and it does shift the
  // star, by about a third of an arcsecond: three orders of magnitude below
  // one pixel. So Sirius does not appear to move when you fly to Mars, and
  // that is the physics rather than a limit of the arithmetic. Over tens of
  // parsecs the same expression is what pulls the constellations apart.
  const offsetPc = data.xyz.sub(cameraPc)
  const distancePc = offsetPc.length().max(1e-4)
  const direction = offsetPc.div(distancePc)

  // m = M + 5 log10(d / 10), with d in parsecs.
  const apparentMag = data.w.add(log2(distancePc.mul(0.1)).mul(5 / LOG2_10))

  // L = 10^(-0.4 * contrast * (m - m_ref)), via exp2 because it is cheaper.
  // contrast = 1 is the real inverse-square magnitude scale.
  // The contrast curve, applied in magnitude space so it pivots about one
  // magnitude and leaves it untouched.
  const curvedMag = contrastPivot.add(apparentMag.sub(contrastPivot).mul(contrast))

  // Magnitude to scene luminance, on the same scale as every lit surface:
  // 1.0 is a fully lit white Lambertian at 1 AU.
  const luminance = exp2(curvedMag.mul(-0.4 * LOG2_10)).mul(fluxScale).mul(gain)

  const psf: PsfSettings = {
    psfPixels: psfPx, minPixels: minPx, maxPixels: maxPx, cullIntensity,
  }
  const sprite = pointSpread(luminance, tint, psf, float(1))

  const material = new PointsNodeMaterial({
    // Constant screen size. Stars are at infinity, so perspective shrinking
    // would be meaningless and would break the point-spread model.
    sizeAttenuation: false,
    transparent: true,
    blending: AdditiveBlending,
    // Depth is tested so bodies occlude stars, but never written, so stars
    // never occlude one another.
    depthWrite: false,
    depthTest: true,
  })

  material.positionNode = direction.mul(STAR_SHELL_RADIUS)
  material.sizeNode = sprite.size
  material.colorNode = sprite.colour
  material.opacityNode = sprite.opacity

  const object = new Sprite(material)
  object.count = catalogue.count
  // The bounding sphere of a shell centred on the camera means nothing.
  object.frustumCulled = false
  object.matrixAutoUpdate = false
  object.renderOrder = -100
  object.name = 'starfield'

  return {
    object,
    setCameraParsecs: (x, y, z) => { cameraPc.value.set(x, y, z) },
    setResolution: (next) => {
      pixelsPerRadian = next
      fluxScale.value = fluxToLuminanceScale(next, psfPx.value)
    },
    applySettings: (next) => {
      contrast.value = next.contrast
      contrastPivot.value = next.contrastPivot
      gain.value = next.gain
      psfPx.value = next.psfPixels
      minPx.value = next.minPixels
      maxPx.value = next.maxPixels
      cullIntensity.value = next.cullIntensity
      // The sprite size feeds the flux conversion, so it has to be redone.
      fluxScale.value = fluxToLuminanceScale(pixelsPerRadian, next.psfPixels)
    },
    dispose: () => { material.dispose(); object.geometry.dispose() },
  }
}
