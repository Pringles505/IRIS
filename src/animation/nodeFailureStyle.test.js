import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_STYLE, getFailureMarkGeometry, getFailureTintStrength, getNodeFailureStyle } from './nodeFailureStyle';

const node = (failureStyle) => ({ id: 'n', width: 150, height: 52, strokeWidth: 2, failureStyle });

describe('node failure style', () => {
  it('falls back to the default look', () => {
    expect(getNodeFailureStyle(node(undefined))).toEqual(DEFAULT_FAILURE_STYLE);
  });

  it('draws two strokes for a cross, one for a slash, a ring for ban and nothing for none', () => {
    expect(getFailureMarkGeometry(node({ mark: 'x' })).lines).toHaveLength(2);
    expect(getFailureMarkGeometry(node({ mark: 'slash' })).lines).toHaveLength(1);
    const ban = getFailureMarkGeometry(node({ mark: 'ban' }));
    expect(ban.lines).toHaveLength(1);
    expect(ban.ring).toBeGreaterThan(0);
    const none = getFailureMarkGeometry(node({ mark: 'none' }));
    expect(none.lines).toHaveLength(0);
    expect(none.halo).toBeNull();
  });

  it('scales size and thickness', () => {
    const base = getFailureMarkGeometry(node({}));
    const big = getFailureMarkGeometry(node({ size: 2, thickness: 2 }));
    expect(big.size).toBeCloseTo(base.size * 2);
    expect(big.strokeWidth).toBeCloseTo(base.strokeWidth * 2);
  });

  it('disables the tint veil when tint is off', () => {
    expect(getFailureTintStrength(node({ tint: false, tintStrength: 0.5 }))).toBe(0);
    expect(getFailureTintStrength(node({ tint: true, tintStrength: 0.5 }))).toBe(0.5);
  });
});
