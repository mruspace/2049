/**
 * The scene, and the per-frame rebase.
 *
 * Two scenes, not one. The star field and the Milky Way live in `starScene`,
 * which is rendered unjittered, because TRAA's sub-pixel jitter smears point
 * sprites into streaks. Everything solid lives in `scene`.
 *
 * Bodies are created on demand. The Sun and the sky are enough to start
 * flying; a planet's textures and meshes are built the first time it is
 * targeted or comes close. Nobody visits all eight in one session, and the
 * first flight should not wait for Neptune.
 */

import { Quaternion, Scene, type Texture, type WebGPURenderer } from 'three/webgpu'
import { BODIES, BODY_BY_ID, meanRadius, type BodyDesc } from '../ephem/bodies'
import type { Ephemeris } from '../ephem/ephemeris'
import { AU } from '../sim/constants'
import type { ShipState } from '../sim/state'
import { vec3, type Vec3 } from '../sim/vec3'
import { createStarField, REALISTIC_STARS, type StarField, type StarFieldSettings } from '../stars/starfield'
import { loadStarCatalogue, type StarCatalogue } from '../stars/catalog'
import type { TextureStore } from '../render/textures'
import { createBodyVisual, updateBodyVisual, type BodyVisual } from './bodyVisual'
import { createCockpit, type Cockpit } from './cockpit'
import { createBodyPoints, type BodyPoints } from './bodyPoints'
import { createCloudLayer } from './clouds'
import { createMilkyWay, defaultSkyGain, type MilkyWay } from './milkyway'
import { METRES_TO_PARSEC } from './origin'
import { createAtmosphere } from './materials/atmosphere'
import { createSurfaceLighting } from './materials/lighting'
import { createEmissiveMaterial } from './materials/emissive'
import { createRockyMaterial, createCloudyMaterial, createGasGiantMaterial, advanceBands } from './materials/surface'
import { createRings } from './rings'

export interface World {
  scene: Scene
  starScene: Scene
  starField: StarField
  /** Every body as a point source, for the distances where it is sub-pixel. */
  bodyPoints: BodyPoints
  milkyWay: MilkyWay
  cockpit: Cockpit
  catalogue: StarCatalogue
  /** Bodies currently built. Others are created on request. */
  visuals: ReadonlyMap<string, BodyVisual>
  /** Build a body's meshes and start loading its textures. Idempotent. */
  ensureBody: (id: string) => void
  /**
   * Rebuild the cockpit for a new field of view.
   *
   * Every dimension of the cockpit is derived from the field of view, so a
   * window resize that changes it, such as a phone rotating, has to rebuild
   * the frame. It is fifteen boxes of procedural geometry, so this costs
   * nothing and happens only when the angle actually moves.
   */
  setFieldOfView: (fov: number) => void
  update: (
    ship: ShipState, ephem: Ephemeris, dt: number, pixelsPerRadian: number,
  ) => void
  applyStarSettings: (settings: StarFieldSettings) => void
  dispose: () => void
}

/**
 * Distance at which a body's mesh is built without being asked for, as a
 * multiple of its own radius.
 *
 * A body first covers about a pixel at 2000 radii, and the point sprite covers
 * everything beyond that, so the mesh only has to exist a little before it
 * starts to resolve. 8000 radii gives the textures a few seconds of head start
 * at a realistic closing speed, which is what stops a planet appearing
 * untextured.
 *
 * The first attempt used a million radii, which is 43 AU for Earth: every body
 * in the solar system built itself during the load screen and the whole
 * texture set was fetched before the first frame, which is exactly what
 * on-demand loading was supposed to avoid.
 */
const AUTO_BUILD_RADII = 8000

