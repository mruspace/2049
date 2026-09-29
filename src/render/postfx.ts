/**
 * The post chain.
 *
 * Linear HDR throughout. Nothing is clamped mid-pipeline, and tone mapping
 * happens exactly once, at the very end, through RenderPipeline's output
 * colour transform. AgX, never Reinhard: Reinhard turns the Sun into
 * desaturated grey mush.
 *
 * The star field is rendered in its own pass, which is the point of this
 * arrangement. TRAA jitters the projection sub-pixel every frame, and a
 * jittered sub-pixel point sprite smears into a short streak that no amount of
 * antialiasing repairs. So stars go through an unjittered pass and composite
 * after the temporal resolve.
 *
 * Composite order:
 *   stars (unjittered)  ->  scene over stars  ->  bloom  ->  AgX  ->  sRGB
 */

import {
  type Camera,
  RenderPipeline,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import { mrt, output, pass, step, velocity, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import { createAutoExposure, DEFAULT_EXPOSURE, type AutoExposure, type ExposureSettings } from './exposure'
import {
  magnitudeToLuminance, SKY_LIMIT_DISPLAY_VALUE, SKY_LIMIT_MAGNITUDE,
} from '../stars/pointFlux'
import { REALISTIC_STARS } from '../stars/starfield'

/**
 * Debug views, selected with `?debug=` in the URL.
 *
 * The composite is several stages deep and every stage can fail invisibly: a
 * black sky looks the same whether the star pass drew nothing, the depth test
 * rejected it, or the exposure is wrong. These pull one stage out on its own.
 */
export type DebugView = 'none' | 'sky' | 'scene' | 'depth' | 'alpha'

export interface PostSettings {
  /**
   * Temporal antialiasing. Real reprojection TAA, not the sample accumulator
   * that the classic EffectComposer calls TAARenderPass, which does nothing in
   * a moving scene.
   */
  taa: boolean
  bloomStrength: number
  bloomRadius: number
  /**
   * Bloom threshold in linear HDR. Deliberately above 1: only genuinely
   * over-range things should bloom, which in practice means the Sun, specular
   * glints on water, and the brightest stars.
   */
  bloomThreshold: number
  /**
   * Ceiling on the value fed into bloom.
   *
   * The scene is genuinely unbounded: the solar disc is about 46,000 on the
   * photometric scale, and even after auto-exposure stops right down it lands
   * in the thousands. Blurring that directly floods the entire frame with
   * glow, which is what happened from 30 solar radii: a disc two degrees wide
   * washed out everything including the cockpit.
   *
   * So bloom is taken from a clamped copy of the composite. The direct signal
   * still goes to tone mapping at full range, so the disc stays blown out and
   * white; only the amount of light it is allowed to smear into its
   * surroundings is bounded.
   */
  bloomClamp: number
  exposure: ExposureSettings
  debug?: DebugView
}

export const DEFAULT_POST: PostSettings = {
  taa: true,
  bloomStrength: 0.42,
  bloomRadius: 0.45,
  bloomThreshold: 1.1,
  bloomClamp: 10,
  exposure: DEFAULT_EXPOSURE,
}

export interface PostChain {
  render: () => void
  /**
   * Tell the chain how big a pixel is.
   *
   * The dark-adapted exposure is pinned to how bright a magnitude 6.5 star
   * should look, and the luminance of a point source depends on the solid
   * angle of a pixel, so a resize moves it.
   */
  setResolution: (pixelsPerRadian: number) => void
  /** Advance auto-exposure. Call once per frame with the frame time. */
  update: (dt: number) => void
  readonly exposure: AutoExposure
  setSize: (width: number, height: number) => void
  dispose: () => void
}

/**
 * The metered luminance that produces the dark-adapted exposure.
 *
 * Chosen so that once the exposure has settled on nothing at all, a star at
 * the naked-eye limit lands at SKY_LIMIT_DISPLAY_VALUE. Since L* equals the
 * floor when there is nothing in view, the settled exposure is
 * highlightTarget / floor, and the star's display value is its luminance times
 * that.
 */
export const darkAdaptedFloor = (
  pixelsPerRadian: number, settings: PostSettings,
): number => {
  const limit = magnitudeToLuminance(
    SKY_LIMIT_MAGNITUDE, pixelsPerRadian, REALISTIC_STARS.psfPixels,
  )
  if (!(limit > 0)) return settings.exposure.luminanceFloor
  return (settings.exposure.highlightTarget * limit) / SKY_LIMIT_DISPLAY_VALUE
}

export const createPostChain = (
  renderer: WebGPURenderer,
  scene: Scene,
  starScene: Scene,
  camera: Camera,
  settings: PostSettings = DEFAULT_POST,
): PostChain => {
  const starPass = pass(starScene, camera)
  const starTexture = starPass.getTextureNode()

  const scenePass = pass(scene, camera)
  // TRAA needs per-pixel motion vectors, which means a second render target.
  scenePass.setMRT(mrt({ output, velocity }))
  const sceneTexture = scenePass.getTextureNode('output')
  const sceneDepth = scenePass.getTextureNode('depth')
  const sceneVelocity = scenePass.getTextureNode('velocity')
  // Linear depth, 0 at the near plane and 1 at the far plane. PassNode derives
  // it through the view-Z conversion, which already accounts for reverse-Z, so
  // this reads the same on both depth conventions.
  const sceneLinearDepth = scenePass.getLinearDepthNode()

  const resolved = settings.taa
    ? traa(sceneTexture, sceneDepth, sceneVelocity, camera)
    : sceneTexture

  // Stars show wherever the main pass drew nothing, which is what the scene's
  // depth says and nothing else does reliably.
  //
  // The obvious composite is over-blending by the scene's alpha, and it does
  // not work: whether a PassNode's render target clears to alpha 0 or alpha 1
  // depends on the renderer's clear alpha and on whether the canvas was
  // created with an alpha channel, and when it comes out as 1 the stars are
  // multiplied by zero and the sky is simply black. Depth has no such
  // ambiguity. Anything that wrote depth occludes the sky; the atmosphere
  // shells write none, so the sky shows through their thin outer haze, which
  // is also what it does in life.
  const skyVisible = step(0.995, sceneLinearDepth)
  const composited = resolved.rgb.add(starTexture.rgb.mul(skyVisible))

  const bloomed = bloom(
    vec4(composited.min(settings.bloomClamp), 1),
    settings.bloomStrength,
    settings.bloomRadius,
    settings.bloomThreshold,
  )

  const finalColour = (() => {
    switch (settings.debug ?? 'none') {
      // Raw sky, amplified so a faint star field is unmistakable.
      case 'sky': return vec4(starTexture.rgb.mul(400), 1)
      case 'scene': return vec4(resolved.rgb, 1)
      // Linear depth, so anything that wrote depth is visible as a shape.
      case 'depth': return vec4(sceneLinearDepth, sceneLinearDepth, sceneLinearDepth, 1)
      case 'alpha': return vec4(sceneTexture.a, sceneTexture.a, sceneTexture.a, 1)
      default: return vec4(composited.add(bloomed.rgb), 1)
    }
  })()

  const pipeline = new RenderPipeline(renderer, finalColour)
  // Applies renderer.toneMapping (AgX) and the sRGB conversion, once, here.
  pipeline.outputColorTransform = true

  // Metering samples the two render-target textures directly and repeats the
  // same composite per tap. It must not be handed the bloom expression, or
  // bloom would be evaluated once per sample.
  const exposure = createAutoExposure(
    // Metering deliberately ignores the sky and looks only at the scene pass:
    // bodies, atmospheres and the cockpit.
    //
    // Starlight is about a millionth of sunlight, so it has no business
    // driving adaptation, and including it made the exposure jitter as the
    // hundred sample points drifted on and off individual stars. Where the
    // scene drew nothing the samples fall to the metering floor, which is what
    // fixes the dark-adapted exposure in empty space. So the eye adapts to the
    // lit thing in view, or to nothing at all, and both are what a real eye
    // does.
    (u, v) => sceneTexture.sample(vec4(u, v, 0, 0).xy).rgb,
    settings.exposure,
  )

  return {
    render: () => {
      pipeline.render()
      exposure.measure(renderer)
    },
    setResolution: (pixelsPerRadian) => {
      exposure.setLuminanceFloor(darkAdaptedFloor(pixelsPerRadian, settings))
    },
    update: (dt) => { exposure.update(renderer, dt) },
    exposure,
    setSize: () => { pipeline.needsUpdate = true },
    dispose: () => { pipeline.dispose(); exposure.dispose() },
  }
}
