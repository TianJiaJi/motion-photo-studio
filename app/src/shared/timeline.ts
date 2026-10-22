import type { ClipSelection } from './editor.ts';

export type TrimEdge = 'start' | 'end';
export function timelineTime(clientX: number, left: number, width: number, startUs: number, endUs: number): number {
  if (![clientX, left, width].every(Number.isFinite) || width <= 0
    || ![startUs, endUs].every(Number.isSafeInteger) || startUs < 0 || endUs <= startUs) throw new Error('Invalid timeline geometry');
  const fraction = Math.max(0, Math.min(1, (clientX - left) / width));
  return Math.max(startUs, Math.min(endUs, startUs + Math.round(fraction * (endUs - startUs))));
}
export function trimSelection(clip: ClipSelection, edge: TrimEdge, value: number, durationUs: number): ClipSelection {
  if (![clip.startUs, clip.endUs, value, durationUs].every(Number.isSafeInteger)
    || durationUs <= 0 || clip.startUs < 0 || clip.endUs > durationUs || clip.endUs <= clip.startUs) throw new Error('Invalid trim selection');
  // Millisecond interaction precision, not an assertion that a physical frame exists every millisecond.
  const gap = Math.min(1000, durationUs);
  if (edge === 'start') return { startUs: Math.max(0, Math.min(value, clip.endUs - gap)), endUs: clip.endUs };
  if (edge === 'end') return { startUs: clip.startUs, endUs: Math.min(durationUs, Math.max(value, clip.startUs + gap)) };
  throw new Error('Invalid trim edge');
}
export function trimKeyValue(key: string, value: number, minimum: number, maximum: number, shift = false): number | null {
  const step = shift ? 10000 : 1000;
  if (key === 'Home') return minimum;
  if (key === 'End') return maximum;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(minimum, value - step);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(maximum, value + step);
  return null;
}
