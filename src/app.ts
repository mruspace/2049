/**
 * The application: start-up and the frame loop.
 *
 * Order within a frame is not arbitrary. The reference-frame carry has to
 * happen after the ephemeris has moved the bodies and before the ship
 * integrates, or a ship parked beside Earth is left behind by 30 km/s. The
 * proximity check has to happen after the carry and before the motion
 * integration, because it is what sets the speed cap.
 */

import { Quaternion, Vector3 } from 'three/webgpu'
import { Ephemeris } from './ephem/ephemeris'
import { BODY_BY_ID, meanRadius } from './ephem/bodies'
import { createRenderer, type RendererBundle } from './render/renderer'
import type { PerspectiveCamera } from 'three/webgpu'
import { createPostChain, DEFAULT_POST, type DebugView, type PostChain } from './render/postfx'
import { createTextureStore, type TextureStore } from './render/textures'
import { detectDeviceProfile, type DeviceProfile } from './render/deviceTier'
import { createWorld, type World } from './scene/world'
import { instrumentGainFor } from './scene/cockpit'
import { pick } from './scene/picking'
import { AU } from './sim/constants'
import {
  alignToward, integrateLook, integrateMotion, integrateRotation, integrateThrottle,
} from './sim/flight'
import { carryWithFrame, createProximityState, updateProximity } from './sim/frames'
import { createShipState, type ShipState } from './sim/state'
import { clampSpeedForApproach, clampSpeedNearMass } from './sim/throttle'
import { SimClock } from './sim/time'
import {
  BEARING_DEAD_ZONE, bodyTarget, readTarget, refreshTarget, screenBearing,
  starTarget, type Target, type TargetReadout,
} from './sim/targeting'
import { loadStarNames, type StarNames } from './stars/catalog'
import { ENHANCED_STARS, REALISTIC_STARS } from './stars/starfield'
import { createControls, touchRollState, type Controls } from './input/controls'
import { createLiveHud, type LiveHud } from './ui/live/hud'
import { createStore, type Store } from './ui/store'

export interface App {
  store: Store
  profile: DeviceProfile
  world: World
  starNames: StarNames
  /** Live ship state. Exposed for debugging from the console, not for the UI. */
  ship: ShipState
  /** Live simulation clock, same caveat. */
  clock: SimClock
  /** Live body positions, same caveat. */
  ephemeris: Ephemeris
  /** The camera, for projecting a scene position in a console or a test. */
  camera: PerspectiveCamera
  /**
   * Put the ship a given multiple of a body's radius away, pointed at it.
   *
   * Exists for checking a body without flying there, which matters because
   * several of them are hours away at sane speeds. Also what the tests and the
   * screenshot tooling use.
   */
  goTo: (bodyId: string, radii?: number) => boolean
  /** Point the ship at a target and select it. */
  setTarget: (target: Target | null) => void
  /** Build a target for a catalogue star index. */
  starTargetFor: (index: number) => Target | null
  /** Build a target for a body id, loading it if needed. */
  bodyTargetFor: (id: string) => Target | null
  /** Jump the simulation date. */
  setJulianDate: (jd: number) => void
  /** Place the ship in a circular kinematic orbit around the nearest body. */
  matchOrbit: () => void
  applyStarPreset: (preset: 'realistic' | 'enhanced') => void
  setMilkyWayBrightness: (value: number) => void
  setInstrumentBrightness: (value: number) => void
  setMouseSensitivity: (value: number) => void
  dispose: () => void
}

/**
 * How close counts as arrived, in multiples of the body's radius above its
 * surface. Roughly where the body fills the view.
 */
const ARRIVAL_RADII = 1.5

/**
 * Where the ship starts, as a multiple of Earth's radius from its centre.
 *
 * 4.2 radii puts Earth about 28 degrees across, so it fills a good part of the
 * opening view and is obviously a world rather than a dot. The first attempt
 * used 900 radii, where Earth subtends 0.13 degrees: at 1440 pixels across a
 * 65 degree view that is a two-pixel speck, and the opening shot was an empty
 * black screen.
 */
const START_ALTITUDE_RADII = 4.2

