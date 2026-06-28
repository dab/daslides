import { fadeZoom } from './fadeZoom.ts';
import { kenBurns } from './kenBurns.ts';
import { vintage } from './vintage.ts';
import type { TransitionDef, TransitionId } from './types.ts';

export const TRANSITIONS: Record<TransitionId, TransitionDef> = {
  fadeZoom,
  kenBurns,
  vintage,
};

export type { TransitionDef, TransitionId };
