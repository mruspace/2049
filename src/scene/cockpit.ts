/**
 * The cockpit.
 *
 * Procedural geometry rather than a downloaded model. That saves about 20 MB
 * of the download budget, removes an asset dependency, and means the frame can
 * be adjusted from code instead of from a modelling package. At this level of
 * detail a model would buy nothing: the cockpit exists to give the view a
 * foreground and a sense of sitting inside something.
 *
 * The instruments are emissive at a real luminance, roughly 160 cd/m² against
 * a scene scale where 1.0 is about 40,000 cd/m². So they glow in deep space
 * and wash out completely once auto-exposure adapts to a sunlit planet. That
 * is correct, and it is exactly why the critical readouts live in the
 * screen-space overlay instead of on the panels.
 *
 * Every dimension here is set against one number: the eye sits at the origin
 * and the camera has a 65 degree vertical field of view, so its half-angle is
 * 32.5 degrees. Anything at distance d spans the whole screen once it is about
 * 0.64 * d across. The first version of this file put a 0.92 m canopy arc
 * 0.55 m in front of the eye, which works out at 59 degrees: it filled the
 * view with a white band and hid the solar system behind it. The frame now
 * sits far enough forward that it reads as a windscreen surround rather than
 * as a wall.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  TorusGeometry,
} from 'three/webgpu'
import { float, normalWorld, uniform, vec3 } from 'three/tsl'
import { bounceLight, sunlight, type SurfaceLighting } from './materials/lighting'

/**
 * A 160 cd/m² panel on the scene's photometric scale.
 *
 * This is the brightest the panels ever get, not their fixed value. See
 * PANEL_DISPLAY_TARGET.
 */
export const INSTRUMENT_LUMINANCE = 0.004

/**
 * Where the panels sit on the display once the eye has adapted to the dark.
 *
 * They cannot simply be left at a fixed luminance. Against a magnitude 6.5
 * star at 7e-8 the range to a 160 cd/m² panel is about 57,000 to one, so an
 * exposure that shows the faintest stars renders the panels at four figures:
 * in deep space the instruments were a white glare and the star field was
 * invisible behind it.
 *
 * Real cockpits solve this by dimming the instruments at night, and so does
 * this one. The panels are held at a constant display value as the exposure
 * opens up, and capped at their physical luminance, so they still wash out
 * completely when the eye adapts to a sunlit planet. That was the point of
 * making them emissive in the first place.
 */
export const PANEL_DISPLAY_TARGET = 0.22

/** The panel gain for a given exposure. */
export const instrumentGainFor = (exposure: number, maximum: number): number => {
  if (!(exposure > 0)) return maximum
  return Math.min(maximum, PANEL_DISPLAY_TARGET / exposure)
}

export interface CockpitOptions {
  lighting: SurfaceLighting
  /** The camera's vertical field of view, in degrees. */
  fov: number
}

export interface Cockpit {
  object: Group
  lighting: SurfaceLighting
  /** Current panel luminance, so a rebuild can carry the setting over. */
  readonly instrumentBrightness: number
  setInstrumentBrightness: (value: number) => void
  dispose: () => void
}

