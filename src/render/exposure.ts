/**
 * Auto-exposure.
 *
 * The single biggest realism win in the project. Without it the cockpit is
 * black whenever a planet is correctly lit, because the dynamic range between
 * a sunlit cloud top and an instrument panel is far wider than a display. With
 * it, turning toward the Sun blows out and recovers, and that one effect reads
 * as "real" to most people more than any texture will.
 *
 * Which estimator to use turned out to be the whole problem, and it took three
 * attempts.
 *
 * A luminance histogram was the design in the plan. It is the wrong one here:
 * a histogram compute pass needs atomics, which are WebGPU-only, so it would
 * not survive the WebGL2 fallback.
 *
 * A centre-weighted average of log luminance is the usual substitute, and in
 * space it fails outright. The frame is almost entirely black, so most samples
 * land on nothing, and a log average over nothing runs away: sitting beside a
 * lit Earth it asked for 652x and turned the cockpit into a white silhouette.
 * Weighting samples by their own brightness helped but did not fix it, and it
 * had a nasty feedback property. Darkening the cockpit to stop it blowing out
 * lowered the average, which raised the exposure, which blew it out again.
 *
 * What works is the luminance-weighted mean luminance:
 *
 *     L* = sum(w * L^2) / sum(w * L)
 *
 * which is the average brightness of the light actually arriving, weighted by
 * how much light each direction contributes. Empty sky contributes almost
 * nothing to either sum, so it barely moves the result, and no amount of black
 * can drag it away. It is linear, so it needs no logarithm and cannot be
 * poisoned by a zero. Two accumulators, no atomics, identical on both
 * backends.
 *
 * The floor on L is what fixes the exposure in genuinely empty space: with
 * nothing else in view, L* is the floor, so the two constants together set the
 * dark-adapted exposure at about 800x, where a magnitude 6.5 star, the
 * naked-eye limit, lands near 0.18 and Sirius blows out and blooms. That is
 * what a dark-adapted eye sees.
 *
 * Adaptation is asymmetric, faster to bright than to dark, as the eye is.
 */

