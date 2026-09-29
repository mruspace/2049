/**
 * The EMISSIVE shader. One body uses it: the Sun.
 *
 * The Sun is never lit, only emits. Two things make it read as real rather
 * than as a white circle:
 *
 * 1. Limb darkening. The photosphere is optically thick, so a line of sight
 *    near the edge of the disc reaches a shallower, cooler layer and comes
 *    back dimmer and redder. Without it the disc is a flat white circle and
 *    reads as fake immediately, at any resolution.
 *
 * 2. Correct angular size. From Mars the Sun is two thirds the width it is
 *    from Earth, and people notice. That falls out of the floating origin and
 *    the distant-body rescale for free; nothing here has to do it.
 *
 * Its radiance is about 46,000 on the scene scale. It is meant to blow out.
 */

import { MeshBasicNodeMaterial, type Texture } from 'three/webgpu'
import { float, mix, normalWorld, texture, uniform, uv, vec3 } from 'three/tsl'
import { SUN_RELATIVE_RADIANCE } from '../../sim/constants'
import { viewDirection } from './lighting'

export interface EmissiveOptions {
  map?: Texture
  /** Multiplier on the physical radiance, for the settings panel. */
  intensity?: number
}

export const createEmissiveMaterial = (options: EmissiveOptions = {}): MeshBasicNodeMaterial => {
  const { map, intensity = 1 } = options
  const gain = uniform(float(SUN_RELATIVE_RADIANCE * intensity))

  const material = new MeshBasicNodeMaterial({ fog: false })

  // cos of the angle between the surface normal and the line of sight. It is
  // 1 at the centre of the disc and 0 at the limb.
  const mu = normalWorld.dot(viewDirection()).max(0)

  // The classic one-parameter limb darkening law. The exponent controls how
  // fast the edge falls away; 0.4 matches the visible photosphere closely
  // enough that the disc gains an obvious three-dimensional roundness.
  const limb = float(0.3).add(mu.pow(0.4).mul(0.7))

  // The edge is also cooler, so it is redder. Small, and it matters.
  const tint = mix(vec3(1.0, 0.72, 0.45), vec3(1.0, 0.98, 0.94), mu.pow(0.5))

  const base = map !== undefined ? texture(map, uv()).rgb : vec3(1, 1, 1)
  material.colorNode = base.mul(tint).mul(limb).mul(gain)

  return material
}