export const startApp = async (
  canvas: HTMLCanvasElement,
  overlay: HTMLElement,
  onPhase: (phase: Store['phase'], message: string) => void,
): Promise<App> => {
  const profile = detectDeviceProfile()

  const store = createStore({
    stars: REALISTIC_STARS,
    starPreset: 'realistic',
    // Replaced once the sky panorama's measured peak is known.
    milkyWayBrightness: 0,
    instrumentBrightness: 0.004,
    mouseSensitivity: 0.55,
    alignToTarget: true,
    taa: profile.taa,
    reverseZ: true,
    showDiagnostics: false,
  })

  onPhase('loading', 'starting the renderer')
  let bundle: RendererBundle
  try {
    bundle = await createRenderer({
      canvas,
      reverseZ: store.settings.reverseZ,
      maxPixelRatio: profile.maxPixelRatio,
      forceWebGL: new URLSearchParams(location.search).has('webgl'),
    })
  } catch (err) {
    onPhase('failed', describeRendererFailure(err))
    throw err
  }

  store.backend = bundle.backend
  store.reverseZActive = bundle.reverseZActive

  onPhase('loading', 'loading textures')
  let textures: TextureStore
  try {
    textures = await createTextureStore(bundle.renderer, profile.textureTier)
  } catch (err) {
    onPhase('failed',
      'The texture manifest could not be loaded. Run `npm run data` to build the assets.')
    throw err
  }

  onPhase('loading', 'loading 109,000 stars')
  const [world, starNames] = await Promise.all([
    createWorld(bundle.renderer, textures, bundle.camera.fov, store.settings.stars),
    loadStarNames(),
  ])

  store.settings.milkyWayBrightness = world.milkyWay.brightness

  onPhase('loading', 'building the post chain')
  const debug = (new URLSearchParams(location.search).get('debug') ?? 'none') as DebugView
  const post: PostChain = createPostChain(
    bundle.renderer, world.scene, world.starScene, bundle.camera,
    { ...DEFAULT_POST, taa: profile.taa, debug },
  )

  const ship = createShipState()
  const clock = new SimClock()
  const ephem = new Ephemeris()
  const proximity = createProximityState()

  // One warm-up pass so the first frame has real positions and the reference
  // frame carry has a valid previous position to difference against.
  ephem.update(clock, 0)
  placeShipAtEarth(ship, ephem)

  let target: Target | null = null
  let readout: TargetReadout | undefined

  const setTarget = (next: Target | null): void => {
    target = next
    store.live.target = next
    if (next !== null && next.kind === 'body') world.ensureBody(next.id)
    store.notify()
  }

  const bodyTargetFor = (id: string): Target | null => {
    const desc = BODY_BY_ID.get(id)
    if (desc === undefined) return null
    const detail = desc.parent === undefined
      ? describeShader(desc.shader)
      : `moon of ${BODY_BY_ID.get(desc.parent)?.name ?? desc.parent}`
    const built = bodyTarget(id, desc.name, detail, meanRadius(desc))
    const entry = ephem.get(id)
    if (entry !== undefined) refreshTarget(built, entry.position)
    return built
  }

  const starTargetFor = (index: number): Target | null => {
    if (index < 0 || index >= world.catalogue.count) return null
    const p = index * 4
    const pc = Float64Array.of(
      world.catalogue.positionMag[p]!,
      world.catalogue.positionMag[p + 1]!,
      world.catalogue.positionMag[p + 2]!,
    )
    const named = starNames.entries.find((entry) => entry.i === index)
    const name = named?.n ?? named?.b ?? `HYG ${index}`
    const parsecs = Math.hypot(pc[0]!, pc[1]!, pc[2]!)
    return starTarget(index, name, `star, ${parsecs.toFixed(1)} pc from the Sun`, pc)
  }

  const controls: Controls = createControls({
    element: canvas,
    sensitivity: store.settings.mouseSensitivity,
    onPick: (x, y) => {
      const hit = pick(x, y, canvas, bundle.camera, world.visuals.values(), world.catalogue, ship.position)
      if (hit === null) return
      setTarget(hit.kind === 'body' ? bodyTargetFor(hit.id) : starTargetFor(Number(hit.id)))
    },
    onMatchOrbit: () => { matchOrbit() },
    /**
     * Full throttle, in one key.
     *
     * Safe by construction: the approach clamp caps the speed at the distance
     * remaining divided by two seconds, so opening up all the way cannot
     * overshoot anything ahead. That makes full throttle the right setting for
     * essentially every journey, and asking the player to find it by holding a
     * key down a logarithmic scale was asking them to guess.
     */
    onCruise: () => {
      ship.throttle = 1
      ship.mode = 'free'
    },
    onSearch: () => { overlay.dispatchEvent(new CustomEvent('mru:search')) },
  })

  const hud: LiveHud = createLiveHud(overlay, store)

  /**
   * Circular kinematic orbit, no gravity solver.
   *
   * The period comes from the body's real GM, so low Earth orbit takes about
   * ninety minutes. That is the only part of this that needs to be true;
   * orbital mechanics as a puzzle is an explicit non-goal.
   */
  const matchOrbit = (): void => {
    const id = proximity.nearestId
    if (id === null) return
    const entry = ephem.get(id)
    const desc = BODY_BY_ID.get(id)
    if (entry === undefined || desc === undefined) return

    const radius = proximity.distanceToCentre
    if (radius > meanRadius(desc) * 60) return

    // Velocity perpendicular to the radius, in the plane containing the
    // current nose direction, so the orbit continues the way the ship is
    // already pointing.
    const rx = ship.position[0]! - entry.position[0]!
    const ry = ship.position[1]! - entry.position[1]!
    const rz = ship.position[2]! - entry.position[2]!
    const rLen = Math.hypot(rx, ry, rz) || 1

    const nose = new Vector3(0, 0, -1).applyQuaternion(
      new Quaternion(ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!),
    )
    // Remove the radial component: what is left is the tangential heading.
    const radial = new Vector3(rx / rLen, ry / rLen, rz / rLen)
    const tangential = nose.clone().addScaledVector(radial, -nose.dot(radial))
    if (tangential.lengthSq() < 1e-12) tangential.set(-radial.y, radial.x, 0)
    tangential.normalize()

    const speed = Math.sqrt(desc.gm / rLen)
    ship.velocity[0] = tangential.x * speed + entry.velocity[0]!
    ship.velocity[1] = tangential.y * speed + entry.velocity[1]!
    ship.velocity[2] = tangential.z * speed + entry.velocity[2]!
    ship.mode = 'orbit'
    ship.throttle = 0
    ship.speed = 0
    store.notify()
  }

  // ---------- the frame loop ----------

  const cameraQuaternion = new Quaternion()
  const lookQuaternion = new Quaternion()
  const yawAxis = new Vector3(0, 1, 0)
  const pitchAxis = new Vector3(1, 0, 0)
  const targetScreen = new Vector3()

  let previous = performance.now()
  let running = true

  const frame = (now: number): void => {
    if (!running) return
    // Clamped: a tab returning from the background must not integrate a
    // ten-second step at a thousand light years per second.
    const dt = Math.min(0.1, Math.max(0, (now - previous) / 1000))
    previous = now

    const input = controls.sample()
    input.roll += (touchRollState.left ? 1 : 0) - (touchRollState.right ? 1 : 0)

    clock.advance(dt)
    ephem.update(clock, dt * clock.rate)

    // Must run before the ship integrates, and after the bodies have moved.
    carryWithFrame(ship, ephem, proximity)

    integrateRotation(ship, input, dt)
    integrateThrottle(ship, input, dt)
    integrateLook(ship, input, dt)

    // Settle onto the target when the pilot is not steering. Aim, not speed,
    // is what decides whether an arrival happens: one degree off at 1.75 AU
    // misses Mars by 4.6 million kilometres.
    if (store.settings.alignToTarget && target !== null && readout !== undefined) {
      alignToward(ship, input, readout.direction, dt)
    }

    updateProximity(ship, ephem, proximity, target?.kind === 'body' ? target.id : null)
    // Two caps, and the tighter one wins. The near-mass clamp handles being
    // beside something; the approach clamp handles flying at it from any
    // distance, which is what makes an arrival watchable.
    const nearCap = clampSpeedNearMass(
      proximity.distanceToSurface, proximity.withinInfluence, proximity.receding,
    )
    const approachCap = clampSpeedForApproach(proximity.approachGap)
    const cap = Math.min(nearCap, approachCap)
    // Which of the two is actually binding, so the HUD can name it. Climbing
    // away from Earth it is Earth, even though the ship is pointed at Jupiter.
    const limitingId = nearCap <= approachCap ? proximity.nearestId : proximity.approachId

    // Arriving.
    //
    // The approach is exponential, so it never quite reaches zero: left alone
    // the ship creeps in at the manoeuvring floor, drifts through the planet,
    // finds itself receding and accelerates away again. Cutting the throttle
    // on arrival is what closes the loop the product is built around: look,
    // pick, travel, arrive.
    if (
      ship.throttle > 0 &&
      target !== null && target.kind === 'body' &&
      proximity.targetGap < (target.radius ?? 0) * ARRIVAL_RADII
    ) {
      ship.throttle = 0
      store.live.arrivedAt = target.name
      store.notify()
    } else if (ship.throttle > 0) {
      store.live.arrivedAt = ''
    }

    if (ship.throttle > 0 || input.fullStop) ship.mode = 'free'
    if (ship.mode === 'orbit') {
      // Coast on the stored velocity. The carry above already moved the ship
      // with the body, so this is the orbital motion on top of it.
      ship.position[0] = ship.position[0]! + ship.velocity[0]! * dt
      ship.position[1] = ship.position[1]! + ship.velocity[1]! * dt
      ship.position[2] = ship.position[2]! + ship.velocity[2]! * dt
      turnOrbitVelocity(ship, ephem, proximity, dt)
    } else {
      integrateMotion(ship, dt, cap)
    }

    // Camera: the ship's attitude, then the free-look offset on top. Free look
    // never steers, so it is applied after and never written back.
    cameraQuaternion.set(
      ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
    )
    lookQuaternion.setFromAxisAngle(yawAxis, ship.lookYaw)
    cameraQuaternion.multiply(lookQuaternion)
    lookQuaternion.setFromAxisAngle(pitchAxis, ship.lookPitch)
    cameraQuaternion.multiply(lookQuaternion)
    bundle.camera.quaternion.copy(cameraQuaternion)
    bundle.camera.updateMatrixWorld()

    // Pixels per radian, which is what decides when a body stops being a
    // point and starts being a disc.
    world.update(ship, ephem, dt, pixelsPerRadian())

    // Target bookkeeping.
    if (target !== null) {
      if (target.kind === 'body') refreshTarget(target, ephem.get(target.id)?.position)
      readout = readTarget(target, ship.position, Math.max(ship.speed, speedOf(ship)), readout)
      store.live.targetDistance = readout.distance
      store.live.targetSurfaceDistance = readout.surfaceDistance
      store.live.targetEta = readout.eta

      // Where the target sits relative to the view. Two separate answers, and
      // they must not come from the same place: the marker wants the projected
      // position, which is only meaningful in front of the camera, and the
      // arrow wants a bearing that survives the target being behind. See
      // screenBearing.
      const bearing = screenBearing(readout.direction, cameraQuaternion)
      // Dead ahead and dead behind have no bearing, so hold the last usable
      // one rather than letting the arrow flick as the ship swings through.
      if (bearing.lateral > BEARING_DEAD_ZONE) store.live.targetAngle = bearing.angle

      const inFront = bearing.inFront
      if (inFront) {
        targetScreen.set(readout.direction[0]!, readout.direction[1]!, readout.direction[2]!)
        targetScreen.project(bundle.camera)
        store.live.targetScreenX = targetScreen.x
        store.live.targetScreenY = targetScreen.y
      }
      store.live.targetOnScreen =
        inFront && Math.abs(targetScreen.x) <= 1 && Math.abs(targetScreen.y) <= 1
    }

    const live = store.live
    live.speed = ship.mode === 'orbit' ? speedOf(ship) : ship.speed
    live.throttle = ship.throttle
    live.clamped = ship.requestedSpeed > cap * 1.0001 && ship.mode !== 'orbit'
    live.attachedTo = ship.attachedTo
    live.nearestSurface = proximity.distanceToSurface
    live.nearestName = proximity.nearestId === null
      ? ''
      : BODY_BY_ID.get(proximity.nearestId)?.name ?? ''
    // Whatever is actually holding the speed down, which is what the player
    // needs told, and not always the body being flown at.
    live.limitingName = limitingId === null
      ? ''
      : BODY_BY_ID.get(limitingId)?.name ?? ''
    live.julianDate = clock.julianDate
    live.dateText = formatSimDate(clock)
    live.exposure = post.exposure.exposure
    live.averageLuminance = post.exposure.averageLuminance

    // Dim the instruments as the eye adapts, the way a crew would. Capped at
    // their physical luminance, so they still wash out against a lit planet.
    world.cockpit.setInstrumentBrightness(
      instrumentGainFor(post.exposure.exposure, store.settings.instrumentBrightness),
    )

    post.update(dt)
    post.render()
    hud.update(now)

    requestAnimationFrame(frame)
  }

  const pixelsPerRadian = (): number =>
    window.innerHeight / ((bundle.camera.fov * Math.PI) / 180)

  const resize = (): void => {
    bundle.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio)
    post.setSize(window.innerWidth, window.innerHeight)
    // The field of view follows the aspect ratio, and the cockpit is built
    // from the field of view, so it has to follow too.
    world.setFieldOfView(bundle.camera.fov)
    // A point source's luminance depends on the solid angle of a pixel, so
    // both the star field and the dark-adapted exposure move with the window.
    const scale = pixelsPerRadian()
    world.starField.setResolution(scale)
    post.setResolution(scale)
  }
  resize()
  window.addEventListener('resize', resize)

  onPhase('ready', '')
  // The loading screen has gone by now, so anything still over the canvas is
  // a real problem. The mouse is the flight stick, so a covered canvas means
  // the ship cannot be steered at all, silently.
  controls.checkReachable()
  requestAnimationFrame((now) => { previous = now; frame(now) })

  return {
    store,
    profile,
    world,
    starNames,
    ship,
    clock,
    ephemeris: ephem,
    camera: bundle.camera,
    goTo: (bodyId, radii = 5) => {
      const entry = ephem.get(bodyId)
      const desc = BODY_BY_ID.get(bodyId)
      if (entry === undefined || desc === undefined) return false
      world.ensureBody(bodyId)

      const offset = meanRadius(desc) * radii
      // Stand off toward the Sun so the body is lit, and above the body's own
      // equator so a ring system is seen at an angle rather than edge on.
      const toSun = new Vector3(
        -entry.position[0]!, -entry.position[1]!, -entry.position[2]!,
      ).normalize()
      const north = new Vector3(entry.north[0]!, entry.north[1]!, entry.north[2]!).normalize()
      const direction = toSun.clone().addScaledVector(north, 0.55).normalize()

      ship.position[0] = entry.position[0]! + direction.x * offset
      ship.position[1] = entry.position[1]! + direction.y * offset
      ship.position[2] = entry.position[2]! + direction.z * offset
      ship.velocity[0] = 0; ship.velocity[1] = 0; ship.velocity[2] = 0
      ship.throttle = 0
      ship.speed = 0
      ship.mode = 'free'

      const look = new Quaternion().setFromUnitVectors(
        new Vector3(0, 0, -1), direction.clone().negate(),
      )
      ship.orientation[0] = look.x
      ship.orientation[1] = look.y
      ship.orientation[2] = look.z
      ship.orientation[3] = look.w

      setTarget(bodyTargetFor(bodyId))
      return true
    },
    setTarget,
    starTargetFor,
    bodyTargetFor,
    setJulianDate: (jd) => {
      clock.setJulianDate(jd)
      // Positions jump, so the velocity finite difference must be discarded
      // rather than differenced across the jump.
      ephem.update(clock, 0)
      store.notify()
    },
    matchOrbit,
    applyStarPreset: (preset) => {
      const settings = preset === 'enhanced' ? ENHANCED_STARS : REALISTIC_STARS
      store.settings.stars = settings
      store.settings.starPreset = preset
      world.applyStarSettings(settings)
      store.notify()
    },
    setMilkyWayBrightness: (value) => {
      store.settings.milkyWayBrightness = value
      world.milkyWay.setBrightness(value)
      store.notify()
    },
    setInstrumentBrightness: (value) => {
      store.settings.instrumentBrightness = value
      world.cockpit.setInstrumentBrightness(value)
      store.notify()
    },
    setMouseSensitivity: (value) => {
      store.settings.mouseSensitivity = value
      controls.setSensitivity(value)
      store.notify()
    },
    dispose: () => {
      running = false
      window.removeEventListener('resize', resize)
      controls.dispose()
      hud.dispose()
      post.dispose()
      world.dispose()
      textures.dispose()
      bundle.dispose()
    },
  }
}