import {
  FloatType,
  NearestFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Renderer,
  RGBAFormat,
} from 'three/webgpu'
import { float, luminance, max, uniform, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { FloatUniform } from '../scene/materials/nodes'

/** A TSL expression that evaluates to a scalar. The operators live on this form. */
type FloatNode = Node<'float'>

/** Taps per axis across the frame. 100 samples costs nothing at 1x1 output. */
const GRID = 10

export interface ExposureSettings {
  /** Seconds to adapt to a brighter scene. The eye is quick at this. */
  adaptUpSeconds: number
  /** Seconds to adapt to a darker scene. Dark adaptation is slow. */
  adaptDownSeconds: number
  /**
   * Where the lit content in view is placed, in linear display units before
   * tone mapping.
   *
   * L* approximates the luminance of whatever is lit in the frame rather than
   * its peak, so this is a mid-tone target, not a clipping point. 0.35 is
   * above the 0.18 of photographic middle grey, because a sunlit planet should
   * read as bright; it leaves the brightest cloud tops, the ocean glint and
   * the solar disc to go over 1.0 and bloom, which is what they do in real
   * orbital photographs.
   */
  highlightTarget: number
  /** Exposure limits, so nothing can amplify noise without bound. */
  minExposure: number
  maxExposure: number
  /** How often the 1x1 metering result is read back, in frames. */
  readbackInterval: number
  /**
   * Floor applied to metered luminance.
   *
   * This is what sets the exposure in genuinely empty space, where there is
   * nothing for the metering to lock onto: with nothing in view L* is the
   * floor. It is not a constant, because the luminance of a point source
   * depends on the solid angle of a pixel, so it is derived from a target
   * magnitude and a target display value and updated on resize. See
   * stars/pointFlux.ts and setLuminanceFloor.
   */
  luminanceFloor: number
}

export const DEFAULT_EXPOSURE: ExposureSettings = {
  adaptUpSeconds: 0.8,
  adaptDownSeconds: 2.0,
  highlightTarget: 0.35,
  // Wide, because the range from a sunlit cloud top to a magnitude 6.5 star is
  // genuinely about eleven orders of magnitude.
  minExposure: 1e-7,
  maxExposure: 1e9,
  readbackInterval: 3,
  // Replaced at start-up by a value derived from the viewport.
  luminanceFloor: 1e-7,
}

export interface AutoExposure {
  /** Render the metering pass. Call once per frame, after the scene passes. */
  measure: (renderer: Renderer) => void
  /** Advance the adaptation and write renderer.toneMappingExposure. */
  update: (renderer: Renderer, dt: number) => void
  /** Current exposure multiplier, for the HUD and for debugging. */
  readonly exposure: number
  /** Measured luminance-weighted mean, or NaN before the first readback. */
  readonly averageLuminance: number
  setSettings: (settings: Partial<ExposureSettings>) => void
  /** Update the dark-adapted floor, which depends on the viewport. */
  setLuminanceFloor: (value: number) => void
  dispose: () => void
}

/**
 * @param sampleScene given a uv, returns the HDR colour there.
 *
 *   It must sample render-target textures, never re-evaluate a post chain: the
 *   metering pass runs this a hundred times, so handing it an expression that
 *   contains bloom would render bloom a hundred times. The textures it reads
 *   are already on the GPU by the time this pass runs, so the real cost is a
 *   hundred texture fetches.
 */
export const createAutoExposure = (
  sampleScene: (u: number, v: number) => unknown,
  settings: ExposureSettings = DEFAULT_EXPOSURE,
): AutoExposure => {
  const config: ExposureSettings = { ...settings }

  const target = new RenderTarget(1, 1, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  })
  target.texture.name = 'exposure-meter'

  // The dark-adapted floor, as a uniform so a resize can move it without
  // rebuilding the metering expression.
  const floor = uniform(float(config.luminanceFloor)) as FloatUniform

  // Unrolled rather than a TSL Loop: 100 taps compile once and the expression
  // stays readable. The position weight is a soft centre bias, so something
  // bright at the very edge of the view does not decide the exposure for the
  // middle of it.
  let weightedSquares: FloatNode = float(0)
  let weightedSum: FloatNode = float(0)

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const u = (x + 0.5) / GRID
      const v = (y + 0.5) / GRID
      const dx = u - 0.5
      const dy = v - 0.5
      const weight = Math.exp(-2.5 * (dx * dx + dy * dy))

      const rgb = sampleScene(u, v) as Parameters<typeof luminance>[0]
      const lum = max(luminance(rgb), floor)
      weightedSquares = weightedSquares.add(lum.mul(lum).mul(weight))
      weightedSum = weightedSum.add(lum.mul(weight))
    }
  }

  // R carries sum(w L^2), G carries sum(w L). The division happens on the CPU
  // after readback, where a zero divisor is easy to guard.
  const meterNode = vec4(weightedSquares, weightedSum, 0, 1)

  const material = new NodeMaterial()
  material.name = 'exposure-meter'
  material.fragmentNode = meterNode
  const quad = new QuadMesh(material)

  let frame = 0
  let readInFlight = false
  let averageLuminance = Number.NaN
  let exposure = 1

  const measure = (renderer: Renderer): void => {
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    quad.render(renderer)
    renderer.setRenderTarget(previous)

    frame++
    if (frame % config.readbackInterval !== 0 || readInFlight) return

    readInFlight = true
    // Async, so the GPU is never stalled waiting for a single pixel.
    renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)
      .then((data) => {
        const array = data as Float32Array
        const squares = array[0]
        const sum = array[1]
        if (squares !== undefined && sum !== undefined && sum > 0 && Number.isFinite(squares)) {
          averageLuminance = squares / sum
        }
      })
      .catch(() => { /* a dropped readback just means one stale frame */ })
      .finally(() => { readInFlight = false })
  }

  const update = (renderer: Renderer, dt: number): void => {
    if (Number.isFinite(averageLuminance) && averageLuminance > 0) {
      const wanted = clamp(
        config.highlightTarget / averageLuminance, config.minExposure, config.maxExposure,
      )
      // Asymmetric: quick to stop down when it gets bright, slow to open up
      // when it gets dark. That is how the eye behaves.
      const tau = wanted < exposure ? config.adaptUpSeconds : config.adaptDownSeconds
      // Blend in log space, so the same time constant holds across the whole
      // twenty-order-of-magnitude range.
      const blend = 1 - Math.exp(-dt / Math.max(1e-3, tau))
      const logNow = Math.log2(exposure)
      const logWanted = Math.log2(wanted)
      exposure = 2 ** (logNow + (logWanted - logNow) * blend)
    }
    renderer.toneMappingExposure = exposure
  }

  return {
    measure,
    update,
    get exposure() { return exposure },
    get averageLuminance() { return averageLuminance },
    setSettings: (next) => {
      Object.assign(config, next)
      floor.value = config.luminanceFloor
    },
    setLuminanceFloor: (value) => {
      config.luminanceFloor = value
      floor.value = value
    },
    dispose: () => { target.dispose(); material.dispose() },
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
