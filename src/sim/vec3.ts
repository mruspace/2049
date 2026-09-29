/**
 * Float64 vector helpers.
 *
 * Deliberately plain functions over `Float64Array`, not a class. These values
 * are metres in a heliocentric frame and routinely reach 1e12, so they must
 * never be copied into a Float32 path by accident. Keeping them as bare
 * Float64Arrays makes that boundary visible at every call site.
 */

export type Vec3 = Float64Array

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => Float64Array.of(x, y, z)

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out[0] = x; out[1] = y; out[2] = z
  return out
}

export const copy = (out: Vec3, a: Vec3): Vec3 => set(out, a[0]!, a[1]!, a[2]!)

export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!)

export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

export const scale = (out: Vec3, a: Vec3, s: number): Vec3 =>
  set(out, a[0]! * s, a[1]! * s, a[2]! * s)

/** out = a + b * s. The workhorse for integrating position by velocity. */
export const addScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a[0]! + b[0]! * s, a[1]! + b[1]! * s, a[2]! + b[2]! * s)

export const dot = (a: Vec3, b: Vec3): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out,
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!)

export const lengthOf = (a: Vec3): number => Math.hypot(a[0]!, a[1]!, a[2]!)

export const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

export const normalize = (out: Vec3, a: Vec3): Vec3 => {
  const len = lengthOf(a)
  return len === 0 ? set(out, 0, 0, 0) : scale(out, a, 1 / len)
}

/** Linear interpolation. Used for nothing in the hot path, but handy in tests. */
export const lerp = (out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 =>
  set(out,
    a[0]! + (b[0]! - a[0]!) * t,
    a[1]! + (b[1]! - a[1]!) * t,
    a[2]! + (b[2]! - a[2]!) * t)
