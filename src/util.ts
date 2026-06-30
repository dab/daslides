/** Tiny shared math/random helpers used across the engine and scenes. */

export const TAU = Math.PI * 2;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smoothstep eased 0..1 (clamps out-of-range input). */
export const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));

export const rand = () => Math.random();

export const rndRange = (a: number, b: number) => a + Math.random() * (b - a);
