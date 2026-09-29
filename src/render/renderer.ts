/**
 * Renderer setup.
 *
 * One renderer and one shader language. WebGPURenderer installs a WebGL2
 * backend fallback of its own when WebGPU initialisation throws, and TSL
 * compiles through either backend, so a single build serves both and every
 * shader is written once.
 *
 * Two consequences of that choice are load-bearing elsewhere in the codebase:
 * THREE.ShaderMaterial with raw GLSL does not work at all here (the node
 * builder substitutes a blank material and logs), and THREE.Points cannot have
 * a per-point size, which is why the star field is instanced sprites.
 */

import {
  AgXToneMapping,
  type Camera,
  PerspectiveCamera,
  WebGPURenderer,
} from 'three/webgpu'
import { FAR_PLANE, NEAR_PLANE } from '../sim/constants'

export type Backend = 'webgpu' | 'webgl2'

export interface RendererOptions {
  canvas: HTMLCanvasElement
  /** Dev flag. Forces the WebGL2 backend so the fallback path can be tested. */
  forceWebGL?: boolean
  /**
   * Reverse-Z is young: two regressions shipped and were fixed between r185
   * and r186, and polygonOffset under it is still open upstream. It is behind
   * a toggle so the build stays shippable without it. The floating origin,
   * not reverse-Z, is what makes the scene work.
   */
  reverseZ?: boolean
  /** Upper bound on device pixel ratio. Low-tier devices pass a smaller value. */
  maxPixelRatio?: number
}

export interface RendererBundle {
  renderer: WebGPURenderer
  camera: PerspectiveCamera
  backend: Backend
  /** True only when reverse-Z is actually active, not merely requested. */
  reverseZActive: boolean
  setSize: (width: number, height: number, pixelRatio: number) => void
  dispose: () => void
}

/**
 * Build and initialise the renderer.
 *
 * `renderer.init()` must be awaited. Calling `.render()` before it throws, and
 * KTX2Loader.detectSupport needs the backend to exist before it can ask which
 * compressed formats the device takes.
 */
export const createRenderer = async (options: RendererOptions): Promise<RendererBundle> => {
  const { canvas, forceWebGL = false, reverseZ = true, maxPixelRatio = 2 } = options

  const renderer = new WebGPURenderer({
    canvas,
    // TRAA does its own resolve. MSAA must be off when it is in use.
    antialias: false,
    // The flag really is spelled this way. It was renamed from
    // `reverseDepthBuffer` in r179, and the old spelling fails silently.
    reversedDepthBuffer: reverseZ,
    forceWebGL,
    alpha: false,
    powerPreference: 'high-performance',
  })

  // Tone map exactly once, at the very end of the chain. RenderPipeline
  // applies this through its output colour transform. Never Reinhard: it turns
  // the Sun into desaturated grey mush.
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1

  await renderer.init()

  const backend: Backend = isWebGPUBackend(renderer) ? 'webgpu' : 'webgl2'
  const reverseZActive = reverseZ && detectReverseZ(renderer, backend)

  if (reverseZ && !reverseZActive) {
    console.warn(
      'Reverse-Z was requested but is not active. On WebGL2 it needs the ' +
      'EXT_clip_control extension, which Firefox does not ship. Depth ' +
      'precision falls back to the normal range; the floating origin covers it.',
    )
  }

  const camera = new PerspectiveCamera(MIN_FOV, 1, NEAR_PLANE, FAR_PLANE)
  // The camera never moves. The world is rebased around it every frame.
  camera.position.set(0, 0, 0)

  const setSize = (width: number, height: number, pixelRatio: number): void => {
    renderer.setPixelRatio(Math.min(pixelRatio, maxPixelRatio))
    renderer.setSize(width, height, false)
    camera.aspect = width / Math.max(1, height)
    camera.fov = verticalFovFor(camera.aspect)
    camera.updateProjectionMatrix()
  }

  return {
    renderer,
    camera,
    backend,
    reverseZActive,
    setSize,
    dispose: () => { renderer.dispose() },
  }
}

/**
 * Vertical field of view for a given aspect ratio.
 *
 * three.js specifies field of view vertically, which is the wrong way round
 * for a phone held upright. At an aspect of 0.5 a 65 degree vertical view is
 * only 35 degrees across, which is a letterbox: the canopy is off both sides
 * and the console fills the bottom of a very tall frame.
 *
 * So the horizontal field is the thing held roughly constant, and the
 * vertical one is derived from it. The lower clamp keeps a wide desktop
 * window at the 65 degrees the cockpit is designed around; the upper one
 * stops a very tall window from reaching a fisheye.
 */
export const MIN_FOV = 65
export const MAX_FOV = 100
const HORIZONTAL_TARGET = 78

export const verticalFovFor = (aspect: number): number => {
  const halfHorizontal = Math.tan((HORIZONTAL_TARGET * Math.PI) / 360)
  const vertical = (2 * Math.atan(halfHorizontal / Math.max(0.2, aspect)) * 180) / Math.PI
  return Math.min(MAX_FOV, Math.max(MIN_FOV, vertical))
}

const isWebGPUBackend = (renderer: WebGPURenderer): boolean => {
  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
  return backend?.isWebGPUBackend === true
}

/**
 * Whether reverse-Z survived initialisation.
 *
 * On WebGPU it always does. On WebGL2 three.js gates it on EXT_clip_control
 * and silently falls back when the extension is missing, so ask the context
 * directly rather than trusting the requested flag.
 */
const detectReverseZ = (renderer: WebGPURenderer, backend: Backend): boolean => {
  if (backend === 'webgpu') return true
  const gl = (renderer as unknown as {
    backend?: { gl?: WebGL2RenderingContext }
  }).backend?.gl
  if (gl === undefined) return false
  return gl.getExtension('EXT_clip_control') !== null
}

/** Field of view is fixed forward; free look rotates the camera, never the frustum. */
export const applyCameraOrientation = (
  camera: Camera,
  x: number, y: number, z: number, w: number,
): void => {
  camera.quaternion.set(x, y, z, w)
  camera.updateMatrixWorld()
}
