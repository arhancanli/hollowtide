import { dexp } from './detmath.js';
export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Squared distance — use in hot loops to avoid the sqrt. */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is roughly "how much of the gap is closed per second".
 */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return lerp(a, b, 1 - dexp(-rate * dt));
}
