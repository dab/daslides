export type TransitionId = 'fadeZoom' | 'kenBurns' | 'vintage';

/**
 * Shader transitions render a single fullscreen Mesh whose fragment program
 * blends two textures via a `uProgress` uniform.
 *
 * Scene transitions render a Pixi container hierarchy (multiple Sprites, etc.)
 * — used when the effect isn't a 2-texture crossfade but a composition, like
 * the Vintage Prints pile-of-photos look.
 */
export type TransitionKind = 'shader' | 'scene';

export interface ShaderTransitionDef {
  id: TransitionId;
  label: string;
  kind: 'shader';
  /** Per-slide motion enabled? (Ken Burns mode) */
  kenBurns: boolean;
  fragment: string;
}

export interface SceneTransitionDef {
  id: TransitionId;
  label: string;
  kind: 'scene';
}

export type TransitionDef = ShaderTransitionDef | SceneTransitionDef;
