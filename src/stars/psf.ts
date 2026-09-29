/**
 * The point spread function shared by the star field and the body points.
 *
 * Both draw things that are far smaller than a pixel, so both face the same
 * problem and must solve it the same way, or a planet and a star of equal
 * magnitude will not match.
 *
 * Size is a point spread function, not an object size. Every star is smaller
 * than a pixel; what the eye sees is diffraction in the optics. So the sprite
 * is a fixed few pixels across and only brightness varies. Scaling sprite size
 * with brightness gives fat coloured blobs, which is the classic amateur look.
 *
 * The clamp is the part that stops it shimmering. A sub-pixel bright point
 * scintillates badly as the camera rotates and no amount of antialiasing
 * repairs it, so the diameter has a floor and the intensity carries whatever
 * the floor took out of the area. Energy stays proportional to luminance.
 */

import { exp2, float, log2, step, uv } from 'three/tsl'
import type { FloatNode, Vec3Node } from '../scene/materials/nodes'

export interface PsfSettings {
  /** Sprite diameter in CSS pixels at unit brightness. */
  psfPixels: FloatNode
  /** Floor on sprite diameter, which is what kills the scintillation. */
  minPixels: FloatNode
  /** Ceiling, so a very close bright thing cannot fill the screen. */
  maxPixels: FloatNode
  /** Intensity below which a fragment contributes nothing. */
  cullIntensity: FloatNode
}

export interface PsfNodes {
  /** Feed to material.sizeNode. Diameter in CSS pixels. */
  size: FloatNode
  /** Feed to material.colorNode, already multiplied by the tint. */
  colour: Vec3Node
  /** Feed to material.opacityNode. Radial profile, with the cull folded in. */
  opacity: FloatNode
}

/**
 * @param luminance scene-scale brightness of the point.
 * @param tint      its colour, peak-normalised.
 * @param fade      extra multiplier in [0,1], for crossfading a point out as
 *                  it resolves into a disc. Pass float(1) for a star.
 */
export const pointSpread = (
  luminance: FloatNode,
  tint: Vec3Node,
  settings: PsfSettings,
  fade: FloatNode,
): PsfNodes => {
  const { psfPixels, minPixels, maxPixels, cullIntensity } = settings

  // A real point spread function widens slightly with brightness before it
  // saturates. The growth is deliberately weak: this must not turn into
  // size-by-magnitude.
  const ideal = psfPixels.mul(log2(luminance.add(1)).mul(0.11).add(1))
  const diameter = ideal.clamp(minPixels, maxPixels)

  // Energy is intensity times area, so intensity carries whatever the clamp
  // took out of the radius.
  const areaRatio = psfPixels.mul(psfPixels).div(diameter.mul(diameter))
  const intensity = luminance.mul(areaRatio)

  // Radial falloff across the quad, which is what gives the soft core. The
  // subtraction pulls the edge to zero so there is no visible quad boundary.
  const radial = uv().sub(0.5).mul(2).length()
  const falloff = exp2(radial.mul(radial).mul(-4.2)).sub(0.055).max(0)

  return {
    size: diameter,
    colour: tint.mul(intensity),
    // Additive blending multiplies by alpha, so the profile belongs here and
    // the colour node carries the energy. The step term is the fragment-side
    // cull: anything below the floor contributes nothing.
    opacity: falloff.mul(step(intensity, cullIntensity).oneMinus()).mul(fade),
  }
}

/** Turn a settings record of plain numbers into uniforms-compatible nodes. */
export const psfSettingsOf = (
  psfPixels: number, minPixels: number, maxPixels: number, cullIntensity: number,
): PsfSettings => ({
  psfPixels: float(psfPixels),
  minPixels: float(minPixels),
  maxPixels: float(maxPixels),
  cullIntensity: float(cullIntensity),
})
