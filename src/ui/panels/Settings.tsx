/**
 * View settings.
 *
 * The star brightness control is the one that matters, and it is deliberately
 * presented as a choice rather than buried as a constant.
 *
 * A fully accurate star field gives a sparse sky. That is what the real one
 * looks like from a dark site, and on a bright screen in a lit room most of it
 * simply is not there. "Enhanced" compresses the magnitude range toward the
 * reference magnitude, which lifts faint stars without moving the bright ones.
 * Positions, colours and relative order stay exactly as catalogued; only the
 * contrast of the brightness scale changes. Labelling it is the honest way to
 * offer it.
 */

import { useState } from 'react'
import type { App } from '../../app'

export const Settings = ({ app, onClose }: { app: App; onClose: () => void }): React.ReactElement => {
  const [preset, setPreset] = useState(app.store.settings.starPreset)
  // The gain is derived from a real surface brightness and is a very small
  // number, so the slider works in multiples of it rather than in absolutes.
  const milkyWayDefault = useState(app.store.settings.milkyWayBrightness)[0]
  const [milkyWay, setMilkyWay] = useState(1)
  const [instruments, setInstruments] = useState(app.store.settings.instrumentBrightness)
  const [sensitivity, setSensitivity] = useState(app.store.settings.mouseSensitivity)
  const [diagnostics, setDiagnostics] = useState(app.store.settings.showDiagnostics)
  const [align, setAlign] = useState(app.store.settings.alignToTarget)

  return (
    <div className="panel sheet" role="dialog" aria-label="View settings">
      <div className="sheet-head">
        <span className="sheet-title">View</span>
        <button className="chip" onClick={onClose}>Close</button>
      </div>
      <div className="sheet-body">
        <div className="field"><label>Star brightness</label></div>
        <div className="segmented">
          <button
            className="chip" aria-pressed={preset === 'realistic'}
            onClick={() => { setPreset('realistic'); app.applyStarPreset('realistic') }}
          >
            Realistic
          </button>
          <button
            className="chip" aria-pressed={preset === 'enhanced'}
            onClick={() => { setPreset('enhanced'); app.applyStarPreset('enhanced') }}
          >
            Enhanced
          </button>
        </div>
        <p className="field-note">
          Realistic uses the true magnitude scale: a magnitude difference of one
          is a factor of 2.51 in brightness. It gives a sparse sky, because the
          real one is sparse. Enhanced compresses that scale so faint stars come
          up while the bright ones stay put. Nothing moves and no colour
          changes either way.
        </p>

        <div className="field">
          <label htmlFor="milkyway">Milky Way</label>
          <input
            id="milkyway" type="range" min={0} max={3} step={0.05} value={milkyWay}
            onChange={(event) => {
              const value = Number(event.target.value)
              setMilkyWay(value)
              app.setMilkyWayBrightness(milkyWayDefault * value)
            }}
          />
        </div>
        <p className="field-note">
          The band's real surface brightness is about 20.5 magnitudes per
          square arcsecond, which on a display is very nearly invisible: a
          dark-adapted eye integrates it over a huge area and a screen cannot.
          The default already lifts it nine-fold. 1 is that default, 0 turns it
          off entirely.
        </p>

        <div className="field">
          <label htmlFor="instruments">Instrument panels</label>
          <input
            id="instruments" type="range" min={0} max={0.02} step={0.0005} value={instruments}
            onChange={(event) => {
              const value = Number(event.target.value)
              setInstruments(value)
              app.setInstrumentBrightness(value)
            }}
          />
        </div>
        <p className="field-note">
          The panels are emissive at a real luminance, so they wash out once
          auto-exposure adapts to a sunlit planet. That is why the speed and
          target readouts are a screen overlay rather than gauges on the
          console.
        </p>

        <div className="field">
          <label htmlFor="sensitivity">Steering sensitivity</label>
          <input
            id="sensitivity" type="range" min={0.2} max={1} step={0.05} value={sensitivity}
            onChange={(event) => {
              const value = Number(event.target.value)
              setSensitivity(value)
              app.setMouseSensitivity(value)
            }}
          />
        </div>
        <p className="field-note">
          How far the pointer has to leave the centre for full deflection.
          Lower is twitchier.
        </p>

        <div className="field">
          <label htmlFor="align">Steer toward target</label>
          <input
            id="align" type="checkbox" checked={align}
            onChange={(event) => {
              setAlign(event.target.checked)
              app.store.settings.alignToTarget = event.target.checked
              app.store.notify()
            }}
          />
        </div>
        <p className="field-note">
          Turns the ship onto its target whenever you are not steering, so the
          throttle is all an arrival needs. Any movement of the pointer
          overrides it at once. Off means flying the intercept yourself, and a
          heading one degree out at 1.75 AU misses Mars by 4.6 million
          kilometres.
        </p>

        <div className="field">
          <label htmlFor="diagnostics">Show diagnostics</label>
          <input
            id="diagnostics" type="checkbox" checked={diagnostics}
            onChange={(event) => {
              setDiagnostics(event.target.checked)
              app.store.settings.showDiagnostics = event.target.checked
              app.store.notify()
            }}
          />
        </div>

        {diagnostics && (
          <p className="field-note">
            Backend <b>{app.store.backend}</b>
            {' · '}reverse-Z {app.store.reverseZActive ? 'active' : 'inactive'}
            {' · '}tier <b>{app.profile.tier}</b> ({app.profile.reason})
            {' · '}textures {app.profile.textureTier}px
            {' · '}TAA {app.profile.taa ? 'on' : 'off'}
            {' · '}bodies built {app.world.visuals.size}
            <br />
            Reverse-Z needs the EXT_clip_control extension on the WebGL2 path,
            which Firefox does not ship. The floating origin is what keeps the
            scene stable when it is unavailable.
          </p>
        )}
      </div>
    </div>
  )
}
