/**
 * Physical constants and unit anchors.
 *
 * Every length in the simulation is metres, every time is seconds, and the
 * frame is J2000 mean equator (EQJ), heliocentric. Nothing here is tuned by
 * eye: the light pipeline depends on these being real values.
 */

/** Astronomical unit, metres. IAU 2012 definition (exact). */
export const AU = 1.495978707e11

/**
 * Parsec, metres.
 *
 * Written as the IAU definition (648000/pi astronomical units) rather than as
 * a decimal literal, which does not survive a round trip through Float64.
 */
export const PARSEC = (AU * 648000) / Math.PI

/** Julian light-year, metres (exact). */
export const LIGHT_YEAR = 9.4607304725808e15

/** Speed of light in vacuum, m/s (exact). */
export const C = 299792458

/** Julian date of the J2000.0 epoch. astronomy-engine counts days from here. */
export const JD_J2000 = 2451545.0

/** Seconds in a Julian day. */
export const SECONDS_PER_DAY = 86400

/** Solar irradiance at 1 AU, W/m². */
export const SOLAR_IRRADIANCE_1AU = 1361

/** Luminance of the solar disc, cd/m². It is meant to blow out. */
export const SUN_DISC_LUMINANCE = 1.6e9

/** Solar photospheric radius, metres. */
export const SUN_RADIUS = 6.957e8

/**
 * Reference apparent magnitude for the star luminance curve.
 * L = 10^(-0.4 * (m - MAG_REFERENCE)).
 */
export const MAG_REFERENCE = 6.5

/** Throttle range, m/s. 1 m/s to 1000 light years per second. */
export const SPEED_MIN = 1
export const SPEED_MAX = 1000 * LIGHT_YEAR

/** Radii multiple inside which the ship attaches to a body's frame and the speed clamp bites. */
export const SPHERE_OF_INFLUENCE_RADII = 100

/** Floor for the near-mass speed clamp, m/s. Below this, manoeuvring gets tedious. */
export const CLAMP_FLOOR_SPEED = 300

/**
 * Bodies past this distance are placed at this distance and scaled down by the
 * same factor, which preserves angular size exactly. Keeps everything inside
 * the far plane without clipping Neptune. See sim/scale.ts.
 */
export const RENDER_DISTANCE_MAX = 1e8

/** Camera depth range, metres. Reverse-Z makes this usable end to end. */
export const NEAR_PLANE = 0.1
export const FAR_PLANE = 1e9

/** Simulation date bounds, as Julian dates (1900-01-01 and 2100-01-01). */
export const JD_MIN = 2415020.5
export const JD_MAX = 2488069.5

/**
 * Photometric scale.
 *
 * Brightness is never tuned by eye here. The dynamic range in space is far too
 * wide for guessed values to survive a camera rotation, so everything is
 * expressed against one reference: the radiance of a perfect white Lambertian
 * surface, fully lit, at 1 AU from the Sun. That reference is 1.0.
 *
 * On that scale:
 *   - a lit planet is albedo * cos(incidence) * (AU/d)^2, so Mars at 1.52 AU
 *     is dimmer than Earth by the inverse square, which is the whole point;
 *   - the solar disc is about 46,000, because its radiance is sigma T^4 / pi
 *     against the reference's E / pi;
 *   - a magnitude 6.5 star is about 2e-4, which is visible once the eye has
 *     adapted to a dark sky and invisible from a sunlit orbit. Both are correct.
 *
 * With real ratios the scene behaves correctly everywhere and needs no
 * per-location tweaking. Auto-exposure does the rest.
 */

/** Stefan-Boltzmann constant, W/m²/K⁴. */
const STEFAN_BOLTZMANN = 5.670374419e-8
/** Solar effective temperature, K. */
const SUN_EFFECTIVE_TEMPERATURE = 5772

/** Radiance of the solar photosphere, relative to a white Lambertian at 1 AU. */
export const SUN_RELATIVE_RADIANCE =
  (STEFAN_BOLTZMANN * SUN_EFFECTIVE_TEMPERATURE ** 4) / SOLAR_IRRADIANCE_1AU

/**
 * Point sources are converted from apparent magnitude to this same scale by
 * stars/pointFlux.ts, which derives the conversion from the Sun rather than
 * choosing it. That file also derives the metering floor, because the floor is
 * what sets the exposure in empty space and it has to track the resolution for
 * the sky to stay the same brightness when the window is resized.
 */
