/**
 * The UI store.
 *
 * One mutable object, written by the frame loop and read by the HUD. Ship
 * position never enters React state, and React never renders inside the frame
 * loop: putting position into state and re-rendering at 60 fps would cost more
 * than the 109,000-star field does.
 *
 * Two readers, two rates:
 *   - the live layer writes DOM nodes directly, numbers at 10 Hz and the
 *     target arrow every frame, because 10 Hz looks laggy while turning;
 *   - the panels subscribe, and only ever fire on things that change when a
 *     human does something.
 */

import type { StarFieldSettings } from '../stars/starfield'
import type { Target } from '../sim/targeting'

export type LoadPhase = 'booting' | 'loading' | 'ready' | 'failed'

export interface LiveState {
  /** Metres per second. */
  speed: number
  /** Throttle position, 0 to 1. */
  throttle: number
  /** True while proximity to a body is holding the speed below the throttle. */
  clamped: boolean
  /** Body whose frame the ship is riding, or null. */
  attachedTo: string | null
  /** Metres to the nearest body's surface. */
  nearestSurface: number
  nearestName: string
  /** Name of whatever is currently holding the speed down, for the HUD notice. */
  limitingName: string
  /** Set when the ship has just cut its throttle on reaching a target. */
  arrivedAt: string
  target: Target | null
  targetDistance: number
  targetSurfaceDistance: number
  targetEta: number
  /**
   * Target position in normalised device coordinates. Only meaningful while
   * `targetOnScreen` is true; behind the camera the projection is nonsense.
   */
  targetScreenX: number
  targetScreenY: number
  targetOnScreen: boolean
  /**
   * Screen-space bearing to the target, radians, anticlockwise from the right
   * with y up. Valid whether the target is in front or behind, which is what
   * the edge arrow needs.
   */
  targetAngle: number
  /** Simulation date. */
  julianDate: number
  dateText: string
  /** Auto-exposure, for the diagnostics panel. */
  exposure: number
  averageLuminance: number
  fps: number
}

export interface Settings {
  stars: StarFieldSettings
  /** Label shown in the settings panel for the current star preset. */
  starPreset: 'realistic' | 'enhanced' | 'custom'
  milkyWayBrightness: number
  instrumentBrightness: number
  mouseSensitivity: number
  /**
   * Turn the ship toward its target when the pilot is not steering.
   *
   * On by default. Flying an interplanetary intercept by hand to a fraction of
   * a degree is not what this is for, and without it an arrival is a matter of
   * luck. Any stick input overrides it instantly.
   */
  alignToTarget: boolean
  taa: boolean
  reverseZ: boolean
  showDiagnostics: boolean
}

export interface Store {
  live: LiveState
  settings: Settings
  phase: LoadPhase
  loadMessage: string
  backend: string
  reverseZActive: boolean
  /** Fires when something a panel cares about changes. */
  subscribe: (listener: () => void) => () => void
  notify: () => void
}

export const createStore = (settings: Settings): Store => {
  const listeners = new Set<() => void>()

  return {
    live: {
      speed: 0,
      throttle: 0,
      clamped: false,
      attachedTo: null,
      nearestSurface: Number.POSITIVE_INFINITY,
      nearestName: '',
      limitingName: '',
      arrivedAt: '',
      target: null,
      targetDistance: 0,
      targetSurfaceDistance: 0,
      targetEta: Number.POSITIVE_INFINITY,
      targetScreenX: 0,
      targetScreenY: 0,
      targetOnScreen: false,
      targetAngle: 0,
      julianDate: 0,
      dateText: '',
      exposure: 1,
      averageLuminance: Number.NaN,
      fps: 0,
    },
    settings,
    phase: 'booting',
    loadMessage: '',
    backend: '',
    reverseZActive: false,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: () => { for (const listener of listeners) listener() },
  }
}
