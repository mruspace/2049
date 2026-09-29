/**
 * Device tiers.
 *
 * The same build serves a desktop and a phone, so the expensive choices are
 * made once at start-up from what the device actually reports rather than from
 * a user-agent guess.
 *
 * The star field is full count on every tier. It is one draw call over 109,000
 * instanced quads and it is not the bottleneck anywhere; textures and the post
 * chain are.
 */

export type Tier = 'low' | 'medium' | 'high'

export interface DeviceProfile {
  tier: Tier
  /** Texture resolution to request. */
  textureTier: 2048 | 4096
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number
  /** Temporal antialiasing. The most expensive item in the post chain. */
  taa: boolean
  /** True when the primary input is touch, which changes the whole HUD layout. */
  touch: boolean
  /** Why this tier was chosen, for the diagnostics panel. */
  reason: string
}

export const detectDeviceProfile = (): DeviceProfile => {
  const touch = matchMedia('(pointer: coarse)').matches
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 760
  const cores = navigator.hardwareConcurrency ?? 4
  // Non-standard but widely available, and the only memory signal a browser
  // gives. Absent on Safari, which is why it is one input among several.
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 0

  const reasons: string[] = []
  if (touch) reasons.push('coarse pointer')
  if (narrow) reasons.push('narrow viewport')
  if (cores <= 4) reasons.push(`${cores} cores`)
  if (memory > 0 && memory <= 4) reasons.push(`${memory} GB`)

  let tier: Tier = 'high'
  if (touch || narrow || cores <= 4 || (memory > 0 && memory <= 4)) tier = 'medium'
  if ((touch && cores <= 4) || (memory > 0 && memory <= 3)) tier = 'low'

  const profile: Record<Tier, Omit<DeviceProfile, 'tier' | 'touch' | 'reason'>> = {
    // Full pixel ratio is capped even on desktop: a 4x retina display would
    // otherwise render sixteen times the pixels for no visible gain.
    high: { textureTier: 4096, maxPixelRatio: 2, taa: true },
    medium: { textureTier: 4096, maxPixelRatio: 1.75, taa: true },
    // No temporal antialiasing on the low tier. It needs a second render
    // target for motion vectors, and that memory is better spent on textures.
    low: { textureTier: 2048, maxPixelRatio: 1.5, taa: false },
  }

  return {
    tier,
    touch,
    reason: reasons.length > 0 ? reasons.join(', ') : 'no constraints detected',
    ...profile[tier],
  }
}
