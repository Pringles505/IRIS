import { describe, expect, it } from 'vitest';
import { computeManualTokenTimingByLinkId, getManualTokenTextAtTime, getManualTokenTextFadeAtTime } from './manualTokenTiming';

const timeline = [{ type: 'link', id: 'l1', start: 0, duration: 1 }];
const link = (overrides = {}) => ({ id: 'l1', fromId: 'a', toId: 'b', manualTokenEnabled: true, ...overrides });

describe('manual token text', () => {
  it('starts blank when the token has no value or message', () => {
    const track = computeManualTokenTimingByLinkId([link()], timeline).l1;
    expect(getManualTokenTextAtTime(track, 0.5)).toBe('');
  });

  it('does not fall back to the token name', () => {
    const track = computeManualTokenTimingByLinkId([link({ manualTokenVariableName: 'Key' })], timeline).l1;
    expect(getManualTokenTextAtTime(track, 0.5)).toBe('');
  });

  it('uses the value, then switches at text keyframes', () => {
    const track = computeManualTokenTimingByLinkId([link({
      manualTokenVariableValue: 'K1',
      manualTokenTextKeyframes: [{ id: 'k', time: 0.6, text: 'K2' }],
    })], timeline).l1;
    expect(getManualTokenTextAtTime(track, 0.5)).toBe('K1');
    expect(getManualTokenTextAtTime(track, 0.7)).toBe('K2');
  });
});

describe('manual token text fade', () => {
  const track = computeManualTokenTimingByLinkId([link({
    manualTokenVariableValue: 'K1',
    manualTokenTextKeyframes: [{ id: 'k', time: 0.6, text: 'K2' }],
  })], timeline).l1;

  it('fades the old text out just before a text key', () => {
    const state = getManualTokenTextFadeAtTime(track, 0.55);
    expect(state.text).toBe('K1');
    expect(state.opacity).toBeGreaterThan(0);
    expect(state.opacity).toBeLessThan(1);
  });

  it('fades the new text in just after it', () => {
    const state = getManualTokenTextFadeAtTime(track, 0.65);
    expect(state.text).toBe('K2');
    expect(state.opacity).toBeGreaterThan(0);
    expect(state.opacity).toBeLessThan(1);
  });

  it('is fully visible away from text keys', () => {
    expect(getManualTokenTextFadeAtTime(track, 0.2).opacity).toBe(1);
    expect(getManualTokenTextFadeAtTime(track, 0.9).opacity).toBe(1);
  });
});