export const createWorld = async (
  renderer: WebGPURenderer,
  textures: TextureStore,
  /** The camera's vertical field of view in degrees, which sizes the cockpit. */
  fov: number,
  starSettings: StarFieldSettings = REALISTIC_STARS,
): Promise<World> => {
  const scene = new Scene()
  scene.name = 'main'
  const starScene = new Scene()
  starScene.name = 'sky'

  const [catalogue, skyMap] = await Promise.all([
    loadStarCatalogue(),
    textures.get('milkyway'),
  ])

  const starField = createStarField(catalogue, starSettings)
  starScene.add(starField.object)

  const milkyWay = createMilkyWay(skyMap, defaultSkyGain(textures.peakLinear('milkyway') ?? 0.156))
  starScene.add(milkyWay.object)

  // Point sources live in the sky pass alongside the stars, so they share the
  // unjittered buffer and the same depth rules. A body's own mesh occludes its
  // point as soon as the mesh is in front of it.
  const bodyPoints = createBodyPoints(BODIES, pointTints(textures))
  starScene.add(bodyPoints.object)

  const cockpitLighting = createSurfaceLighting()
  let cockpit = createCockpit({ lighting: cockpitLighting, fov })
  let cockpitFov = fov
  scene.add(cockpit.object)

  const setFieldOfView = (nextFov: number): void => {
    if (Math.abs(nextFov - cockpitFov) < 0.5) return
    cockpitFov = nextFov
    const brightness = cockpit.instrumentBrightness
    scene.remove(cockpit.object)
    cockpit.dispose()
    cockpit = createCockpit({ lighting: cockpitLighting, fov: nextFov })
    cockpit.setInstrumentBrightness(brightness)
    scene.add(cockpit.object)
  }

  const visuals = new Map<string, BodyVisual>()
  const building = new Set<string>()

  const ensureBody = (id: string): void => {
    if (visuals.has(id) || building.has(id)) return
    const desc = BODY_BY_ID.get(id)
    if (desc === undefined) return
    building.add(id)
    void buildBody(desc, textures).then((visual) => {
      visuals.set(id, visual)
      for (const node of visual.nodes) scene.add(node)
      building.delete(id)
    }).catch((err: unknown) => {
      building.delete(id)
      console.error(`Could not build ${id}:`, err)
    })
  }

  // The Sun is the one body that is always there. Everything else waits.
  for (const desc of BODIES) {
    if (desc.preload === true) ensureBody(desc.id)
  }

  const sunPosition: Vec3 = vec3(0, 0, 0)
  const shipOrientation = new Quaternion()

  const update = (
    ship: ShipState, ephem: Ephemeris, dt: number, pixelsPerRadian: number,
  ): void => {
    // The cockpit rides the ship's attitude.
    //
    // This is not optional and its absence is not subtle: the camera sits at
    // the world origin and turns with the ship, so a cockpit left in world
    // orientation is a fixed object the camera swings around inside. The
    // canopy drifts off to one side and the console ends up in a corner.
    //
    // It follows the ship rather than the camera on purpose. Free look adds
    // its own rotation on top of the ship's, and the point of free look is to
    // turn your head inside the cockpit, which only works if the cockpit stays
    // put while the view moves.
    shipOrientation.set(
      ship.orientation[0]!, ship.orientation[1]!, ship.orientation[2]!, ship.orientation[3]!,
    )
    cockpit.object.quaternion.copy(shipOrientation)
    cockpit.object.updateMatrix()

    // The star shader needs the camera in parsecs, because the catalogue is in
    // parsecs and always will be.
    starField.setCameraParsecs(
      ship.position[0]! * METRES_TO_PARSEC,
      ship.position[1]! * METRES_TO_PARSEC,
      ship.position[2]! * METRES_TO_PARSEC,
    )

    bodyPoints.update(ephem, ship.position, pixelsPerRadian)

    // Build anything that has come within reach, so a planet is never
    // conjured into view at close range.
    for (const entry of ephem.bodies.values()) {
      if (visuals.has(entry.desc.id) || building.has(entry.desc.id)) continue
      const dx = entry.position[0]! - ship.position[0]!
      const dy = entry.position[1]! - ship.position[1]!
      const dz = entry.position[2]! - ship.position[2]!
      if (Math.hypot(dx, dy, dz) < meanRadius(entry.desc) * AUTO_BUILD_RADII) {
        ensureBody(entry.desc.id)
      }
    }

    for (const visual of visuals.values()) {
      const entry = ephem.get(visual.desc.id)
      if (entry === undefined || !entry.initialised) continue
      updateBodyVisual(visual, entry, ship.position, sunPosition)
      if (visual.desc.shader === 'GAS_GIANT') {
        // Differential rotation. Slow on purpose: it should read as motion in
        // the bands, not as a scrolling texture.
        advanceBands(visual.material, dt, 4e-6)
      }
      visual.clouds?.advance(dt)
    }

    updateCockpitLighting(cockpit, ship, ephem)
  }

  return {
    scene,
    starScene,
    starField,
    bodyPoints,
    milkyWay,
    get cockpit() { return cockpit },
    catalogue,
    visuals,
    ensureBody,
    setFieldOfView,
    update,
    applyStarSettings: (settings) => { starField.applySettings(settings) },
    dispose: () => {
      starField.dispose()
      bodyPoints.dispose()
      milkyWay.dispose()
      cockpit.dispose()
      for (const visual of visuals.values()) {
        visual.material.dispose()
        visual.atmosphere?.dispose()
        visual.rings?.dispose()
        visual.clouds?.dispose()
      }
    },
  }
}

