/**
 * Float64 quaternion helpers for ship orientation.
 *
 * The sim owns orientation because flight control is sim logic, and the sim
 * never imports three.js. The scene layer copies these four numbers into a
 * THREE.Quaternion once per frame.
 *
 * Layout is (x, y, z, w) to match three.js, so the copy is a straight read.
 */

import type { Vec3 } from './vec3'
import { set } from './vec3'

export type Quat = Float64Array

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => Float64Array.of(x, y, z, w)

export const identity = (out: Quat): Quat => {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1
  return out
}

/** out = a * b, meaning "apply b, then a" in the usual rotation convention. */
export const multiply = (out: Quat, a: Quat, b: Quat): Quat => {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

export const fromAxisAngle = (out: Quat, ax: number, ay: number, az: number, angle: number): Quat => {
  const half = angle * 0.5
  const s = Math.sin(half)
  out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(half)
  return out
}

/** Renormalise. Called every tick: small errors compound fast at 60 Hz. */
export const normalizeQuat = (out: Quat): Quat => {
  const len = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!)
  if (len === 0) return identity(out)
  const inv = 1 / len
  out[0] = out[0]! * inv; out[1] = out[1]! * inv
  out[2] = out[2]! * inv; out[3] = out[3]! * inv
  return out
}

/** Rotate a vector by a quaternion. out may alias v. */
export const rotateVec3 = (out: Vec3, q: Quat, v: Vec3): Vec3 => {
  const x = v[0]!, y = v[1]!, z = v[2]!
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!
  // t = 2 * (q.xyz X v)
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return set(out,
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx)
}

const AXIS_FORWARD = Float64Array.of(0, 0, -1)
const AXIS_UP = Float64Array.of(0, 1, 0)
const AXIS_RIGHT = Float64Array.of(1, 0, 0)

/** Ship nose direction in world space. Matches the three.js camera convention (-Z). */
export const forward = (out: Vec3, q: Quat): Vec3 => rotateVec3(out, q, AXIS_FORWARD as Vec3)
export const up = (out: Vec3, q: Quat): Vec3 => rotateVec3(out, q, AXIS_UP as Vec3)
export const right = (out: Vec3, q: Quat): Vec3 => rotateVec3(out, q, AXIS_RIGHT as Vec3)
