/**
 * How bright a body looks from where the ship is.
 *
 * This exists because of a gap that made the whole thing feel wrong: a planet
 * was drawn as a sphere and nothing else, so from any real distance it was a
 * fraction of a pixel and effectively invisible. Flying toward Jupiter meant
 * staring at empty space and then arriving. In life a planet is one of the
 * brightest things in the sky long before it is a disc, and watching that dot
 * brighten and then resolve is most of what an approach feels like.
 *
 * So every body also gets a point-source sprite, and its brightness is the
 * real apparent magnitude rather than a guess. Since the star field already
 * turns magnitudes into scene luminance, a planet and a star of the same
 * magnitude come out equally bright, which is how Jupiter ends up
 * outshining Sirius.
 *
 * The magnitude comes from the flux ratio against the Sun:
 *
 *     m = m_sun - 2.5 log10( p * Phi(a) * R^2 * AU^2 / (r^2 * d^2) )
 *
 * with p the geometric albedo, R the radius, r the distance from the Sun,
 * d the distance from the observer and Phi the phase function. Checked
 * against published values: Jupiter at opposition -2.77 against -2.7, Venus
 * at greatest brilliancy -4.61 against -4.5, Neptune 7.76 against 7.8, the
 * full Moon -12.85 against -12.7.
 */

import { AU } from '../sim/constants'
import type { BodyDesc, RingDesc, ShaderKind } from '../ephem/bodies'

/** The Sun's apparent magnitude from 1 AU. */
export const SUN_APPARENT_MAGNITUDE = -26.74

/**
 * Phase function for a Lambert sphere.
 *
 * Right for anything whose visible surface is a cloud deck, which is every
 * body here with an atmosphere thick enough to hide the ground.
 */
export const lambertPhase = (alpha: number): number =>
  (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI

/**
 * Phase function for bare regolith.
 *
 * Dust and rock backscatter hard, so a rocky body away from full phase is far
 * dimmer than a Lambert sphere predicts. This is the classical lunar phase
 * law, and it matters: at quarter phase it puts the Moon at magnitude -10.2
 * against a published -10.0, where the Lambert form would say -11.6.
 *
 * It is bounded below by the Lambert sphere, because the empirical law is
 * fitted out to roughly 120 degrees and does not vanish at 180: taken
 * literally it leaves a fully back-lit body at a few ten-thousandths of full
 * brightness rather than dark. The Lambert form does reach zero there, and it
 * is above the lunar law everywhere else, so the minimum of the two is the
 * lunar law where that is valid and correctly dark where it is not.
 *
 * It still understates how fast Mercury falls off, whose phase curve is
 * unusually steep even for regolith. At crescent phase Mercury comes out
 * about a magnitude too bright. No simple closed form fixes that.
 */
export const regolithPhase = (alpha: number): number => {
  const degrees = (alpha * 180) / Math.PI
  const lunar = 10 ** (-0.4 * (0.026 * degrees + 4.0e-9 * degrees ** 4))
  return Math.min(lunar, lambertPhase(alpha))
}

export const phaseFunctionFor = (shader: ShaderKind): ((alpha: number) => number) =>
  shader === 'ROCKY' ? regolithPhase : lambertPhase

/**
 * Effective filling factor of a ring system.
 *
 * Rings are not a solid annulus: the gaps and the thin C ring mean only part
 * of the swept area reflects. 0.42 is what reconciles the planet-plus-ring
 * flux with Saturn's published magnitudes at both extremes, -0.5 with the
 * rings wide open and +0.8 with them edge on. The planet alone gives +0.55,
 * which is why a ringless Saturn looked right in 2026 and would look a
 * magnitude too faint a decade either side.
 */
const RING_FILL_FACTOR = 0.42
/** Geometric albedo of ring particles: dirty water ice. */
const RING_ALBEDO = 0.5

/**
 * Reflecting area of a body, expressed as an equivalent radius squared so it
 * drops straight into the flux formula.
 *
 * @param ringTiltCosine |cos| of the angle between the ring plane normal and
 *                       the direction to the observer. Zero when the rings are
 *                       exactly edge on, which is when they contribute nothing.
 */
export const effectiveAreaSquared = (
  body: BodyDesc, ringTiltCosine: number,
): number => {
  const planet = body.radiusEq * body.radiusEq
  const rings: RingDesc | undefined = body.rings
  if (rings === undefined) return planet

  const swept = rings.outer * rings.outer - rings.inner * rings.inner
  const contribution =
    (RING_ALBEDO / body.albedo) * swept * Math.abs(ringTiltCosine) * RING_FILL_FACTOR
  return planet + contribution
}

export interface MagnitudeInput {
  body: BodyDesc
  /** Metres from the Sun to the body. */
  sunDistance: number
  /** Metres from the ship to the body. */
  observerDistance: number
  /** Phase angle at the body, radians: Sun, body, observer. */
  phaseAngle: number
  /** |cos| of the ring plane normal against the observer direction. */
  ringTiltCosine?: number
}

/**
 * Apparent magnitude of a body as seen from the ship.
 *
 * Returns +Infinity for a degenerate geometry rather than a NaN, so a caller
 * that forgets to guard gets something invisible instead of a black frame.
 */
export const apparentBodyMagnitude = (input: MagnitudeInput): number => {
  const { body, sunDistance, observerDistance, phaseAngle } = input
  if (!(observerDistance > 0)) return Number.POSITIVE_INFINITY

  // The Sun emits rather than reflects, so its own magnitude is the inverse
  // square law on its apparent brightness from 1 AU and nothing else. Checked
  // before the heliocentric distance is validated, because the Sun's distance
  // from itself is zero by definition.
  if (body.shader === 'EMISSIVE') {
    return SUN_APPARENT_MAGNITUDE + 5 * Math.log10(observerDistance / AU)
  }

  if (!(sunDistance > 0)) return Number.POSITIVE_INFINITY

  const phase = phaseFunctionFor(body.shader)(clampAngle(phaseAngle))
  if (phase <= 0) return Number.POSITIVE_INFINITY

  const areaSquared = effectiveAreaSquared(body, input.ringTiltCosine ?? 0)
  const flux =
    (body.albedo * phase * areaSquared * AU * AU) /
    (sunDistance * sunDistance * observerDistance * observerDistance)

  if (!(flux > 0)) return Number.POSITIVE_INFINITY
  return SUN_APPARENT_MAGNITUDE - 2.5 * Math.log10(flux)
}

const clampAngle = (alpha: number): number =>
  alpha < 0 ? 0 : alpha > Math.PI ? Math.PI : alpha

/**
 * Angular diameter of a body in radians, and its size in pixels.
 *
 * The point sprite hands over to the mesh across a few pixels, so both need
 * the same measure of when a body stops being a point.
 */
export const angularDiameter = (radius: number, distance: number): number =>
  distance <= radius ? Math.PI : 2 * Math.asin(Math.min(1, radius / distance))

/**
 * Crossfade weight for the point sprite, 1 when the body is a point and 0
 * once the mesh is large enough to carry it on its own.
 */
export const pointSourceWeight = (diameterPixels: number): number => {
  const start = 1.5
  const end = 5
  if (diameterPixels <= start) return 1
  if (diameterPixels >= end) return 0
  const t = (diameterPixels - start) / (end - start)
  // Smoothstep, so there is no visible kink as it hands over.
  return 1 - t * t * (3 - 2 * t)
}