/**
 * Colour for each body's point sprite.
 *
 * Taken from the mean of its albedo map, measured at build time, so Mars comes
 * out orange and Neptune blue without anyone choosing a colour. Bodies with no
 * colour map fall back to neutral.
 */
const pointTints = (
  textures: TextureStore,
): ReadonlyMap<string, readonly [number, number, number]> => {
  const tints = new Map<string, readonly [number, number, number]>()
  for (const body of BODIES) {
    const key = body.textures.albedo
    const rgb = key === undefined ? undefined : textures.meanRgb(key)
    if (rgb !== undefined) tints.set(body.id, rgb)
  }
  return tints
}

const buildBody = async (desc: BodyDesc, textures: TextureStore): Promise<BodyVisual> => {
  const lighting = createSurfaceLighting()
  const load = async (key: string | undefined): Promise<Texture | undefined> => {
    if (key === undefined || !textures.has(key)) return undefined
    try {
      return await textures.get(key)
    } catch {
      // A missing texture must not stop a body appearing: the shaders all have
      // a flat-colour fallback for exactly this.
      return undefined
    }
  }

  const albedoMap = await load(desc.textures.albedo)
  // Anchors the map's mean reflectance to the body's published albedo.
  const albedoScale = desc.textures.albedo === undefined
    ? 1
    : textures.albedoScale(desc.textures.albedo, desc.albedo)

  switch (desc.shader) {
    case 'EMISSIVE': {
      const material = createEmissiveMaterial({ map: albedoMap })
      return createBodyVisual(desc, material, lighting)
    }

    case 'CLOUDY': {
      const [nightMap, specularMask, normalMap, cloudMap] = await Promise.all([
        load(desc.textures.night),
        load(desc.textures.specMask),
        load(desc.textures.normal),
        load(desc.textures.clouds),
      ])

      // Built before the surface material, because the surface needs the
      // shadow node the cloud layer owns.
      const clouds = cloudMap === undefined
        ? undefined
        : createCloudLayer(desc, cloudMap, lighting)

      const material = createCloudyMaterial({
        lighting, albedoMap, nightMap, specularMask, normalMap,
        albedo: desc.albedo, albedoScale,
        normalStrength: 0.7,
        cloudShadow: clouds?.surfaceShadow(),
      })
      const atmosphere = desc.atmosphere !== undefined
        ? createAtmosphere(desc, desc.atmosphere, lighting)
        : undefined
      return createBodyVisual(desc, material, lighting, { atmosphere, clouds })
    }

    case 'GAS_GIANT': {
      // Rings are built before the surface material, because the surface
      // needs the shadow node the ring system owns.
      let rings
      if (desc.rings !== undefined) {
        const ringMap = await load(desc.rings.texture)
        if (ringMap !== undefined) rings = createRings(desc, desc.rings, ringMap, lighting)
      }
      const material = createGasGiantMaterial({
        lighting, albedoMap, albedo: desc.albedo, albedoScale, bandShear: 0,
        ringShadow: rings?.surfaceShadow(),
      })
      return createBodyVisual(desc, material, lighting, { rings })
    }

    case 'ROCKY':
    default: {
      const normalMap = await load(desc.textures.normal)
      const material = createRockyMaterial({
        lighting, albedoMap, normalMap, albedo: desc.albedo, albedoScale, normalStrength: 1,
      })
      const atmosphere = desc.atmosphere !== undefined
        ? createAtmosphere(desc, desc.atmosphere, lighting)
        : undefined
      return createBodyVisual(desc, material, lighting, { atmosphere })
    }
  }
}

