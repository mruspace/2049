/**
 * Short names for the TSL node types.
 *
 * TSL nodes are typed by a string literal (`Node<'float'>`, `Node<'vec3'>`),
 * and the operator methods only exist on the literal form. Writing them out at
 * every signature buries the intent, and leaving them off silently degrades to
 * `Node<string>`, which has no operators at all and fails far from the cause.
 */

import type { Node } from 'three/webgpu'

export type FloatNode = Node<'float'>
export type Vec2Node = Node<'vec2'>
export type Vec3Node = Node<'vec3'>
export type Vec4Node = Node<'vec4'>

/** A `uniform(float(...))` handle: a node whose `.value` can be written. */
export type FloatUniform = FloatNode & { value: number }

/** A `uniform(vec3(...))` handle. Its value is a Vector3. */
export type Vec3Uniform = Vec3Node & { value: { set: (x: number, y: number, z: number) => unknown } }
