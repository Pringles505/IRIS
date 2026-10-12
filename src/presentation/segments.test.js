import { describe, expect, it } from 'vitest';
import { collectPresentationSegments } from './segments';

const node = (id, overrides = {}) => ({
  id,
  type: 'node',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  label: id,
  ...overrides,
});

describe('collectPresentationSegments', () => {
  it('produces contiguous segments covering the content in auto mode', () => {
    const nodes = [
      node('a', { animStartTime: 0, animDuration: 1 }),
      node('b', { animStartTime: 2, animDuration: 1 }),
    ];
    const segments = collectPresentationSegments(nodes, []);
    expect(segments.length).toBeGreaterThan(0);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].start).toBeCloseTo(segments[i - 1].end);
    }
    const last = segments[segments.length - 1];
    expect(last.end).toBeGreaterThanOrEqual(3); // covers node b's animation end
  });

  it('treats manual slide breaks as authoritative boundaries', () => {
    const nodes = [
      node('a', { animStartTime: 0, animDuration: 1 }),
      node('b', { animStartTime: 2, animDuration: 1 }),
      node('c', { animStartTime: 8, animDuration: 1 }),
    ];
    const segments = collectPresentationSegments(nodes, [], { slideBreaks: [2, 5] });
    expect(segments).toHaveLength(2);
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBe(2);
    expect(segments[1].start).toBe(2);
    expect(segments[1].end).toBe(5);
    // Content after the final slide break (node c) is intentionally excluded.
    expect(segments.every(s => s.end <= 5)).toBe(true);
  });

  it('drops segments shorter than a frame', () => {
    const nodes = [node('a', { animStartTime: 0, animDuration: 1 })];
    const segments = collectPresentationSegments(nodes, [], { slideBreaks: [1, 1.001] });
    for (const segment of segments) {
      expect(segment.end - segment.start).toBeGreaterThanOrEqual(1 / 60);
    }
  });

  it('labels each segment with the event that starts it', () => {
    const nodes = [node('a', { animStartTime: 0, animDuration: 1, label: 'Alice' })];
    const segments = collectPresentationSegments(nodes, []);
    expect(segments[0].title).toContain('Alice');
  });
});
