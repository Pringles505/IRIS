import React from 'react';
import { NODE_SHAPE_PRESETS } from '../store/useStore';
import { buildProtocolPath } from './canvas/NodeShape';
import { getCustomShapeOutline, outlineToSvgPath } from '../shapes/customShape';

// SVG outline of a node shape, drawn with the same geometry as the canvas.
// For `custom`, pass the node's customShape and its width/height for the aspect ratio.
export default function ShapePreview({
  shape, customShape = null, width = null, height = null,
  fill, stroke, boxW = 64, boxH = 40,
}) {
  const preset = NODE_SHAPE_PRESETS[shape] ?? NODE_SHAPE_PRESETS.rounded;
  const srcW = width ?? preset.width;
  const srcH = height ?? preset.height;
  const pad = 2;
  const scale = Math.min((boxW - pad * 2) / srcW, (boxH - pad * 2) / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  const common = { fill, stroke, strokeWidth: 1.5, strokeLinejoin: 'round' };
  let body;
  if (shape === 'custom') {
    const outline = getCustomShapeOutline(customShape, w, h);
    body = outline
      ? <path d={outlineToSvgPath(outline)} {...common} />
      : <rect x={0} y={0} width={w} height={h} {...common} strokeDasharray="3 2" />;
  } else if (shape === 'diamond') {
    body = <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...common} />;
  } else if (shape === 'hexagon') {
    const inset = Math.min(w * 0.24, h * 0.5);
    body = <polygon points={`${inset},0 ${w - inset},0 ${w},${h / 2} ${w - inset},${h} ${inset},${h} 0,${h / 2}`} {...common} />;
  } else if (shape === 'slanted') {
    const inset = Math.min(w * 0.18, h * 0.42);
    body = <polygon points={`${inset},0 ${w},0 ${w - inset},${h} 0,${h}`} {...common} />;
  } else if (shape === 'circle') {
    body = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...common} />;
  } else if (shape === 'cylinder' || shape === 'database') {
    const curve = Math.min(w, h) * 0.12;
    body = <path d={`M ${curve},0 L ${w - curve},0 Q ${w - curve * 0.2},${h / 2} ${w - curve},${h} L ${curve},${h} Q ${curve * 0.2},${h / 2} ${curve},0 Z`} {...common} />;
  } else if (shape === 'protocol') {
    body = <path d={buildProtocolPath(w, h)} {...common} />;
  } else {
    const radius = shape === 'pill' ? Math.min(w, h) / 2 : (preset.cornerRadius ?? 0) * scale;
    body = <rect x={0} y={0} width={w} height={h} rx={radius} {...common} />;
  }
  return (
    <svg width={boxW} height={boxH} viewBox={`0 0 ${boxW} ${boxH}`} aria-hidden="true" style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}>
      <g transform={`translate(${(boxW - w) / 2} ${(boxH - h) / 2})`}>{body}</g>
    </svg>
  );
}
