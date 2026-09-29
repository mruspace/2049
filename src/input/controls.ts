/**
 * Input.
 *
 * The mouse is a joystick, not a pointer. Deflection is the cursor's offset
 * from the centre of the screen, and the ship keeps turning for as long as it
 * is held off centre. This is what flight sims do, and it is the only scheme
 * that works when a turn takes several seconds: with position-based steering
 * the ship would stop rotating the moment the mouse stopped moving, and
 * pointing at anything would be impossible.
 *
 * Touch uses the same model with the origin at the point of first contact, so
 * both paths feed one ControlInput and the flight code never learns which was
 * used.
 */

import { createControlInput, type ControlInput } from '../sim/state'

export interface ControlOptions {
  /** The element that receives pointer events. Usually the canvas. */
  element: HTMLElement
  /** Fraction of the half-viewport at which deflection reaches full scale. */
  sensitivity?: number
  /** Fraction of the half-viewport that produces no rotation at all. */
  deadZone?: number
  /** Called when the player asks to target whatever is under the pointer. */
  onPick?: (x: number, y: number) => void
  /** Called on a request to match orbit with the nearest body. */
  onMatchOrbit?: () => void
  /** Called on a request to go to full throttle. */
  onCruise?: () => void
  /** Called when the search panel should open. */
  onSearch?: () => void
}

export interface Controls {
  /** Collect this frame's input. The returned object is reused. */
  sample: () => ControlInput
  /** True when the pointer has been placed and the joystick is live. */
  readonly active: boolean
  /** Current stick deflection, for drawing the HUD indicator. */
  readonly deflection: { x: number; y: number }
  setSensitivity: (value: number) => void
  /**
   * Check that nothing is sitting on top of the canvas.
   *
   * Call it once the loading screen is gone, since that legitimately covers
   * the canvas while it is up.
   */
  checkReachable: () => void
  dispose: () => void
}

