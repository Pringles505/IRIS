import { describe, expect, it } from 'vitest';
import { customShapeFromBase, getCustomShapeOutline, normalizeCustomShape } from './customShape';

const square = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], rounding: 0 };

describe('custom shapes', () => {
  it('rejects outlines with fewer than three points', () => {
    expect(normalizeCustomShape({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBeNull();
    expect(getCustomShapeOutline({ points: [] }, 100, 50)).toBeNull();
  });

  it('clamps points into the node bounds', () => {
    const shape = normalizeCustomShape({ points: [{ x: -1, y: 0 }, { x: 2, y: 0.5 }, { x: 0.5, y: 3 }] });
    expect(shape.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }]);
  });

  it('scales points to the node size', () => {
    expect(getCustomShapeOutline(square, 200, 80)).toEqual([0, 0, 200, 0, 200, 80, 0, 80]);
  });

  it('rounds corners without leaving the bounding box', () => {
    const outline = getCustomShapeOutline({ ...square, rounding: 1 }, 200, 80);
    expect(outline.length).toBeGreaterThan(8);
    for (let i = 0; i < outline.length; i += 2) {
      expect(outline[i]).toBeGreaterThanOrEqual(0);
      expect(outline[i]).toBeLessThanOrEqual(200);
      expect(outline[i + 1]).toBeGreaterThanOrEqual(0);
      expect(outline[i + 1]).toBeLessThanOrEqual(80);
    }
    // The sharp corner itself is cut away.
    expect(outline.slice(0, 2)).not.toEqual([0, 0]);
  });

  it('builds a valid editable outline from every base shape', () => {
    for (const base of ['rectangle', 'rounded', 'pill', 'cylinder', 'database', 'diamond', 'hexagon', 'slanted', 'circle', 'protocol']) {
      expect(normalizeCustomShape(customShapeFromBase(base, 150, 52))).not.toBeNull();
    }
  });
});

import { anchorAtPosition, getAnchorPosition, projectOntoOutline } from './customShape';

describe('custom shape anchors', () => {
  it('projects a point onto the nearest edge of the outline', () => {
    const outline = [0, 0, 100, 0, 100, 50, 0, 50];
    expect(projectOntoOutline(outline, 40, 10)).toEqual({ x: 40, y: 0 });
    expect(projectOntoOutline(outline, 95, 25)).toEqual({ x: 100, y: 25 });
  });

  it('keeps side/along in sync with an exact position', () => {
    expect(anchorAtPosition(0.75, 0, 200, 80)).toEqual({ side: 'top', along: 50, posX: 0.75, posY: 0 });
    expect(anchorAtPosition(1, 0.25, 200, 80)).toMatchObject({ side: 'right', along: -20 });
  });

  it('reads the position of side-based and exact anchors', () => {
    expect(getAnchorPosition({ side: 'bottom', along: 50 }, 200, 80)).toEqual({ x: 0.75, y: 1 });
    expect(getAnchorPosition({ side: 'top', posX: 0.3, posY: 0.2 }, 200, 80)).toEqual({ x: 0.3, y: 0.2 });
  });
});
