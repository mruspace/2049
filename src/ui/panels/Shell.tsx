/**
 * The panel layer.
 *
 * React lives here and nowhere else. Every component in this file mounts,
 * unmounts, or re-renders because a person did something: opened a sheet,
 * typed in the search box, moved a slider. None of them subscribe to ship
 * state, and none of them render inside the frame loop. The live readouts are
 * plain DOM written imperatively in ui/live/hud.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { App } from '../../app'
import { JD_MAX, JD_MIN } from '../../sim/constants'
import { dateToJulian, julianToDate } from '../../sim/time'
import { buildSearchIndex, type SearchEntry, type SearchIndex } from '../search'
import { skyTarget } from '../../sim/targeting'
import { touchRollState } from '../../input/controls'
import { Credits } from './Credits'
import { Settings } from './Settings'

type Sheet = 'none' | 'search' | 'date' | 'settings' | 'credits'

export const Shell = ({ app }: { app: App }): React.ReactElement => {
  const [sheet, setSheet] = useState<Sheet>('none')
  const [index, setIndex] = useState<SearchIndex | null>(null)

  useEffect(() => {
    let cancelled = false
    void buildSearchIndex(app.starNames).then((built) => {
      if (!cancelled) setIndex(built)
    })
    return () => { cancelled = true }
  }, [app.starNames])

  // The keyboard handler lives in the input layer, which cannot import React.
  // It raises an event on the overlay instead, and this is the other end.
  useEffect(() => {
    const open = (): void => { setSheet('search') }
    const overlay = document.getElementById('overlay')
    overlay?.addEventListener('mru:search', open)
    return () => { overlay?.removeEventListener('mru:search', open) }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSheet('none')
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const close = useCallback(() => { setSheet('none') }, [])

  return (
    <>
      <div className="toolbar">
        <button
          className="chip" aria-pressed={sheet === 'search'}
          onClick={() => { setSheet(sheet === 'search' ? 'none' : 'search') }}
        >
          Find
        </button>
        <button
          className="chip" aria-pressed={sheet === 'date'}
          onClick={() => { setSheet(sheet === 'date' ? 'none' : 'date') }}
        >
          Date
        </button>
        <button
          className="chip" aria-pressed={sheet === 'settings'}
          onClick={() => { setSheet(sheet === 'settings' ? 'none' : 'settings') }}
        >
          View
        </button>
        <button
          className="chip" aria-pressed={sheet === 'credits'}
          onClick={() => { setSheet(sheet === 'credits' ? 'none' : 'credits') }}
        >
          Credits
        </button>
      </div>

      {sheet === 'search' && index !== null && (
        <Search app={app} index={index} onClose={close} />
      )}
      {sheet === 'date' && <DateSheet app={app} onClose={close} />}
      {sheet === 'settings' && <Settings app={app} onClose={close} />}
      {sheet === 'credits' && <Credits onClose={close} />}

      {app.profile.touch && <TouchControls app={app} />}
      {!app.profile.touch && sheet === 'none' && <HelpHint />}
    </>
  )
}

const HelpHint = (): React.ReactElement => {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    // It is a hint, not a manual. Long enough to read once.
    const timer = setTimeout(() => { setVisible(false) }, 14000)
    return () => { clearTimeout(timer) }
  }, [])
  if (!visible) return <></>
  return (
    <div className="help">
      Move the mouse off centre to steer, and hold it there: the ship keeps turning.<br />
      Pick something with <b>F</b>, then press <b>Space</b> for full throttle.
      The ship slows itself down as it arrives.<br />
      <b>W</b> / <b>S</b> throttle · <b>Shift</b> faster · <b>A</b> / <b>D</b> roll ·
      <b>X</b> stop · <b>O</b> orbit · right-drag to look around
    </div>
  )
}

const Search = ({ app, index, onClose }: {
  app: App
  index: SearchIndex
  onClose: () => void
}): React.ReactElement => {
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchEntry[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    void index.query(text).then((found) => {
      if (cancelled) return
      setResults(found)
      setActive(0)
    })
    return () => { cancelled = true }
  }, [text, index])

  const choose = useCallback((entry: SearchEntry) => {
    if (entry.kind === 'body') {
      app.setTarget(app.bodyTargetFor(entry.key))
    } else if (entry.kind === 'star') {
      app.setTarget(app.starTargetFor(Number(entry.key)))
    } else {
      const object = index.messier.get(entry.key)
      if (object !== undefined && object.pc !== undefined) {
        app.setTarget(skyTarget(
          object.id, object.name ?? object.id, object.type, object.ra, object.dec, object.pc,
        ))
      }
    }
    onClose()
  }, [app, index, onClose])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      setActive((a) => Math.min(results.length - 1, a + 1))
      event.preventDefault()
    } else if (event.key === 'ArrowUp') {
      setActive((a) => Math.max(0, a - 1))
      event.preventDefault()
    } else if (event.key === 'Enter') {
      const entry = results[active]
      if (entry !== undefined) choose(entry)
    }
  }

  return (
    <div className="panel sheet" role="dialog" aria-label="Find an object">
      <div className="sheet-head">
        <input
          ref={inputRef}
          className="search"
          placeholder="Betelgeuse, Alp CMa, HD 48915, M31, Saturn"
          value={text}
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="chip" onClick={onClose}>Close</button>
      </div>
      <div className="sheet-body">
        {results.length === 0 && (
          <div className="field-note">
            Nothing matched. Try a proper name, a Bayer designation like
            {' '}<code>Alp CMa</code>, a catalogue number like <code>HD 48915</code>,
            a Messier number, or a planet.
          </div>
        )}
        {results.map((entry, i) => (
          <button
            key={`${entry.kind}:${entry.key}`}
            className="result"
            data-active={i === active}
            onClick={() => { choose(entry) }}
            onMouseEnter={() => { setActive(i) }}
          >
            <span className="result-name">{entry.label}</span>
            <span className="result-kind">{entry.detail}</span>
            {entry.magnitude !== undefined && (
              <span className="result-mag">mag {entry.magnitude.toFixed(2)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Date control.
 *
 * One of the few things that rewards a return visit: the planets are somewhere
 * else, and the alignment is correct for whatever date is set. The range is
 * 1900 to 2100, which is where the ephemeris is trustworthy.
 */
