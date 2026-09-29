/**
 * The live HUD layer.
 *
 * Plain DOM, written imperatively. No React anywhere in this file, and nothing
 * here allocates per frame.
 *
 * Two update rates, on purpose:
 *   - numeric readouts at 10 Hz. Any faster and the digits are unreadable
 *     anyway, and it keeps the layout work off most frames.
 *   - the reticle and the off-target arrow every frame, because at 10 Hz they
 *     visibly lag behind the view while turning, which is exactly when they
 *     matter.
 *
 * All of it is a screen-space overlay rather than geometry on the cockpit
 * panels. The panels are emissive at real luminance, so they wash out as soon
 * as auto-exposure adapts to a sunlit planet. Speed, target and distance have
 * to stay legible in every lighting condition, so they cannot live there.
 */

import { C, LIGHT_YEAR } from '../../sim/constants'
import { formatDistance, formatDuration, formatSpeed } from '../../sim/units'
import { speedToThrottle } from '../../sim/throttle'
import type { Store } from '../store'

/** Numeric readouts refresh at this interval, in milliseconds. */
const READOUT_INTERVAL = 100

export interface LiveHud {
  /** Call every frame. */
  update: (now: number) => void
  dispose: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text = '',
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== '') node.textContent = text
  return node
}

export const createLiveHud = (root: HTMLElement, store: Store): LiveHud => {
  const layer = el('div', 'hud')

  // Speed block, bottom left.
  const speedBlock = el('div', 'hud-block hud-speed')
  const speedValue = el('div', 'hud-value', '0.0')
  const speedUnit = el('div', 'hud-unit', 'm/s')
  const speedLabel = el('div', 'hud-label', 'speed')
  const throttleTrack = el('div', 'hud-throttle')
  const throttleFill = el('div', 'hud-throttle-fill')
  const throttleLimit = el('div', 'hud-throttle-limit')
  throttleTrack.append(throttleFill, throttleLimit)

  // Scale marks on the throttle.
  //
  // The control is logarithmic over nineteen decades, so a bare fill bar tells
  // you nothing useful: a quarter of the way along is 137 km/s, which is three
  // weeks to Mars, and it looks like a quarter of the way to fast. These put
  // the decades where you can see them, so the bottom of the bar reads as the
  // bottom of the range rather than as a reasonable cruise.
  const SCALE: [number, string][] = [
    [1e3, 'km/s'],
    [1e6, 'Mm/s'],
    [C, 'c'],
    [1000 * C, '10³c'],
    [LIGHT_YEAR, 'ly/s'],
  ]
  const scaleRow = el('div', 'hud-throttle-scale')
  for (const [speed, label] of SCALE) {
    const position = speedToThrottle(speed) * 100
    const tick = el('div', 'hud-throttle-tick')
    tick.style.left = `${position.toFixed(2)}%`
    throttleTrack.append(tick)

    const caption = el('div', 'hud-throttle-label', label)
    caption.style.left = `${position.toFixed(2)}%`
    scaleRow.append(caption)
  }
  const speedRow = el('div', 'hud-row')
  speedRow.append(speedValue, speedUnit)
  speedBlock.append(speedLabel, speedRow, throttleTrack, scaleRow)

  // Target block, bottom right.
  const targetBlock = el('div', 'hud-block hud-target')
  const targetLabel = el('div', 'hud-label', 'target')
  const targetName = el('div', 'hud-name', 'none')
  const targetDetail = el('div', 'hud-detail', '')
  const targetDistance = el('div', 'hud-line', '')
  const targetEta = el('div', 'hud-line', '')
  targetBlock.append(targetLabel, targetName, targetDetail, targetDistance, targetEta)

  // Proximity notice, centre top. Only present when it applies.
  const notice = el('div', 'hud-notice')

  // Reticle and the off-screen direction arrow.
  const reticle = el('div', 'hud-reticle')
  const arrow = el('div', 'hud-arrow')
  const marker = el('div', 'hud-marker')

  const dateLine = el('div', 'hud-date', '')

  layer.append(reticle, marker, arrow, notice, speedBlock, targetBlock, dateLine)
  root.append(layer)

  let lastReadout = 0
  let frames = 0
  let fpsWindowStart = 0

  // Cached so the per-frame arrow placement never reads layout.
  let halfWidth = window.innerWidth / 2
  let halfHeight = window.innerHeight / 2
  const onResize = (): void => {
    halfWidth = window.innerWidth / 2
    halfHeight = window.innerHeight / 2
  }
  window.addEventListener('resize', onResize)

  const update = (now: number): void => {
    const live = store.live

    frames++
    if (now - fpsWindowStart >= 500) {
      live.fps = (frames * 1000) / (now - fpsWindowStart)
      frames = 0
      fpsWindowStart = now
    }

    // Per frame: the marker and the arrow. These track the view, so 10 Hz
    // would visibly lag behind it exactly when they matter.
    if (live.target !== null && live.targetOnScreen) {
      marker.style.display = 'block'
      marker.style.transform =
        `translate(${(live.targetScreenX * 0.5 + 0.5) * 100}vw, ` +
        `${(live.targetScreenY * -0.5 + 0.5) * 100}vh) translate(-50%, -50%)`
      arrow.style.display = 'none'
    } else if (live.target !== null) {
      marker.style.display = 'none'
      arrow.style.display = 'block'

      // Placed on an ellipse inset from the frame, so it hugs the edge the
      // target is actually off rather than sitting on a circle that leaves a
      // wide gap on a letterboxed screen.
      //
      // The bearing comes from camera space. Taking it from the projected
      // position instead looks equivalent and is not: behind the camera the
      // perspective divide flips sign, and the arrow wanders around the screen
      // as the ship turns away from its target.
      const angle = live.targetAngle
      const x = halfWidth + Math.cos(angle) * halfWidth * 0.84
      // Screen y grows downward, so the bearing's y is negated.
      const y = halfHeight - Math.sin(angle) * halfHeight * 0.8
      // The glyph points up, so it needs a further quarter turn to face along
      // the bearing. CSS rotates clockwise, hence the sign.
      arrow.style.transform =
        `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ` +
        `translate(-50%, -50%) rotate(${(Math.PI / 2 - angle).toFixed(4)}rad)`
    } else {
      marker.style.display = 'none'
      arrow.style.display = 'none'
    }

    if (now - lastReadout < READOUT_INTERVAL) return
    lastReadout = now

    const speed = formatSpeed(live.speed)
    speedValue.textContent = speed.text.slice(0, speed.text.indexOf(' '))
    speedUnit.textContent = speed.unit

    throttleFill.style.width = `${(live.throttle * 100).toFixed(1)}%`
    // Where the proximity clamp currently cuts the throttle off. Showing it
    // explains why opening the throttle further does nothing.
    if (live.clamped) {
      throttleLimit.style.display = 'block'
      throttleLimit.style.left = `${(speedToThrottle(live.speed) * 100).toFixed(1)}%`
    } else {
      throttleLimit.style.display = 'none'
    }

    if (live.target === null) {
      targetName.textContent = 'none'
      targetDetail.textContent = 'click an object, or press F to search'
      targetDistance.textContent = ''
      targetEta.textContent = ''
    } else {
      targetName.textContent = live.target.name
      targetDetail.textContent = live.target.detail ?? ''
      targetDistance.textContent = formatDistance(live.targetSurfaceDistance).text
      targetEta.textContent = Number.isFinite(live.targetEta)
        ? `${formatDuration(live.targetEta).text} at this speed`
        : 'stopped'
    }

    if (live.arrivedAt !== '' && live.throttle === 0) {
      notice.textContent = `arrived at ${live.arrivedAt}`
      notice.style.display = 'block'
    } else if (live.clamped && live.limitingName !== '') {
      notice.textContent = `slowing for ${live.limitingName}`
      notice.style.display = 'block'
    } else if (live.attachedTo !== null && live.nearestName !== '' && live.throttle === 0) {
      // Only while actually parked. Saying "holding station with Earth" at
      // 137 km/s with the throttle open reads as though the ship is going
      // nowhere, which was exactly the wrong thing to tell someone whose real
      // problem was that the throttle was too low.
      notice.textContent = `holding station with ${live.nearestName}`
      notice.style.display = 'block'
    } else {
      notice.style.display = 'none'
    }

    dateLine.textContent = live.dateText
  }

  return {
    update,
    dispose: () => {
      window.removeEventListener('resize', onResize)
      layer.remove()
    },
  }
}
