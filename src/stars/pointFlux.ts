/**
 * Turning an apparent magnitude into a scene luminance.
 *
 * This is the join between the two halves of the light pipeline, and it has to
 * be derived rather than chosen. Surfaces are rendered from albedo and
 * irradiance; point sources are rendered from magnitudes. If the two scales do
 * not agree then a planet is one brightness as a dot and a different
 * brightness as a disc, and it visibly jumps at the handover. The first
 * version used a hand-picked constant and was wrong by a factor of 4,480, so a
 * planet brightened all the way in and then fell off a cliff the moment it
 * resolved.
 *
 * The derivation. A surface with scene value v has radiance v * L_ref, where
 * L_ref = E_0 / pi is the radiance of a fully lit white Lambertian at 1 AU.
 * The flux a sprite delivers is the sum of its pixel values times the solid
 * angle of a pixel. Setting that equal to the irradiance of a source of
 * magnitude m, and using the Sun at 1 AU as the anchor for both scales:
 *
 *     E_m = E_0 * 10^(-0.4 (m - m_sun))
 *     sum(v) * omega_px = E_m / L_ref = pi * 10^(-0.4 (m - m_sun))
 *     luminance = pi * 10^(0.4 m_sun) * 10^(-0.4 m) * pixelsPerRadian^2 / area
 *
 * Two consequences worth stating, because both are easy to mistake for bugs.
 *
 * It depends on resolution. A point spread over a fixed number of pixels
 * covers a larger solid angle in a smaller window, so the same flux is a lower
 * radiance. Without the pixelsPerRadian term the stars would change brightness
 * when the window was resized.
 *
 * It does not depend on the sprite's clamped diameter. The point spread
 * function trades intensity against area to conserve energy, so the effective
 * area at the nominal diameter is the right constant even for a sprite that hit
 * its floor.
 */

/** The Sun's apparent magnitude from 1 AU, which anchors both scales. */
export const SUN_APPARENT_MAGNITUDE = -26.74

/** pi * 10^(0.4 * m_sun). Everything else is geometry. */
export const POINT_FLUX_CONSTANT = Math.PI * 10 ** (0.4 * SUN_APPARENT_MAGNITUDE)

/**
 * Integral of the point spread profile over a unit disc, in units of the
 * sprite's radius squared.
 *
 * The profile is 2^(-4.2 r^2) - 0.055 for r in [0,1], where the subtraction
 * pulls the edge to zero so the quad has no visible boundary. Solved rather
 * than sampled, so it stays exact if the profile is retuned:
 *
 *     integral of 2^(-k r^2) * 2 pi r dr from 0 to 1  =  pi (1 - 2^-k) / (k ln2)
 *     integral of c * 2 pi r dr from 0 to 1           =  pi c
 */
export const PSF_PROFILE_INTEGRAL =
  (Math.PI * (1 - 2 ** -4.2)) / (4.2 * Math.LN2) - 0.055 * Math.PI

/** Effective area of a sprite of the given diameter, in square pixels. */
export const psfEffectiveArea = (diameterPixels: number): number =>
  PSF_PROFILE_INTEGRAL * (diameterPixels / 2) ** 2

/**
 * Scale that converts 10^(-0.4 * magnitude) into a scene luminance.
 *
 * Held as a single uniform so the shader does one multiply, and recomputed
 * whenever the viewport or the sprite size changes.
 *
 * @param pixelsPerRadian   vertical resolution over the vertical field of view.
 * @param psfDiameterPixels the sprite's nominal diameter.
 */
export const fluxToLuminanceScale = (
  pixelsPerRadian: number, psfDiameterPixels: number,
): number => {
  const area = psfEffectiveArea(psfDiameterPixels)
  if (!(area > 0) || !(pixelsPerRadian > 0)) return 0
  return (POINT_FLUX_CONSTANT * pixelsPerRadian * pixelsPerRadian) / area
}

/** Scene luminance of a point source of the given apparent magnitude. */
export const magnitudeToLuminance = (
  magnitude: number, pixelsPerRadian: number, psfDiameterPixels: number,
): number => {
  if (!Number.isFinite(magnitude)) return 0
  return fluxToLuminanceScale(pixelsPerRadian, psfDiameterPixels) * 10 ** (-0.4 * magnitude)
}

/**
 * The faintest star a dark-adapted eye picks out, which is what fixes the
 * exposure in empty space.
 */
export const SKY_LIMIT_MAGNITUDE = 6.5
/**
 * Where that star is placed on the display once the exposure has settled.
 *
 * This is the one genuinely aesthetic number in the light pipeline, and it is
 * here on its own rather than buried in a luminance constant. Raise it and the
 * sky fills in; lower it and deep space goes properly dark. Because it is
 * expressed as a magnitude and a display value, it stays put when the window
 * is resized.
 */
export const SKY_LIMIT_DISPLAY_VALUE = 0.08