/**
 * Light the cockpit.
 *
 * The Sun is straightforward. Planetshine is the part that matters: in orbit,
 * the shadowed half of the frame is lit by the planet below, tinted by its
 * albedo. It is nearly free and it is the difference between sitting in a
 * cockpit and sitting in a silhouette.
 */
const updateCockpitLighting = (cockpit: Cockpit, ship: ShipState, ephem: Ephemeris): void => {
  const sun = ephem.get('sun')
  const sx = (sun?.position[0] ?? 0) - ship.position[0]!
  const sy = (sun?.position[1] ?? 0) - ship.position[1]!
  const sz = (sun?.position[2] ?? 0) - ship.position[2]!
  const sunDistance = Math.hypot(sx, sy, sz)
  cockpit.lighting.update(sx, sy, sz, sunDistance)

  // Nearest body by surface gap, which is the one actually filling the view.
  let bestId: string | null = null
  let bestGap = Number.POSITIVE_INFINITY
  let bestVector = { x: 0, y: 1, z: 0, centre: 1 }

  for (const entry of ephem.bodies.values()) {
    if (!entry.initialised || entry.desc.id === 'sun') continue
    const dx = entry.position[0]! - ship.position[0]!
    const dy = entry.position[1]! - ship.position[1]!
    const dz = entry.position[2]! - ship.position[2]!
    const centre = Math.hypot(dx, dy, dz)
    const radius = meanRadius(entry.desc)
    const gap = centre - radius
    if (gap < bestGap) {
      bestGap = gap
      bestId = entry.desc.id
      bestVector = { x: dx, y: dy, z: dz, centre }
    }
  }

  const desc = bestId === null ? undefined : BODY_BY_ID.get(bestId)
  if (desc === undefined || bestId === null) {
    cockpit.lighting.planetshine.value.set(0, 0, 0)
    return
  }

  const radius = meanRadius(desc)
  // Solid angle of the body as seen from here, as a fraction of the full
  // hemisphere. At the surface this is 1; at ten radii it is about 1%.
  const ratio = Math.min(1, radius / Math.max(bestVector.centre, radius))
  const coverage = ratio * ratio

  const sunEntry = ephem.get(bestId)
  const bodyToSunDistance = sunEntry === undefined
    ? AU
    : Math.hypot(sunEntry.position[0]!, sunEntry.position[1]!, sunEntry.position[2]!) || AU
  const irradiance = (AU / bodyToSunDistance) ** 2

  // Bounce is albedo times coverage times the light falling on the body. The
  // 0.55 is the fraction of the visible disc that is lit on average; a fuller
  // treatment would need the phase angle, and at these levels it would not be
  // visible.
  const bounce = desc.albedo * coverage * irradiance * 0.55
  cockpit.lighting.planetshine.value.set(bounce, bounce * 0.99, bounce * 0.97)

  const inv = 1 / (bestVector.centre || 1)
  cockpit.lighting.planetshineDirection.value.set(
    bestVector.x * inv, bestVector.y * inv, bestVector.z * inv,
  )
}