export const createControls = (options: ControlOptions): Controls => {
  const { element, onPick, onMatchOrbit, onCruise, onSearch } = options
  let sensitivity = options.sensitivity ?? 0.55
  const deadZone = options.deadZone ?? 0.045

  const input = createControlInput()
  const keys = new Set<string>()

  // Joystick state, in normalised [-1, 1] deflection.
  let stickX = 0
  let stickY = 0
  let pointerPlaced = false

  // Free look, accumulated from relative movement while the button is held.
  let lookActive = false
  let lookDx = 0
  let lookDy = 0

  // Touch bookkeeping.
  let flightTouchId: number | null = null
  let flightOriginX = 0
  let flightOriginY = 0
  let throttleTouchId: number | null = null
  let throttleOriginY = 0
  let throttleDelta = 0
  let lookTouchIds: number[] = []

  const centreDeflection = (clientX: number, clientY: number): void => {
    const rect = element.getBoundingClientRect()
    const halfW = rect.width / 2
    const halfH = rect.height / 2
    // Normalised offset from the centre, scaled so `sensitivity` of the
    // half-viewport is full deflection.
    const nx = (clientX - rect.left - halfW) / (halfW * sensitivity)
    const ny = (clientY - rect.top - halfH) / (halfH * sensitivity)
    stickX = applyDeadZone(clamp(nx, -1, 1), deadZone)
    stickY = applyDeadZone(clamp(ny, -1, 1), deadZone)
    pointerPlaced = true
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    if (lookActive) {
      lookDx += event.movementX ?? 0
      lookDy += event.movementY ?? 0
      return
    }
    centreDeflection(event.clientX, event.clientY)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      onTouchDown(event)
      return
    }
    if (event.button === 2) {
      lookActive = true
      element.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button === 0) onPick?.(event.clientX, event.clientY)
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      onTouchUp(event)
      return
    }
    if (event.button === 2) {
      lookActive = false
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }
  }

  /**
   * Touch layout: the left two thirds fly, the right edge is the throttle.
   * Two fingers anywhere is free look. Splitting by region rather than by
   * gesture keeps both hands doing one thing each, which is the only way
   * six-degree-of-freedom flight is tolerable on glass.
   */
  const onTouchDown = (event: PointerEvent): void => {
    const rect = element.getBoundingClientRect()
    const fraction = (event.clientX - rect.left) / rect.width

    if (lookTouchIds.length > 0 || (flightTouchId !== null && throttleTouchId !== null)) {
      lookTouchIds.push(event.pointerId)
      lookActive = true
      return
    }

    if (fraction > 0.82 && throttleTouchId === null) {
      throttleTouchId = event.pointerId
      throttleOriginY = event.clientY
      return
    }

    if (flightTouchId === null) {
      flightTouchId = event.pointerId
      flightOriginX = event.clientX
      flightOriginY = event.clientY
      element.setPointerCapture(event.pointerId)
    }
  }

  const onTouchMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return
    const rect = element.getBoundingClientRect()

    if (event.pointerId === flightTouchId) {
      // Deflection from where the finger landed, not from the screen centre:
      // the thumb has nowhere near the reach for a centred stick.
      const span = Math.min(rect.width, rect.height) * 0.22
      stickX = applyDeadZone(clamp((event.clientX - flightOriginX) / span, -1, 1), deadZone)
      stickY = applyDeadZone(clamp((event.clientY - flightOriginY) / span, -1, 1), deadZone)
      pointerPlaced = true
      return
    }

    if (event.pointerId === throttleTouchId) {
      // Upward drag opens the throttle.
      throttleDelta = clamp(-(event.clientY - throttleOriginY) / (rect.height * 0.3), -1, 1)
      return
    }

    if (lookTouchIds.includes(event.pointerId)) {
      lookDx += event.movementX ?? 0
      lookDy += event.movementY ?? 0
    }
  }

  const onTouchUp = (event: PointerEvent): void => {
    if (event.pointerId === flightTouchId) {
      flightTouchId = null
      stickX = 0
      stickY = 0
    }
    if (event.pointerId === throttleTouchId) {
      throttleTouchId = null
      throttleDelta = 0
    }
    lookTouchIds = lookTouchIds.filter((id) => id !== event.pointerId)
    if (lookTouchIds.length === 0) lookActive = false
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Never swallow keys aimed at a text field.
    const target = event.target as HTMLElement | null
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

    keys.add(event.code)
    if (event.code === 'KeyO') onMatchOrbit?.()
    if (event.code === 'Space' && !event.repeat) onCruise?.()
    if (event.code === 'Slash' || (event.code === 'KeyF' && !event.repeat)) {
      onSearch?.()
      event.preventDefault()
    }
    // Stop the page scrolling under the cockpit.
    if (SWALLOWED.has(event.code)) event.preventDefault()
  }

  const onKeyUp = (event: KeyboardEvent): void => { keys.delete(event.code) }
  const onBlur = (): void => { keys.clear(); lookActive = false }
  const onContextMenu = (event: Event): void => { event.preventDefault() }

  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('pointermove', onTouchMove)
  element.addEventListener('pointerdown', onPointerDown)
  element.addEventListener('pointerup', onPointerUp)
  element.addEventListener('pointercancel', onPointerUp)
  element.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  const sample = (): ControlInput => {
    // Screen Y grows downward; pulling the stick back should pitch the nose up.
    input.pitch = -stickY
    input.yaw = -stickX
    input.roll = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) + touchRoll(keys)

    const keyThrottle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
    input.throttleRate = keyThrottle !== 0 ? keyThrottle : throttleDelta
    input.boost = keys.has('ShiftLeft') || keys.has('ShiftRight')
    input.fullStop = keys.has('KeyX')

    input.looking = lookActive
    // Radians per pixel. Free look is position-based, unlike the ship, because
    // a head does not keep turning by itself.
    input.lookYawDelta = -lookDx * 0.0022
    input.lookPitchDelta = -lookDy * 0.0022
    lookDx = 0
    lookDy = 0

    return input
  }

  return {
    sample,
    get active() { return pointerPlaced },
    get deflection() { return { x: stickX, y: stickY } },
    setSensitivity: (value) => { sensitivity = clamp(value, 0.15, 1) },
    checkReachable: () => { warnIfCovered(element) },
    dispose: () => {
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointermove', onTouchMove)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerUp)
      element.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}

/**
 * Warn if something is sitting on top of the flight controls.
 *
 * The mouse is the flight stick here, so anything covering the canvas stops
 * the ship from being steerable at all, with nothing in the console and
 * nothing visibly wrong. That is exactly what happened: the HUD is a
 * full-screen layer inside the overlay, and a blanket
 * `#overlay > * { pointer-events: auto }` outranked its own
 * `pointer-events: none` on ID specificity.
 *
 * One hit test catches the whole class of mistake, and it names the culprit.
 * It has to run after the loading screen has gone, because that covers the
 * canvas on purpose.
 */
const warnIfCovered = (element: HTMLElement): void => {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return

  const centreX = rect.left + rect.width / 2
  const centreY = rect.top + rect.height / 2
  const topmost = document.elementFromPoint(centreX, centreY)

  if (topmost === element || element.contains(topmost)) return

  const covering = topmost === null
    ? 'nothing'
    : `<${topmost.tagName.toLowerCase()} class="${topmost.className}">`
  console.warn(
    `Flight controls are covered: the pointer at the centre of the viewport ` +
    `hits ${covering} rather than the canvas. The ship will not steer. ` +
    `Something in the overlay needs pointer-events: none.`,
  )
}

/** On-screen roll buttons set these, so touch and keyboard share one path. */
export const touchRollState = { left: false, right: false }
const touchRoll = (_keys: Set<string>): number =>
  (touchRollState.left ? 1 : 0) - (touchRollState.right ? 1 : 0)

/** Throttle and stop buttons for touch, driven from the HUD. */
export const touchButtonState = { fullStop: false }

const SWALLOWED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyX', 'KeyO', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
])

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * A dead zone around the centre.
 *
 * Without it the ship drifts constantly, because the cursor is never exactly
 * on the centre pixel. The remainder is rescaled so full deflection is still
 * reachable at the edge.
 */
const applyDeadZone = (v: number, zone: number): number => {
  const magnitude = Math.abs(v)
  if (magnitude <= zone) return 0
  return Math.sign(v) * ((magnitude - zone) / (1 - zone))
}
