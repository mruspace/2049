/**
 * Body positions and orientations, recomputed every frame.
 *
 * The design doc called for a 10 Hz cache with interpolation. Measurement says
 * that is not worth the complexity: nine planets plus the Moon plus the four
 * Galilean moons, sharing one AstroTime, costs about 22 microseconds. That is
 * two percent of the 1 ms sim budget at 60 Hz. So this calls straight through
 * every frame.
 *
 * The one thing that does matter is sharing the AstroTime. MakeTime evaluates
 * the delta-T polynomial, and building ten of them per frame costs more than
 * all the position maths together. SimClock.astroTime() caches it.
 *
 * Everything here is heliocentric J2000 mean equator (EQJ), metres. That is
 * already the frame astronomy-engine returns, so nothing is converted.
 */

import {
  type AstroTime,
  Body,
  GeoMoon,
  HelioVector,
  JupiterMoons,
  RotationAxis,
} from 'astronomy-engine'
import { AU } from '../sim/constants'
import type { SimClock } from '../sim/time'
import { copy, sub, scale, vec3, type Vec3 } from '../sim/vec3'
import { BODIES, type BodyDesc } from './bodies'

export interface BodyEphemeris {
  desc: BodyDesc
  /** Heliocentric EQJ, metres. */
  position: Vec3
  /** Position on the previous update, metres. Drives frame carrying. */
  previous: Vec3
  /** Metres per second, finite differenced from the previous update. */
  velocity: Vec3
  /** North pole direction, EQJ unit vector. */
  north: Vec3
  /** Prime meridian angle W, degrees, wrapped into [0, 360). */
  spinDeg: number
  /** False until the first update has run, so `previous` is never garbage. */
  initialised: boolean
}

export class Ephemeris {
  readonly bodies: ReadonlyMap<string, BodyEphemeris>
  private readonly order: BodyEphemeris[]

  constructor(descs: readonly BodyDesc[] = BODIES) {
    const map = new Map<string, BodyEphemeris>()
    for (const desc of descs) {
      map.set(desc.id, {
        desc,
        position: vec3(),
        previous: vec3(),
        velocity: vec3(),
        north: vec3(0, 1, 0),
        spinDeg: 0,
        initialised: false,
      })
    }
    this.bodies = map
    // Parents first, so a moon can read its parent's freshly written position.
    this.order = [...map.values()].sort((a, b) => (a.desc.parent ? 1 : 0) - (b.desc.parent ? 1 : 0))
  }

  get(id: string): BodyEphemeris | undefined { return this.bodies.get(id) }

  /**
   * @param dt seconds of simulated time since the last update, for the velocity
   *           finite difference. Pass 0 on the first call or after a date jump.
   */
  update(clock: SimClock, dt: number): void {
    const t = clock.astroTime()

    for (const entry of this.order) {
      copy(entry.previous, entry.position)
      writePosition(entry, t, this)

      if (entry.initialised && dt > 0) {
        sub(entry.velocity, entry.position, entry.previous)
        scale(entry.velocity, entry.velocity, 1 / dt)
      } else {
        entry.velocity[0] = 0; entry.velocity[1] = 0; entry.velocity[2] = 0
        // First frame: `previous` must equal `position` or the frame carry
        // would teleport the ship by one whole orbit step.
        copy(entry.previous, entry.position)
        entry.initialised = true
      }

      writeOrientation(entry, t)
    }
  }
}

const writePosition = (entry: BodyEphemeris, t: AstroTime, ephem: Ephemeris): void => {
  const src = entry.desc.source
  const p = entry.position

  switch (src.kind) {
    case 'sun':
      p[0] = 0; p[1] = 0; p[2] = 0
      return

    case 'helio': {
      const v = HelioVector(src.body, t)
      p[0] = v.x * AU; p[1] = v.y * AU; p[2] = v.z * AU
      return
    }

    case 'moon': {
      // GeoMoon is geocentric. Offset by Earth, which the sort order has
      // already written this frame.
      const earth = ephem.get('earth')
      const g = GeoMoon(t)
      const ex = earth?.position[0] ?? 0
      const ey = earth?.position[1] ?? 0
      const ez = earth?.position[2] ?? 0
      p[0] = ex + g.x * AU; p[1] = ey + g.y * AU; p[2] = ez + g.z * AU
      return
    }

    case 'jovian': {
      const jupiter = ephem.get('jupiter')
      const moons = jovianCache.read(t)
      const m = moons[src.moon]
      const jx = jupiter?.position[0] ?? 0
      const jy = jupiter?.position[1] ?? 0
      const jz = jupiter?.position[2] ?? 0
      p[0] = jx + m.x * AU; p[1] = jy + m.y * AU; p[2] = jz + m.z * AU
      return
    }
  }
}

/**
 * JupiterMoons returns all four in one call, so calling it per moon would do
 * the same work four times. This keeps the result for the current instant.
 */
const jovianCache = {
  key: Number.NaN,
  value: null as ReturnType<typeof JupiterMoons> | null,
  read(t: AstroTime) {
    if (this.value === null || this.key !== t.tt) {
      this.value = JupiterMoons(t)
      this.key = t.tt
    }
    return this.value
  },
}

const writeOrientation = (entry: BodyEphemeris, t: AstroTime): void => {
  const src = entry.desc.source

  // RotationAxis does not cover the Galilean moons. They are tidally locked,
  // so the scene layer points them at Jupiter instead, which is correct.
  if (src.kind === 'jovian') return

  const body = src.kind === 'sun' ? Body.Sun : src.kind === 'moon' ? Body.Moon
    : src.kind === 'helio' ? src.body : null
  if (body === null) return

  const axis = RotationAxis(body, t)
  entry.north[0] = axis.north.x
  entry.north[1] = axis.north.y
  entry.north[2] = axis.north.z

  // `spin` is the IAU prime-meridian angle W, in degrees and unwrapped: Saturn
  // reads about 7.9e6 degrees today. Wrap it before it reaches a quaternion,
  // and never let it touch a Float32.
  entry.spinDeg = ((axis.spin % 360) + 360) % 360
}
