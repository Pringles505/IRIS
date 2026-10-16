import { describe, expect, it } from 'vitest';
import { getNodeFailureOpacity, normalizeNodeFailureKeyframes } from './nodeFailureTiming';

const node = (failureKeyframes, extra = {}) => ({ id: 'n', failureKeyframes, ...extra });

describe('getNodeFailureOpacity', () => {
  const failing = node([{ id: 'f', startTime: 2, duration: 1 }]);

  it('is not failed before the keyframe starts', () => {
    expect(getNodeFailureOpacity(failing, 1.99)).toBe(0);
  });

  it('animates in across the keyframe duration instead of snapping', () => {
    const early = getNodeFailureOpacity(failing, 2.1);
    const mid = getNodeFailureOpacity(failing, 2.5);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeLessThan(1);
  });

  it('stays failed after the keyframe ends', () => {
    expect(getNodeFailureOpacity(failing, 3)).toBe(1);
    expect(getNodeFailureOpacity(failing, 10)).toBe(1);
  });

  it('is always failed for statically failing nodes', () => {
    expect(getNodeFailureOpacity(node([], { failing: true }), 0)).toBe(1);
  });
});

describe('normalizeNodeFailureKeyframes', () => {
  it('keeps only the earliest failure', () => {
    const result = normalizeNodeFailureKeyframes([
      { id: 'late', startTime: 5, duration: 1 },
      { id: 'early', startTime: 2, duration: 1 },
    ]);
    expect(result.map(k => k.id)).toEqual(['early']);
  });
});
