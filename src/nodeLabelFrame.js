export function getNodeLabelFrame(node, options = {}) {
  const w = node?.width ?? 0;
  const h = node?.height ?? 0;

  if (node?.type === 'text') {
    return { x: 0, y: 0, width: w, height: h };
  }

  let padX = Math.max(16, Math.min(w * 0.11, 22));
  let padY = Math.max(8, Math.min(h * 0.18, 12));

  if (node?.shape === 'pill') {
    padX = Math.max(20, h * 0.34);
  } else if (node?.shape === 'pillar' || node?.shape === 'cylinder' || node?.shape === 'database') {
    padX = Math.max(20, w * 0.14);
  } else if (node?.shape === 'slanted') {
    padX = Math.max(22, w * 0.16);
  } else if (node?.shape === 'diamond') {
    padX = Math.max(24, w * 0.2);
    padY = Math.max(10, h * 0.12);
  } else if (node?.shape === 'hexagon') {
    padX = Math.max(22, Math.min(w * 0.17, h * 0.26));
  } else if (node?.shape === 'circle') {
    padX = Math.max(18, w * 0.18);
    padY = Math.max(12, h * 0.18);
  } else if (node?.shape === 'rounded') {
    padX = Math.max(padX, 14 + (node.cornerRadius ?? 10) * 0.45);
  } else if (node?.shape === 'custom') {
    // Free-form outlines can pinch in anywhere; keep the label well inside.
    padX = Math.max(20, w * 0.16);
    padY = Math.max(10, h * 0.16);
  } else if (node?.shape === 'protocol') {
    // Keep the label clear of the side connector pins.
    padX = Math.max(18, w * 0.13);
  }

  const bottomPad = options.reserveBottomRightBadge
    ? Math.max(22, padY + 6)
    : padY;

  return {
    x: padX,
    y: padY,
    width: Math.max(24, w - padX * 2),
    height: Math.max(20, h - padY - bottomPad),
  };
}
