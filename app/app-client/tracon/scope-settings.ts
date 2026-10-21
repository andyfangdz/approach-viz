// STARS display-control-bar values for the TRACON scope: defaults and the
// spinner steps. Kept free of React and the DOM for unit tests.

import type { TraconScopeSettings } from '../types';
import { SCOPE_WX_LEVEL_COUNT, scopeWxLevel } from '@/app/scene/tracon/scope-weather';
import { SCOPE_MAX_HISTORY_DOTS } from '@/app/scene/traffic/traffic-draw-buffers';

/** STARS RANGE limits. */
export const MIN_SCOPE_RANGE_NM = 5;
export const MAX_SCOPE_RANGE_NM = 400;
/** RR values; 0 turns the rings off. */
export const RING_SPACING_STEPS_NM = [0, 2, 5, 10, 20] as const;
export const PTL_STEP_MINUTES = 0.5;
export const MAX_PTL_MINUTES = 5;

export function defaultScopeSettings(rangeNm: number): TraconScopeSettings {
  return {
    rangeNm: clampRange(rangeNm),
    ringSpacingNm: 10,
    // Class C/D rings clutter a facility-wide scope; they are one button away.
    maps: { shoreline: true, runways: true, finals: true, classB: true, classCD: false },
    wxLevels: Array.from({ length: SCOPE_WX_LEVEL_COUNT }, () => true),
    historyDotCount: 5,
    ptlMinutes: 1,
    ptlAll: false
  };
}

export function clampRange(rangeNm: number): number {
  if (!Number.isFinite(rangeNm)) return MIN_SCOPE_RANGE_NM;
  return Math.max(MIN_SCOPE_RANGE_NM, Math.min(MAX_SCOPE_RANGE_NM, Math.round(rangeNm)));
}

/** Next value along `steps` in direction `delta` (+1/-1), clamped at the ends. */
export function stepThrough(steps: readonly number[], current: number, delta: number): number {
  let index = 0;
  for (let i = 1; i < steps.length; i += 1) {
    if (Math.abs(steps[i] - current) < Math.abs(steps[index] - current)) index = i;
  }
  const next = Math.max(0, Math.min(steps.length - 1, index + Math.sign(delta)));
  return steps[next];
}

export function stepHistory(current: number, delta: number): number {
  return Math.max(0, Math.min(SCOPE_MAX_HISTORY_DOTS, current + Math.sign(delta)));
}

export function stepPtl(current: number, delta: number): number {
  const next = current + Math.sign(delta) * PTL_STEP_MINUTES;
  return Math.max(PTL_STEP_MINUTES, Math.min(MAX_PTL_MINUTES, next));
}

/** Weather levels present in the current data, from its strongest echo. */
export function availableWxLevels(maxDbz: number | null): number {
  return maxDbz === null ? 0 : scopeWxLevel(maxDbz);
}