const speedOf = (ship: ShipState): number =>
  Math.hypot(ship.velocity[0]!, ship.velocity[1]!, ship.velocity[2]!)

/**
 * Keep an orbit circular.
 *
 * With no gravity integration, a straight-line velocity would fly off on a
 * tangent. Rotating the velocity by the angle the ship swept this step keeps
 * it circular, which is all the orbit has to be.
 */
const turnOrbitVelocity = (
  ship: ShipState,
  ephem: Ephemeris,
  proximity: ReturnType<typeof createProximityState>,
  dt: number,
): void => {
  const id = proximity.nearestId
  if (id === null) return
  const entry = ephem.get(id)
  if (entry === undefined) return

  const rx = ship.position[0]! - entry.position[0]!
  const ry = ship.position[1]! - entry.position[1]!
  const rz = ship.position[2]! - entry.position[2]!
  const r = Math.hypot(rx, ry, rz)
  if (r === 0) return

  const speed = speedOf(ship)
  const omega = speed / r
  const angle = -omega * dt

  // Rotate the velocity about the orbit normal.
  const nx = ry * ship.velocity[2]! - rz * ship.velocity[1]!
  const ny = rz * ship.velocity[0]! - rx * ship.velocity[2]!
  const nz = rx * ship.velocity[1]! - ry * ship.velocity[0]!
  const nLen = Math.hypot(nx, ny, nz)
  if (nLen === 0) return

  const axis = new Vector3(nx / nLen, ny / nLen, nz / nLen)
  const velocity = new Vector3(ship.velocity[0]!, ship.velocity[1]!, ship.velocity[2]!)
  velocity.applyAxisAngle(axis, angle)
  ship.velocity[0] = velocity.x
  ship.velocity[1] = velocity.y
  ship.velocity[2] = velocity.z
}

