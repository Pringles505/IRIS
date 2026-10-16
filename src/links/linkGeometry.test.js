import { describe, expect, it } from 'vitest';
import { getLinkAnchorPoints, getNodeAnchorPoint } from './linkGeometry';

const node = (id, x, overrides = {}) => ({ id, x, y: 0, width: 100, height: 50, ...overrides });

describe('exact anchors', () => {
  it('places an exact anchor at its fraction of the node box', () => {
    expect(getNodeAnchorPoint(node('a', 10), { side: 'top', posX: 0.25, posY: 0.5 })).toEqual({ x: 35, y: 25 });
  });

  it('attaches links to the nearest custom anchor when defaults are replaced', () => {
    const a = node('a', 0, {
      customAnchorsOnly: true,
      anchors: [
        { id: 'bottom', side: 'bottom', along: 0, posX: 0.5, posY: 1 },
        { id: 'left', side: 'left', along: 0, posX: 0, posY: 0.5 },
      ],
    });
    const b = node('b', 300, { y: 200 });
    const link = { id: 'l', fromId: 'a', toId: 'b', joints: [] };
    const { start } = getLinkAnchorPoints(link, a, b, [link], [a, b]);
    expect(start.x).toBeCloseTo(50);
    expect(start.y).toBeCloseTo(50);
  });
});
