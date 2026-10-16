import { colorThemes } from '../colorThemes';

// How a node looks when it fails. Shared by the canvas, the animation applier and
// the video/GIF exporter so every renderer draws the same mark.
export const FAILURE_MARKS = ['x', 'slash', 'ban', 'none'];

export const DEFAULT_FAILURE_STYLE = {
  mark: 'x',
  color: colorThemes.dangerBright,
  size: 1,          // multiplier on the auto-sized mark
  thickness: 1,     // multiplier on the auto stroke width
  halo: true,       // soft glow + ring behind the mark
  tint: true,       // colored veil over the node body
  tintStrength: 0.15,
};

// Links share the same options; their "tint" recolors the whole line, so it defaults to full.
export const DEFAULT_LINK_FAILURE_STYLE = { ...DEFAULT_FAILURE_STYLE, tintStrength: 1 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function getNodeFailureStyle(node, defaults = DEFAULT_FAILURE_STYLE) {
  const raw = node?.failureStyle ?? {};
  return {
    mark: FAILURE_MARKS.includes(raw.mark) ? raw.mark : defaults.mark,
    color: typeof raw.color === 'string' && raw.color ? raw.color : defaults.color,
    size: Number.isFinite(raw.size) ? clamp(raw.size, 0.3, 3) : defaults.size,
    thickness: Number.isFinite(raw.thickness) ? clamp(raw.thickness, 0.3, 4) : defaults.thickness,
    halo: raw.halo ?? defaults.halo,
    tint: raw.tint ?? defaults.tint,
    tintStrength: Number.isFinite(raw.tintStrength)
      ? clamp(raw.tintStrength, 0, 1)
      : defaults.tintStrength,
  };
}

export function getLinkFailureStyle(link) {
  return getNodeFailureStyle(link, DEFAULT_LINK_FAILURE_STYLE);
}

// Geometry for the mark, centred on (0, 0).
export function getFailureMarkGeometry(node) {
  const style = getNodeFailureStyle(node);
  const width = node?.width ?? 150;
  const height = node?.height ?? 52;
  const base = Math.max(9, Math.min(width, height) * 0.28);
  const baseStroke = Math.max(2.5, (node?.strokeWidth ?? 2) * 1.1);
  return buildMarkGeometry(style, base, baseStroke, 7, 3);
}

// Same mark for a link, sized from the line width and drawn at the link midpoint.
export function getLinkFailureMarkGeometry(link) {
  const style = getLinkFailureStyle(link);
  const sw = link?.strokeWidth ?? 2;
  return buildMarkGeometry(style, Math.max(7, 4 + sw * 1.4), Math.max(2, sw * 0.85), 6, 2);
}

function buildMarkGeometry(style, baseSize, baseStroke, glowPad, ringPad) {
  const size = baseSize * style.size;
  const strokeWidth = baseStroke * style.thickness;
  const lines = style.mark === 'x'
    ? [[-size, -size, size, size], [size, -size, -size, size]]
    : style.mark === 'slash' || style.mark === 'ban'
      ? [[-size * 0.72, size * 0.72, size * 0.72, -size * 0.72]]
      : [];
  return {
    style,
    size,
    strokeWidth,
    lines,
    ring: style.mark === 'ban' ? size : null,
    halo: style.halo && style.mark !== 'none'
      ? { glowRadius: size + glowPad, ringRadius: size + ringPad }
      : null,
  };
}

// Opacity multiplier for the tint veil (the veil shape itself is filled solid).
export function getFailureTintStrength(node) {
  const style = getNodeFailureStyle(node);
  return style.tint ? style.tintStrength : 0;
}

export function getLinkFailureTintStrength(link) {
  const style = getLinkFailureStyle(link);
  return style.tint ? style.tintStrength : 0;
}

// Whether a link has any kind of failure configured.
export function linkCanFail(link) {
  return !!link?.failing || !!link?.failAtEnds || !!link?.failOnTokenEnd
    || (link?.failureKeyframes?.length ?? 0) > 0;
}