const placeShipAtEarth = (ship: ShipState, ephem: Ephemeris): void => {
  const earth = ephem.get('earth')
  const desc = BODY_BY_ID.get('earth')
  if (earth === undefined || desc === undefined) {
    ship.position[0] = AU
    return
  }
  const radius = meanRadius(desc)
  const offset = radius * START_ALTITUDE_RADII

  // Stand off toward the Sun and a little above it, so the opening view has a
  // lit Earth rather than a black disc. The Sun is at the origin, so the
  // sunward direction from Earth is just its own position, negated.
  const toSunLength = Math.hypot(earth.position[0]!, earth.position[1]!, earth.position[2]!) || 1
  const sx = -earth.position[0]! / toSunLength
  const sy = -earth.position[1]! / toSunLength
  const sz = -earth.position[2]! / toSunLength

  ship.position[0] = earth.position[0]! + sx * offset
  ship.position[1] = earth.position[1]! + sy * offset
  ship.position[2] = earth.position[2]! + sz * offset + offset * 0.35

  // Point the nose at Earth.
  const dx = earth.position[0]! - ship.position[0]!
  const dy = earth.position[1]! - ship.position[1]!
  const dz = earth.position[2]! - ship.position[2]!
  const look = new Quaternion().setFromUnitVectors(
    new Vector3(0, 0, -1),
    new Vector3(dx, dy, dz).normalize(),
  )
  ship.orientation[0] = look.x
  ship.orientation[1] = look.y
  ship.orientation[2] = look.z
  ship.orientation[3] = look.w
}

const describeShader = (shader: string): string => {
  switch (shader) {
    case 'EMISSIVE': return 'star'
    case 'GAS_GIANT': return 'gas giant'
    case 'CLOUDY': return 'planet with an atmosphere'
    default: return 'rocky body'
  }
}

const formatSimDate = (clock: SimClock): string => {
  const date = clock.date
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` +
    `  ·  JD ${(clock.julianDate).toFixed(3)}`
}

const describeRendererFailure = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  return 'The renderer could not start. This needs a browser with WebGPU or WebGL2.\n' + message
}
