// Custom node shapes: a closed polygon whose vertices are stored as fractions of the
// node's width/height (so the shape stretches with the node), plus a corner-rounding
// amount. Every renderer draws the same outline from getCustomShapeOutline().

export const MIN_CUSTOM_VERTICES = 3;
const CORNER_SEGMENTS = 8;

const clamp01 = v => Math.max(0, Math.min(1, v));

export function normalizeCustomShape(customShape) {
  const points = Array.isArray(customShape?.points)
    ? customShape.points
        .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    : [];
  if (points.length < MIN_CUSTOM_VERTICES) return null;
  const rounding = Number.isFinite(customShape?.rounding) ? clamp01(customShape.rounding) : 0;
  return { points, rounding };
}

// Flat [x0, y0, x1, y1, ...] outline in node pixels, with rounded corners baked in.
export function getCustomShapeOutline(customShape, w, h) {
  const shape = normalizeCustomShape(customShape);
  if (!shape) return null;
  const pts = shape.points.map(p => ({ x: p.x * w, y: p.y * h }));
  if (shape.rounding <= 0) return pts.flatMap(p => [p.x, p.y]);

  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const dPrev = Math.hypot(prev.x - cur.x, prev.y - cur.y);
    const dNext = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = shape.rounding * Math.min(dPrev, dNext) / 2;
    if (r < 0.01 || dPrev === 0 || dNext === 0) {
      out.push(cur.x, cur.y);
      continue;
    }
    const a = { x: cur.x + (prev.x - cur.x) / dPrev * r, y: cur.y + (prev.y - cur.y) / dPrev * r };
    const b = { x: cur.x + (next.x - cur.x) / dNext * r, y: cur.y + (next.y - cur.y) / dNext * r };
    // Quadratic Bézier from a to b with the original vertex as its control point.
    for (let s = 0; s <= CORNER_SEGMENTS; s += 1) {
      const t = s / CORNER_SEGMENTS;
      const u = 1 - t;
      out.push(
        u * u * a.x + 2 * u * t * cur.x + t * t * b.x,
        u * u * a.y + 2 * u * t * cur.y + t * t * b.y,
      );
    }
  }
  return out;
}

export function outlineToSvgPath(outline) {
  if (!outline || outline.length < 6) return '';
  let d = `M ${outline[0]} ${outline[1]}`;
  for (let i = 2; i < outline.length; i += 2) d += ` L ${outline[i]} ${outline[i + 1]}`;
  return `${d} Z`;
}

const pts = list => list.map(([x, y]) => ({ x, y }));

// Editable starting points for each built-in shape: few vertices + rounding, so the
// result looks like the original but stays easy to edit.
export function customShapeFromBase(shape, width = 150, height = 52) {
  switch (shape) {
    case 'rectangle':
      return { points: pts([[0, 0], [1, 0], [1, 1], [0, 1]]), rounding: 0 };
    case 'pill':
      return { points: pts([[0, 0], [1, 0], [1, 1], [0, 1]]), rounding: 1 };
    case 'diamond':
      return { points: pts([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]), rounding: 0 };
    case 'hexagon': {
      const inset = Math.min(width * 0.24, height * 0.5) / width;
      return { points: pts([[inset, 0], [1 - inset, 0], [1, 0.5], [1 - inset, 1], [inset, 1], [0, 0.5]]), rounding: 0 };
    }
    case 'slanted': {
      const inset = Math.min(width * 0.18, height * 0.42) / width;
      return { points: pts([[inset, 0], [1, 0], [1 - inset, 1], [0, 1]]), rounding: 0 };
    }
    case 'circle':
      return {
        points: Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
          return { x: 0.5 + Math.cos(a) / 2, y: 0.5 + Math.sin(a) / 2 };
        }),
        rounding: 1,
      };
    case 'cylinder':
    case 'database':
    case 'pillar': {
      const c = Math.min(width, height) * 0.12;
      const cx = c / width;
      const bulge = (c * 0.2) / width;
      return { points: pts([[cx, 0], [1 - cx, 0], [1 - bulge, 0.5], [1 - cx, 1], [cx, 1], [bulge, 0.5]]), rounding: 0.35 };
    }
    case 'protocol': {
      // Body with one connector pin on each side.
      const s = 0.06;
      return {
        points: pts([
          [s, 0], [1 - s, 0], [1 - s, 0.38], [1, 0.38], [1, 0.62], [1 - s, 0.62],
          [1 - s, 1], [s, 1], [s, 0.62], [0, 0.62], [0, 0.38], [s, 0.38],
        ]),
        rounding: 0.15,
      };
    }
    case 'rounded':
    default:
      return { points: pts([[0, 0], [1, 0], [1, 1], [0, 1]]), rounding: 0.35 };
  }
}

// Nearest point on a closed outline ([x0, y0, x1, y1, ...]) to (x, y).
export function projectOntoOutline(outline, x, y) {
  if (!outline || outline.length < 6) return { x, y };
  let best = { x, y, d: Infinity };
  const n = outline.length / 2;
  for (let i = 0; i < n; i += 1) {
    const ax = outline[i * 2];
    const ay = outline[i * 2 + 1];
    const bx = outline[((i + 1) % n) * 2];
    const by = outline[((i + 1) % n) * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < best.d) best = { x: px, y: py, d };
  }
  return { x: best.x, y: best.y };
}

// An anchor at an exact spot (fractions of the node's width/height). `side`/`along`
// are kept in sync — the nearest box side — for code that only understands sides.
export function anchorAtPosition(posX, posY, width, height) {
  const x = Math.max(0, Math.min(1, posX));
  const y = Math.max(0, Math.min(1, posY));
  const distances = [
    { side: 'top', d: y },
    { side: 'bottom', d: 1 - y },
    { side: 'left', d: x },
    { side: 'right', d: 1 - x },
  ].sort((a, b) => a.d - b.d);
  const side = distances[0].side;
  const along = side === 'top' || side === 'bottom'
    ? (x - 0.5) * width
    : (y - 0.5) * height;
  return { side, along, posX: x, posY: y };
}

// Where an anchor sits as fractions of the node box (exact anchors, or side/along ones).
export function getAnchorPosition(anchor, width, height) {
  if (Number.isFinite(anchor?.posX) && Number.isFinite(anchor?.posY)) {
    return { x: anchor.posX, y: anchor.posY };
  }
  const along = anchor?.along ?? 0;
  switch (anchor?.side) {
    case 'top': return { x: 0.5 + along / Math.max(1, width), y: 0 };
    case 'bottom': return { x: 0.5 + along / Math.max(1, width), y: 1 };
    case 'left': return { x: 0, y: 0.5 + along / Math.max(1, height) };
    case 'right': return { x: 1, y: 0.5 + along / Math.max(1, height) };
    default: return { x: 0.5, y: 0.5 };
  }
}