export const createCockpit = ({ lighting, fov }: CockpitOptions): Cockpit => {
  const group = new Group()
  group.name = 'cockpit'
  group.matrixAutoUpdate = false

  const disposables: { dispose: () => void }[] = []

  // Hull: lit by the Sun, with planetshine filling the shadowed side. In orbit
  // the bounce from the planet is the difference between a readable frame and
  // a black silhouette.
  //
  // The albedo is low on purpose, and not only for looks. A cockpit surround
  // is painted dark for the same reason a camera hood is: in full sunlight a
  // light-coloured frame is brighter than most of the planet below it, so
  // auto-exposure meters on the frame and the view goes dark. At albedo 0.19
  // it read as a white wall around a correctly exposed Earth.
  const hull = new MeshBasicNodeMaterial({ fog: false })
  const hullAlbedo = vec3(0.075, 0.079, 0.086)
  hull.colorNode = hullAlbedo.mul(sunlight(lighting)).add(hullAlbedo.mul(bounceLight(lighting)))
  disposables.push(hull)

  // A darker, rougher trim so the frame is not one flat tone.
  const trim = new MeshBasicNodeMaterial({ fog: false })
  const trimAlbedo = vec3(0.032, 0.034, 0.037)
  trim.colorNode = trimAlbedo.mul(sunlight(lighting)).add(trimAlbedo.mul(bounceLight(lighting)))
  disposables.push(trim)

  const instrumentGain = uniform(float(INSTRUMENT_LUMINANCE))
  const instrument = new MeshBasicNodeMaterial({ fog: false })
  // Emissive: no dependence on the Sun at all. A slight falloff with viewing
  // angle keeps the panels from reading as flat stickers.
  const facing = normalWorld.dot(vec3(0, 0.35, 0.94).normalize()).abs().mul(0.4).add(0.6)
  instrument.colorNode = vec3(0.35, 0.78, 1.0).mul(instrumentGain).mul(facing)
  disposables.push(instrument)

  const add = (
    geometry: BoxGeometry | CylinderGeometry | TorusGeometry,
    material: MeshBasicNodeMaterial,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ): Mesh => {
    const mesh = new Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.rotation.set(rx, ry, rz)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    group.add(mesh)
    disposables.push(geometry)
    return mesh
  }

  // Layout rule, used for every number below.
  //
  // At a distance d along -Z the visible half-height is tan(fov/2) * d, so
  // anything below that is off the bottom of the screen. An earlier console
  // sat at y = -0.72 and z = -1.05, which is below the edge at that depth:
  // only its far lip was ever visible, and the instrument panels on it never
  // appeared at all.
  //
  // This is derived from the real field of view rather than assuming 65
  // degrees, because a phone held upright gets a much taller frame and the
  // whole cockpit has to move with it.
  const tanHalfFov = Math.tan((fov * Math.PI) / 360)
  const halfHeightAt = (depth: number): number => tanHalfFov * depth

  // Canopy surround: a closed ring, not an arc. A partial torus starts at
  // angle zero and runs anticlockwise, so a 225 degree sweep leaves a gap in
  // an arbitrary place, and on screen that read as a single strut down one
  // side rather than as a windscreen.
  //
  // The ring sits just outside the top and bottom edges of the frame and
  // crosses only the corners, whatever the field of view is.
  const canopyDepth = 1.55
  const canopyRadius = halfHeightAt(canopyDepth) * 1.26
  add(new TorusGeometry(canopyRadius, 0.03, 8, 64), hull, 0, 0.05, -canopyDepth)

  // Two struts from the canopy ring down toward the console, like the
  // A-pillars of a car. They sit in the ring's plane rather than running along
  // the view axis, which matters: a strut pointing away from the eye is
  // foreshortened into a diagonal bar across the middle of the screen, and an
  // earlier version had two of them converging on the planet.
  const strutX = canopyRadius * 0.77
  add(new BoxGeometry(0.03, 1.05, 0.03), hull, -strutX, -0.3, -1.52, 0, 0, -0.34)
  add(new BoxGeometry(0.03, 1.05, 0.03), hull, strutX, -0.3, -1.52, 0, 0, 0.34)

  // Console: a slab below the sightline, pitched toward the pilot. Its top
  // face sits a little above the bottom edge of the frame, so it reads as a
  // band across the lower sixth of the view.
  const consoleDepth = 1.2
  const consolePitch = -0.34
  // Its top face sits a fifth of the way up from the bottom edge, so it reads
  // as a band across the lower part of the view at any aspect ratio.
  const consoleY = -halfHeightAt(consoleDepth) * 0.78
  const consoleWidth = Math.max(1.7, halfHeightAt(consoleDepth) * 2.2)
  add(new BoxGeometry(consoleWidth, 0.06, 0.62), hull, 0, consoleY, -consoleDepth, consolePitch, 0, 0)

  // Coaming along the far lip of the console, which is what reads as
  // "cockpit" rather than "floating instrument".
  add(new BoxGeometry(consoleWidth + 0.04, 0.1, 0.09), trim, 0, consoleY + 0.03, -1.44, -0.16, 0, 0)

  // Instrument panels, sitting on the console's upper face.
  //
  // The offset is along the console's own local +Y, not world +Y, because the
  // console is pitched toward the pilot. Offsetting in world space buried the
  // panels a few millimetres inside the slab, where they were invisible.
  const panelY = consoleY + 0.04 * Math.cos(consolePitch)
  const panelZ = -consoleDepth + 0.04 * Math.sin(consolePitch)
  add(new BoxGeometry(0.42, 0.004, 0.24), instrument, -0.52, panelY, panelZ, consolePitch, 0, 0)
  add(new BoxGeometry(0.5, 0.004, 0.28), instrument, 0, panelY, panelZ, consolePitch, 0, 0)
  add(new BoxGeometry(0.42, 0.004, 0.24), instrument, 0.52, panelY, panelZ, consolePitch, 0, 0)

  // Side consoles, kept short and well out at the edges of peripheral vision.
  // Longer ones read as wings sticking out of the frame rather than as
  // something within reach.
  const sideDepth = 0.95
  const sideY = -halfHeightAt(sideDepth) * 0.82
  const sideX = Math.max(0.72, halfHeightAt(sideDepth) * 1.3)
  add(new BoxGeometry(0.22, 0.05, 0.44), hull, -sideX, sideY, -sideDepth, 0, 0, 0.34)
  add(new BoxGeometry(0.22, 0.05, 0.44), hull, sideX, sideY, -sideDepth, 0, 0, -0.34)
  add(new BoxGeometry(0.13, 0.004, 0.3), instrument, -sideX, sideY + 0.027, -sideDepth, 0, 0, 0.34)
  add(new BoxGeometry(0.13, 0.004, 0.3), instrument, sideX, sideY + 0.027, -sideDepth, 0, 0, -0.34)

  // Throttle grip, on the left where a hand would be.
  add(new CylinderGeometry(0.022, 0.03, 0.12, 10), trim, -sideX * 0.82, sideY + 0.08, -0.9, 0.24, 0, 0.16)

  // Rear bulkhead and floor, so turning the head does not reveal empty space.
  add(new BoxGeometry(2.2, 1.9, 0.06), trim, 0, 0.1, 1.05)
  add(new BoxGeometry(2.0, 0.05, 2.4), trim, 0, -1.2, -0.2)

  group.updateMatrix()

  return {
    object: group,
    lighting,
    get instrumentBrightness() { return instrumentGain.value },
    setInstrumentBrightness: (value) => { instrumentGain.value = value },
    dispose: () => { for (const d of disposables) d.dispose() },
  }
}