const DateSheet = ({ app, onClose }: { app: App; onClose: () => void }): React.ReactElement => {
  const initial = useMemo(() => julianToDate(app.store.live.julianDate), [app.store.live.julianDate])
  const [day, setDay] = useState(initial.toISOString().slice(0, 10))
  const [time, setTime] = useState(initial.toISOString().slice(11, 16))

  const apply = (nextDay: string, nextTime: string): void => {
    const parsed = new Date(`${nextDay}T${nextTime || '00:00'}:00Z`)
    if (Number.isNaN(parsed.getTime())) return
    const jd = dateToJulian(parsed)
    if (jd < JD_MIN || jd > JD_MAX) return
    app.setJulianDate(jd)
  }

  return (
    <div className="panel sheet" role="dialog" aria-label="Simulation date">
      <div className="sheet-head">
        <span className="sheet-title">Simulation date</span>
        <button className="chip" onClick={onClose}>Close</button>
      </div>
      <div className="sheet-body">
        <div className="field">
          <label htmlFor="sim-day">Date (UTC)</label>
          <input
            id="sim-day" type="date" value={day} min="1900-01-01" max="2099-12-31"
            onChange={(event) => { setDay(event.target.value); apply(event.target.value, time) }}
          />
        </div>
        <div className="field">
          <label htmlFor="sim-time">Time (UTC)</label>
          <input
            id="sim-time" type="time" value={time}
            onChange={(event) => { setTime(event.target.value); apply(day, event.target.value) }}
          />
        </div>
        <div className="segmented">
          <button className="chip" onClick={() => {
            const now = new Date()
            setDay(now.toISOString().slice(0, 10))
            setTime(now.toISOString().slice(11, 16))
            app.setJulianDate(dateToJulian(now))
          }}>Now</button>
          <button className="chip" onClick={() => { shift(app, setDay, setTime, 365.25) }}>+1 year</button>
          <button className="chip" onClick={() => { shift(app, setDay, setTime, -365.25) }}>−1 year</button>
        </div>
        <p className="field-note">
          Planet positions come from VSOP87 through astronomy-engine and are good
          to about an arcminute anywhere between 1900 and 2100. Change the date
          and the whole solar system rearranges: outer-planet alignments shift
          over years, the Galilean moons over hours.
        </p>
      </div>
    </div>
  )
}

const shift = (
  app: App,
  setDay: (value: string) => void,
  setTime: (value: string) => void,
  days: number,
): void => {
  const next = julianToDate(app.store.live.julianDate + days)
  const jd = dateToJulian(next)
  if (jd < JD_MIN || jd > JD_MAX) return
  app.setJulianDate(jd)
  setDay(next.toISOString().slice(0, 10))
  setTime(next.toISOString().slice(11, 16))
}

/**
 * Touch controls.
 *
 * Pitch and yaw come from dragging the left side of the screen and the
 * throttle from the right edge strip; both are handled in the input layer.
 * What is left needs real buttons, because roll and a full stop are discrete.
 */
const TouchControls = ({ app }: { app: App }): React.ReactElement => {
  const hold = (side: 'left' | 'right') => ({
    onPointerDown: () => { touchRollState[side] = true },
    onPointerUp: () => { touchRollState[side] = false },
    onPointerLeave: () => { touchRollState[side] = false },
    onPointerCancel: () => { touchRollState[side] = false },
  })

  return (
    <div className="touch">
      <div className="touch-throttle">throttle · drag</div>
      <button className="touch-roll-left" aria-label="Roll left" {...hold('left')}>↺</button>
      <button className="touch-roll-right" aria-label="Roll right" {...hold('right')}>↻</button>
      <button
        className="touch-stop" aria-label="Full stop"
        onPointerDown={() => { app.store.live.throttle = 0; fullStop(app) }}
      >
        ■
      </button>
    </div>
  )
}

const fullStop = (app: App): void => {
  // Routed through the same latch the keyboard uses, so there is one code path.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }))
  setTimeout(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX' })) }, 120)
  void app
}
