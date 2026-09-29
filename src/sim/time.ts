/**
 * Simulation clock.
 *
 * One trap dominates this file: astronomy-engine takes a number of days since
 * J2000, not a raw Julian date. Passing a JD straight in silently yields a
 * date roughly 6700 years out, and the library's own error message points the
 * wrong way. Every conversion goes through here so that mistake can only be
 * made once.
 */

import { AstroTime, MakeTime } from 'astronomy-engine'
import { JD_J2000, JD_MAX, JD_MIN, SECONDS_PER_DAY } from './constants'

export class SimClock {
  /** Julian date (UT). Float64 throughout: 1 ms at JD 2.46e6 needs 16 digits. */
  private jd: number
  /** Simulated seconds per wall-clock second. 1 by default. */
  rate = 1
  private cached: AstroTime | null = null
  private cachedJd = Number.NaN

  constructor(date: Date = new Date()) {
    this.jd = dateToJulian(date)
  }

  get julianDate(): number { return this.jd }

  /** Clamped to the supported 1900-2100 window. */
  setJulianDate(jd: number): void {
    this.jd = Math.min(JD_MAX, Math.max(JD_MIN, jd))
    this.cached = null
  }

  setDate(date: Date): void { this.setJulianDate(dateToJulian(date)) }

  get date(): Date { return julianToDate(this.jd) }

  /** Advance by `dtSeconds` of wall clock, scaled by `rate`. */
  advance(dtSeconds: number): void {
    if (this.rate === 0) return
    this.setJulianDate(this.jd + (dtSeconds * this.rate) / SECONDS_PER_DAY)
  }

  /**
   * The AstroTime for this instant, built at most once per distinct date.
   *
   * Every ephemeris call in a frame must share this object. MakeTime evaluates
   * the delta-T polynomial, so building ten of them per frame costs more than
   * all the position maths put together.
   */
  astroTime(): AstroTime {
    if (this.cached === null || this.cachedJd !== this.jd) {
      this.cached = MakeTime(this.jd - JD_J2000)
      this.cachedJd = this.jd
    }
    return this.cached
  }
}

/** JS Date to Julian date (UT). */
export const dateToJulian = (date: Date): number =>
  date.getTime() / (SECONDS_PER_DAY * 1000) + 2440587.5

/** Julian date (UT) to JS Date. */
export const julianToDate = (jd: number): Date =>
  new Date((jd - 2440587.5) * SECONDS_PER_DAY * 1000)

/** Days since J2000, which is the number astronomy-engine actually wants. */
export const julianToJ2000Days = (jd: number): number => jd - JD_J2000
