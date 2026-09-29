/**
 * Entry point.
 *
 * Starts the renderer and the frame loop first, then mounts the panel layer.
 * The order matters: the panels need the app to exist, and the app is what
 * decides whether the browser can run this at all.
 */

import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { startApp, type App } from './app'
import { Shell } from './ui/panels/Shell'
import type { LoadPhase } from './ui/store'
import './ui/styles.css'

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null
const overlay = document.getElementById('overlay')

if (canvas === null || overlay === null) {
  throw new Error('The page is missing #viewport or #overlay')
}

const loader = document.createElement('div')
loader.className = 'loader'
loader.innerHTML = `
  <h1>MRU 2049</h1>
  <p id="loader-message">starting</p>
  <div class="bar"><span></span></div>
`
overlay.append(loader)
const loaderMessage = document.getElementById('loader-message')

const onPhase = (phase: LoadPhase, message: string): void => {
  if (phase === 'ready') {
    loader.remove()
    return
  }
  if (loaderMessage !== null) loaderMessage.textContent = message
  if (phase === 'failed') {
    loader.querySelector('.bar')?.remove()
    if (loaderMessage !== null) loaderMessage.style.whiteSpace = 'pre-wrap'
  }
}

let root: Root | null = null

void startApp(canvas, overlay, onPhase)
  .then((app: App) => {
    const host = document.createElement('div')
    overlay.append(host)
    root = createRoot(host)
    root.render(<StrictMode><Shell app={app} /></StrictMode>)

    // Handy in the console, and the only global this project defines.
    ;(window as unknown as { mru: App }).mru = app
  })
  .catch((err: unknown) => {
    console.error(err)
    onPhase('failed', err instanceof Error ? err.message : String(err))
  })
