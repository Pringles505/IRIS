import React, { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Ellipse, Group, Line, Rect, Text, Circle, Path, Arrow } from 'react-konva';
import { pageColors, withAlpha } from '../../colorThemes';
import { getNodeLabelFrame } from '../../nodeLabelFrame';
import useStore from '../../store/useStore';
import { getClosestNodeOutlinePosition, getNodeAnchorPoint } from '../../links/linkGeometry';
import { getTimelineCursor } from '../../timelineCursor';
import { getNodeDisplayText, getNodeTextFontFamily } from '../../text/equationText';
import { snapDraggedBox } from './dragSnap';
import NodeStatusMark, { getNodeStatusDash, getNodeStatusStroke, getNodeStatusTextColor } from './NodeStatusMark';
import { getFailureTintStrength, getNodeFailureStyle } from '../../animation/nodeFailureStyle';
import { anchorAtPosition, getCustomShapeOutline, projectOntoOutline } from '../../shapes/customShape';

const PORT_R = 7;
const GRAPH_MIN_W = 160;
const GRAPH_MIN_H = 110;
const GRAPH_RESIZE_HANDLE_R = 5;

// Deterministic scatter for HKDF "calculate" dots: same seed → same layout every
// render, so the dots don't jump around while the user edits or scrubs.
function hashSeed(str, extra = 0) {
  let h = (2166136261 ^ (extra >>> 0)) >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Generate `count` dots scattered uniformly inside a pixel-space circle, each with
// an absolute appear time staggered across the calculate window.
function buildCalcDots(domain, sx, sy, radPx) {
  const calc = domain?.calc;
  if (!calc) return [];
  const count = Math.max(0, Math.min(400, Math.round(Number.isFinite(calc.count) ? calc.count : 12)));
  if (count === 0) return [];
  const time = Number.isFinite(calc.time) ? calc.time : 0;
  const dur = Number.isFinite(calc.duration) && calc.duration > 0 ? calc.duration : 1;
  const spread = dur * 0.7;          // dots finish scattering by ~70% of the window
  const perFade = Math.max(0.1, dur * 0.22);
  const rng = mulberry32(hashSeed(domain.id, calc.seed ?? 1));
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    const ang = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * radPx * 0.9; // sqrt → uniform area fill
    const tNorm = rng();
    dots.push({
      i,
      x: sx + Math.cos(ang) * rr,
      y: sy + Math.sin(ang) * rr,
      cStart: time + tNorm * spread,
      cDur: perFade,
    });
  }
  return dots;
}

const PORT_POSITIONS = (w, h) => [
  { x: w / 2, y: 0,     side: 'top'    },
  { x: w,     y: h / 2, side: 'right'  },
  { x: w / 2, y: h,     side: 'bottom' },
  { x: 0,     y: h / 2, side: 'left'   },
  { x: w / 2, y: h / 2, side: 'center' },
];

function getVisualStroke(node, isSelected, isInSelection) {
  return isSelected
    ? pageColors.blueSelection
    : isInSelection
      ? pageColors.purpleAccent
      : getNodeStatusStroke(node, node.stroke);
}

function getNodeTransformStyle(node, resolvedTargetNode) {
  const mode = node.transformMode;
  if (!mode || mode === 'none') return null;
  if (mode === 'existing') {
    const targetNode = resolvedTargetNode;
    if (!targetNode) return null;
    return {
      width: targetNode.width ?? node.width,
      height: targetNode.height ?? node.height,
      shape: targetNode.shape ?? 'rounded',
      cornerRadius: targetNode.cornerRadius ?? 8,
      fill: targetNode.fill ?? node.fill,
      stroke: targetNode.stroke ?? node.stroke,
      strokeWidth: targetNode.strokeWidth ?? node.strokeWidth,
    };
  }
  if (!node.transformTarget) return null;
  return {
    width: node.transformTarget.width ?? node.width,
    height: node.transformTarget.height ?? node.height,
    shape: node.transformTarget.shape ?? node.shape ?? 'rounded',
    cornerRadius: node.transformTarget.cornerRadius ?? node.cornerRadius ?? 8,
    fill: node.transformTarget.fill ?? node.fill,
    stroke: node.transformTarget.stroke ?? node.stroke,
    strokeWidth: node.transformTarget.strokeWidth ?? node.strokeWidth,
  };
}

function renderNodeHighlight(node, extraProps = {}) {
  if (node.shape === 'diamond' || node.shape === 'hexagon' || node.shape === 'circle' || node.shape === 'pillar' || node.shape === 'cylinder' || node.shape === 'database' || node.shape === 'slanted' || node.shape === 'protocol' || node.shape === 'custom') return null;
  return (
    <Rect
      x={node.shape === 'pill' ? node.height / 2 : node.cornerRadius}
      y={1}
      width={node.width - (node.shape === 'pill' ? node.height : node.cornerRadius * 2)}
      height={1}
      fill={pageColors.whiteInnerHighlight}
      listening={false}
      {...extraProps}
    />
  );
}

// Shared metrics for the "protocol" module shape.
function protocolMetrics(w, h) {
  const s = Math.max(6, Math.min(16, w * 0.09));       // connector-pin depth / body inset
  const bw = w - 2 * s;                                 // inner body width
  const r = Math.max(4, Math.min(10, bw * 0.1, h * 0.2)); // body corner radius
  const pins = 2;
  const ph = Math.max(7, Math.min(14, h / (pins * 2.6))); // pin height
  const ys = [];
  for (let i = 0; i < pins; i += 1) ys.push((h * (i + 1)) / (pins + 1));
  return { s, bw, r, pins, ph, ys };
}

// Single closed path: a rounded body inset on both sides with two connector pins
// jutting out of each side — a clean "module" silhouette. One fillable/strokable
// shape so entry fade, selection dashes and colour morphs all keep working.
export function buildProtocolPath(w, h) {
  const { s, bw, r, ph, ys } = protocolMetrics(w, h);
  const bx = s;
  const rx = bx + bw; // right edge of inner body
  const cmds = [`M ${bx + r} 0`, `L ${rx - r} 0`, `Q ${rx} 0 ${rx} ${r}`];
  for (const y of ys) {
    const top = y - ph / 2;
    const bot = y + ph / 2;
    cmds.push(`L ${rx} ${top}`, `L ${w} ${top}`, `L ${w} ${bot}`, `L ${rx} ${bot}`);
  }
  cmds.push(`L ${rx} ${h - r}`, `Q ${rx} ${h} ${rx - r} ${h}`, `L ${bx + r} ${h}`, `Q ${bx} ${h} ${bx} ${h - r}`);
  for (let i = ys.length - 1; i >= 0; i -= 1) {
    const y = ys[i];
    const top = y - ph / 2;
    const bot = y + ph / 2;
    cmds.push(`L ${bx} ${bot}`, `L 0 ${bot}`, `L 0 ${top}`, `L ${bx} ${top}`);
  }
  cmds.push(`L ${bx} ${r}`, `Q ${bx} 0 ${bx + r} 0`, 'Z');
  return cmds.join(' ');
}

function renderNodeBody(node, stroke, strokeWidth, isInSelection, fill, shadow = false, extraProps = {}) {
  const dashProps = isInSelection ? { dash: [6, 3], dashEnabled: true } : {};
  const common = {
    stroke,
    strokeWidth,
    fill,
    // Konva's fill+stroke buffer can be clipped when exporting a cropped stage
    // while an ancestor is fading. Draw directly so entrance frames stay whole.
    perfectDrawEnabled: false,
    ...dashProps,
    ...extraProps,
  };

  if (node.shape === 'custom') {
    const outline = getCustomShapeOutline(node.customShape, node.width, node.height);
    if (outline) {
      return <Line points={outline} closed {...common} x={shadow ? 4 : 0} y={shadow ? 4 : 0} />;
    }
  }

  if (node.shape === 'diamond') {
    const points = [
      node.width / 2, 0,
      node.width, node.height / 2,
      node.width / 2, node.height,
      0, node.height / 2,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'hexagon') {
    const inset = Math.min(node.width * 0.24, node.height * 0.5);
    const points = [
      inset, 0,
      node.width - inset, 0,
      node.width, node.height / 2,
      node.width - inset, node.height,
      inset, node.height,
      0, node.height / 2,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'circle') {
    return (
      <Ellipse
        x={node.width / 2 + (shadow ? 4 : 0)}
        y={node.height / 2 + (shadow ? 4 : 0)}
        radiusX={node.width / 2}
        radiusY={node.height / 2}
        {...common}
      />
    );
  }

  if (node.shape === 'pillar' || node.shape === 'cylinder' || node.shape === 'database') {
    const w = node.width;
    const h = node.height;
    // Flat cylinder: slightly concave vertical sides.
    const curve = Math.min(w, h) * 0.12;
    const pathData = [
      `M ${curve},0`,
      `L ${w - curve},0`,
      `Q ${w - curve * 0.2},${h / 2} ${w - curve},${h}`,
      `L ${curve},${h}`,
      `Q ${curve * 0.2},${h / 2} ${curve},0`,
      'Z',
    ].join(' ');

    return (
      <Path
        data={pathData}
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'slanted') {
    const inset = Math.min(node.width * 0.18, node.height * 0.42);
    const points = [
      inset, 0,
      node.width, 0,
      node.width - inset, node.height,
      0, node.height,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'protocol') {
    return (
      <Path
        data={buildProtocolPath(node.width, node.height)}
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  const cornerRadius = node.shape === 'pill'
    ? Math.min(node.width, node.height) / 2
    : node.cornerRadius;

  return (
    <Rect
      x={shadow ? 4 : 0}
      y={shadow ? 4 : 0}
      width={node.width}
      height={node.height}
      cornerRadius={cornerRadius}
      {...common}
    />
  );
}


function NodeShape({ node, isSelected, isInSelection, onSelect, onStartLink, onEndLink, onRenameStart, onContextMenu, isLinking, onGroupDragStart, onGroupDragMove, renderEditorChrome = true }) {
  // Use individual selectors so NodeShape only re-renders when the specific values it needs change,
  // not on every node array update (which would cause O(n) re-renders per drag frame).
  const updateNode         = useStore(state => state.updateNode);
  const updateNodeAnchor   = useStore(state => state.updateNodeAnchor);
  const setAlignmentGuides = useStore(state => state.setAlignmentGuides);

  // Targeted selector — only subscribes to the specific transform target node, not the whole array
  const transformTargetNodeId = node.transformMode === 'existing' ? node.transformTargetNodeId : null;
  const transformTargetNode = useStore(state =>
    transformTargetNodeId
      ? (state.nodes.find(n =>
          n.id === transformTargetNodeId &&
          n.id !== node.id &&
          n.type !== 'area' && n.type !== 'mirror' && n.type !== 'text'
        ) ?? null)
      : null
  );

  const [hovered, setHovered] = useState(false);
  const groupRef = useRef(null);
  const [graphPointer, setGraphPointer] = useState(null); // { lx, ly, x, y }
  const popupGroupRef = useRef(null);
  const popupTextRef = useRef(null);
  const popupBgRef = useRef(null);
  const popupTimerRef = useRef(null);
  const dragStartPosRef = useRef(null);
  const dragWriteTimeRef = useRef(0);
  const graphResizeRef = useRef(null);
  const isTextNode = node.type === 'text';
  const transformStyle = (!isTextNode && node.transformMode && node.transformMode !== 'none')
    ? getNodeTransformStyle(node, transformTargetNode)
    : null;
  const stroke = getVisualStroke(node, isSelected, isInSelection);
  const strokeWidth = isSelected ? node.strokeWidth + 1 : isInSelection ? node.strokeWidth + 1 : node.strokeWidth;
  const labelFrame = getNodeLabelFrame(node);

  const editorHovered = renderEditorChrome && hovered;
  const showPorts = renderEditorChrome && (isSelected || hovered || isLinking);

  const cx = node.x + node.width  / 2;
  const cy = node.y + node.height / 2;

  const applyDraggedPosition = (target, nextPos) => {
    target.x(nextPos.x + node.width / 2);
    target.y(nextPos.y + node.height / 2);
  };

  const handleDragStart = (e) => {
    setAlignmentGuides([]);
    e.cancelBubble = true;
    if (!isSelected && !isInSelection) {
      onSelect(false);
    }
    dragStartPosRef.current = { x: node.x, y: node.y };
    onGroupDragStart?.(node.id);
  };

  const handleDragMove = (e) => {
    const raw = {
      id: node.id,
      x: e.target.x() - node.width / 2,
      y: e.target.y() - node.height / 2,
      width: node.width,
      height: node.height,
    };
    const { x, y, guides } = snapDraggedBox(raw, e, dragStartPosRef.current);
    const nextPos = { x, y };

    setAlignmentGuides(guides);
    applyDraggedPosition(e.target, nextPos);

    // The Konva group above tracks the pointer at full frame rate; the store
    // write is what makes links and co-selected nodes follow. Replacing the
    // nodes array per mousemove rebuilds the entire animation timeline, so
    // throttle store writes — the exact position is committed on drag end.
    const now = performance.now();
    if (now - dragWriteTimeRef.current >= 40) {
      dragWriteTimeRef.current = now;
      updateNode(node.id, { x: nextPos.x, y: nextPos.y });
      if (dragStartPosRef.current) {
        const dx = nextPos.x - dragStartPosRef.current.x;
        const dy = nextPos.y - dragStartPosRef.current.y;
        onGroupDragMove?.(node.id, dx, dy);
      }
    }
  };

  const handleDragEnd = (e) => {
    setAlignmentGuides([]);
    const x = e.target.x() - node.width  / 2;
    const y = e.target.y() - node.height / 2;
    updateNode(node.id, { x, y });
    // Final group sync — the last throttled move may have been skipped.
    if (dragStartPosRef.current) {
      onGroupDragMove?.(node.id, x - dragStartPosRef.current.x, y - dragStartPosRef.current.y);
    }
  };

  const getCanvasPointer = (e) => {
    const stage = e.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return null;
    return stage.getAbsoluteTransform().copy().invert().point(pointer);
  };

  const startGraphResize = (e, handle) => {
    e.cancelBubble = true;
    const pointer = getCanvasPointer(e);
    if (!pointer) return;
    graphResizeRef.current = {
      handle,
      pointer,
      initial: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      },
    };
  };

  const resizeGraph = (e) => {
    e.cancelBubble = true;
    const resize = graphResizeRef.current;
    const pointer = getCanvasPointer(e);
    if (!resize || !pointer) return;

    const dx = pointer.x - resize.pointer.x;
    const dy = pointer.y - resize.pointer.y;
    let { x, y, width, height } = resize.initial;

    if (resize.handle.includes('l')) {
      const nextWidth = Math.max(GRAPH_MIN_W, width - dx);
      x += width - nextWidth;
      width = nextWidth;
    } else {
      width = Math.max(GRAPH_MIN_W, width + dx);
    }

    if (resize.handle.includes('t')) {
      const nextHeight = Math.max(GRAPH_MIN_H, height - dy);
      y += height - nextHeight;
      height = nextHeight;
    } else {
      height = Math.max(GRAPH_MIN_H, height + dy);
    }

    updateNode(node.id, { x, y, width, height });
  };

  const endGraphResize = (e) => {
    e.cancelBubble = true;
    resizeGraph(e);
    graphResizeRef.current = null;
  };

  // Default side/center ports are hidden once the custom shape editor replaced them.
  const ports = node.customAnchorsOnly ? [] : PORT_POSITIONS(node.width, node.height);

  // Compute display value for the simple popup. Keep it conservative and local.
  const popupValue = (() => {
    // Prefer explicit per-node popupValue if user adds it later
    if (node.popupValue != null && node.popupValue !== '') return String(node.popupValue);
    // For variable nodes, try variableValue then variableLabel
    if (node.type === 'variable') {
      if (node.variableValue != null && node.variableValue !== '') return String(node.variableValue);
      if (node.variableLabel != null && node.variableLabel !== '') return String(node.variableLabel);
    }
    // Fallback to node label
    return String(node.label ?? '');
  })();

  // Derive fallback popup dimensions from text, while allowing explicit overrides.
  const popupFontSize = Math.max(11, Math.min(18, (node.fontSize ?? 13)));
  const padX = 10;
  const padY = 6;
  const approxCharW = popupFontSize * 0.62;
  const estTextW = Math.max(16, Math.ceil((popupValue?.length ?? 0) * approxCharW));
  const fallbackPopupW = Math.max(node.width, estTextW + padX * 2);
  const popupW = Math.max(24, Number.isFinite(node.popupWidth) ? node.popupWidth : fallbackPopupW);
  const popupBaseH = Math.ceil(popupFontSize * 1.25 + padY * 2);
  const fallbackPopupH = Math.max(48, Math.min(96, popupBaseH * 2));
  const popupH = Math.max(18, Number.isFinite(node.popupHeight) ? node.popupHeight : fallbackPopupH);
  // Let the popup tab extend slightly inside the parent node
  const overlapInside = Math.min(Math.floor(popupH * 0.35), Math.floor((node.height ?? 52) * 0.4));

  const popupEnabled = !!(node.showSimplePopupInPlayback);

  // ── Graph rendering (for type === 'graph') ─────────────────────────────────
  const graphData = useMemo(() => {
    if (node.type !== 'graph') return null;
    const w = Math.max(10, node.width);
    const h = Math.max(10, node.height);
    const pad = Math.max(8, Math.min(18, Math.round(Math.min(w, h) * 0.08)));
    const userXMin = Number.isFinite(node.xMin) ? node.xMin : null;
    const userXMax = Number.isFinite(node.xMax) ? node.xMax : null;
    const centerX = Number.isFinite(node.centerX) ? node.centerX : 0;
    let xmin, xmax;
    if (userXMin != null && userXMax != null) {
      xmin = userXMin;
      xmax = userXMax;
    } else {
      const baseMin = Number.isFinite(node.xMin) ? node.xMin : -10;
      const baseMax = Number.isFinite(node.xMax) ? node.xMax : 10;
      const half = Math.max(Math.abs(baseMin), Math.abs(baseMax), 1);
      xmin = centerX - half;
      xmax = centerX + half;
    }
    const N = Math.max(60, Math.min(2000, Number.isFinite(node.samples) ? node.samples : Math.round(w * 1.5)));
    const exprRaw = String(node.formula ?? '').trim();
    const expr = exprRaw;
    // Parse params like: a=-1, b=1
    const params = {};
    const paramStr = String(node.graphParams ?? '').trim();
    if (paramStr) {
      for (const part of paramStr.split(/[,;]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const kv = seg.split('=');
        if (kv.length === 2) {
          const k = kv[0].trim();
          const v = Number(kv[1].trim());
          if (k && Number.isFinite(v)) params[k] = v;
        }
      }
    }
    const FN_NAMES = new Set([
      'sin','cos','tan','asin','acos','atan','atan2','sinh','cosh','tanh','asinh','acosh','atanh',
      'exp','log','log10','sqrt','abs','floor','ceil','round','min','max','pow'
    ]);
    const tokenize = (s) => {
      const tokens = [];
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        if (/[A-Za-z_]/.test(ch)) {
          let j = i + 1;
          while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
          tokens.push({ type: 'ident', value: s.slice(i, j) });
          i = j; continue;
        }
        if (/[0-9.]/.test(ch)) {
          let j = i + 1;
          let dotSeen = ch === '.';
          while (j < s.length) {
            const cj = s[j];
            if (/[0-9]/.test(cj)) { j += 1; continue; }
            if (cj === '.' && !dotSeen) { dotSeen = true; j += 1; continue; }
            break;
          }
          tokens.push({ type: 'number', value: s.slice(i, j) });
          i = j; continue;
        }
        // single-char token
        tokens.push({ type: 'sym', value: ch });
        i += 1;
      }
      return tokens;
    };
    const normalizeExpression = (src) => {
      if (!src) return '';
      const tokens = tokenize(src.replace(/\^\s*\(/g, '^('));
      const out = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];
        // Replace caret with JS exponent
        if (t.type === 'sym' && t.value === '^') {
          out.push('**');
        } else {
          out.push(t.value);
        }
        // Decide if we need an implicit multiplication
        const a = tokens[i];
        const b = tokens[i + 1];
        if (!b) continue;
        const aCat = a.type === 'ident' ? 'ident' : a.type === 'number' ? 'number' : (a.value === ')' ? 'rparen' : 'other');
        const bCat = b.type === 'ident' ? 'ident' : b.type === 'number' ? 'number' : (b.value === '(' ? 'lparen' : 'other');
        const isFuncCall = a.type === 'ident' && b.value === '(' && FN_NAMES.has(a.value);
        const needMul = (aCat === 'ident' || aCat === 'number' || aCat === 'rparen') && (bCat === 'ident' || bCat === 'number' || bCat === 'lparen') && !isFuncCall;
        if (needMul) out.push('*');
      }
      return out.join('');
    };
    const buildFn = (body) => {
      try {
        const js = normalizeExpression(body);
        return new Function('x', 'params', 'with (Math) { with (params) { return (' + js + '); } }');
      } catch (e) {
        return null;
      }
    };
    let mode = 'invalid';
    let rhs = null;
    if (expr && expr.includes('=')) {
      const [leftRaw, rightRaw] = expr.split('=');
      const left = (leftRaw ?? '').toLowerCase().replace(/\s+/g, '');
      const leftNorm = left
        .replace(/\*\*\s*2/g, '^2')
        .replace(/\^\(\s*2\s*\)/g, '^2')
        .replace(/pow\(\s*y\s*,\s*2\s*\)/g, 'y^2');
      const R = (rightRaw ?? '').trim();
      if (leftNorm === 'y') { mode = 'explicit'; rhs = R; }
      else if (leftNorm === 'y^2') { mode = 'squared'; rhs = R; }
    }
    const fn = mode === 'invalid' ? null : buildFn(rhs ?? '0');
    const xs = [];
    const ys = [];
    if (fn) {
      for (let i = 0; i <= N; i += 1) {
        const t = i / N;
        const x = xmin + (xmax - xmin) * t;
        let y = Number.NaN;
        try { y = fn(x, params); } catch (e) { y = Number.NaN; }
        xs.push(x);
        ys.push(y);
      }
    }
    // Prepare one or two line series depending on mode
    let minY = Infinity, maxY = -Infinity;
    const top = [];
    const bot = [];
    if (mode === 'squared') {
      // y^2 = g(x) → y = ±sqrt(g(x))
      for (let i = 0; i < xs.length; i += 1) {
        const g = ys[i];
        if (!Number.isFinite(g) || g < 0) { top.push(null); bot.push(null); continue; }
        const y1 = Math.sqrt(g);
        const y2 = -y1;
        top.push(y1);
        bot.push(y2);
        if (Number.isFinite(y1)) { if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1; }
        if (Number.isFinite(y2)) { if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2; }
      }
    } else if (mode === 'explicit') {
      for (let i = 0; i < xs.length; i += 1) {
        const y = ys[i];
        if (Number.isFinite(y)) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) { minY = -1; maxY = 1; }
    // Apply user overrides / center-based y range
    const userYMin = Number.isFinite(node.yMin) ? node.yMin : null;
    const userYMax = Number.isFinite(node.yMax) ? node.yMax : null;
    const centerY = Number.isFinite(node.centerY) ? node.centerY : 0;
    if (userYMin != null) minY = userYMin;
    if (userYMax != null) maxY = userYMax;
    if (minY === maxY) { minY -= 1; maxY += 1; }
    if (userYMin == null && userYMax == null) {
      const halfH = Math.max(Math.abs(minY - centerY), Math.abs(maxY - centerY), 1e-6);
      minY = centerY - halfH;
      maxY = centerY + halfH;
    }

    const toScreen = (x, y) => {
      const t = (x - xmin) / (xmax - xmin);
      const X = pad + t * (w - pad * 2);
      const yn = (y - minY) / (maxY - minY);
      const Y = pad + (1 - Math.max(0, Math.min(1, yn))) * (h - pad * 2);
      return [X, Y];
    };

    const buildSegmentsFromPoints = (ptArray) => {
      const segs = [];
      let cur = [];
      for (let i = 0; i < ptArray.length; i += 1) {
        const pt = ptArray[i];
        if (pt) {
          cur.push(pt[0], pt[1]);
        } else {
          if (cur.length >= 4) segs.push(cur);
          cur = [];
        }
      }
      if (cur.length >= 4) segs.push(cur);
      return segs;
    };

    const lines = [];
    if (mode === 'squared') {
      // Build pre-screen arrays then collapse near y=0 to avoid double-thick lines
      const topPts = [];
      const botPts = [];
      for (let i = 0; i < xs.length; i += 1) {
        const y1 = top[i];
        const y2 = bot[i];
        topPts[i] = Number.isFinite(y1) ? toScreen(xs[i], y1) : null;
        botPts[i] = Number.isFinite(y2) ? toScreen(xs[i], y2) : null;
      }
      // Insert exact y=0 crossings at sign changes so branches meet the x-axis
      for (let i = 1; i < xs.length; i += 1) {
        const g0 = ys[i - 1];
        const g1 = ys[i];
        if (Number.isFinite(g0) && Number.isFinite(g1) && g0 * g1 < 0) {
          const t = Math.abs(g0) / (Math.abs(g0) + Math.abs(g1));
          const x0 = xs[i - 1] + (xs[i] - xs[i - 1]) * t;
          const p0 = toScreen(x0, 0);
          // Prefer to place at right endpoint to keep ordering consistent
          topPts[i] = p0;
          botPts[i] = p0;
        }
      }
      const topSegs = buildSegmentsFromPoints(topPts);
      const botSegs = buildSegmentsFromPoints(botPts);
      topSegs.forEach((pts, i) => lines.push({ id: `top-s${i}`, points: pts }));
      botSegs.forEach((pts, i) => lines.push({ id: `bot-s${i}`, points: pts }));
    } else if (mode === 'explicit') {
      // Build explicit curve segments directly from screen points
      const mainPts = [];
      for (let i = 0; i < xs.length; i += 1) {
        const y = ys[i];
        mainPts[i] = Number.isFinite(y) ? toScreen(xs[i], y) : null;
      }
      const mainSegs = buildSegmentsFromPoints(mainPts);
      mainSegs.forEach((pts, i) => lines.push({ id: `main-s${i}`, points: pts }));
    } else {
      // invalid → no lines
    }
    // Axes: include 0-lines if within domain/range
    const axes = [];
    if ((node.showAxes === true) && 0 >= xmin && 0 <= xmax) {
      const tx = (0 - xmin) / (xmax - xmin);
      const X = pad + tx * (w - pad * 2);
      axes.push({ kind: 'vy', points: [X, pad, X, h - pad] });
    }
    if ((node.showAxes === true) && 0 >= minY && 0 <= maxY) {
      const ty = (0 - minY) / (maxY - minY);
      const Y = pad + (1 - ty) * (h - pad * 2);
      axes.push({ kind: 'hx', points: [pad, Y, w - pad, Y] });
    }
    return { lines, axes, xmin, xmax, minY, maxY, pad, w, h };
  }, [
    node.type,
    node.width,
    node.height,
    node.formula,
    node.xMin,
    node.xMax,
    node.yMin,
    node.yMax,
    node.centerX,
    node.centerY,
    node.samples,
    node.graphParams,
    node.showAxes,
  ]);

  // Animate popup in/out on hover. Auto-hide after a short hold to feel like a "pop".
  useEffect(() => {
    if (!popupEnabled) return; // not configured → no hover popup
    const g = popupGroupRef.current;
    if (!g) return;
    // If animation engine is driving this popup, skip hover-based control
    if (g.getAttr && g.getAttr('animDriven')) return;
    // Update text and background sizing each render in case value or font changed
    if (popupTextRef.current) {
      popupTextRef.current.text(popupValue);
      popupTextRef.current.fontSize(popupFontSize);
      popupTextRef.current.width(popupW - padX * 2);
      popupTextRef.current.height(popupH - padY * 2);
      popupTextRef.current.x(padX);
      popupTextRef.current.y(padY);
    }
    if (popupBgRef.current) {
      popupBgRef.current.width(popupW);
      popupBgRef.current.height(popupH);
      popupBgRef.current.x(0);
      popupBgRef.current.y(0);
      // no visible fill; real shape is drawn below
      if (popupBgRef.current.cornerRadius) popupBgRef.current.cornerRadius(0);
    }

    // Manage animation state
    // Place at node's top edge (y=0 inside node group) when hidden
    if (!renderEditorChrome) {
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
      g.stop();
      g.y(0);
      g.opacity(0);
      return;
    }

    if (!editorHovered) {
      // Cancel any pending auto-hide
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
      g.to({ y: 0, opacity: 0, duration: 0.16 });
      return;
    }

    // Slide up so that a portion of the tab remains inside the parent
    const keepInside = Math.max(6, Math.min(overlapInside, 12));
    const targetY = overlapInside + keepInside - popupH;
    g.to({ y: targetY, opacity: 1, duration: 0.2 });

    // Auto-hide after a short hold to emulate a quick pop (unless stay-open)
    if (node.popupStayOpen) {
      // don't auto-hide; stays until mouse leaves
    } else {
      if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
      popupTimerRef.current = setTimeout(() => {
        if (!popupGroupRef.current) return;
        popupGroupRef.current.to({ y: 0, opacity: 0, duration: 0.18 });
      }, 1100);
    }

    return () => {
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
    };
  }, [editorHovered, popupValue, popupFontSize, popupW, popupH, overlapInside, popupEnabled, node.popupStayOpen, renderEditorChrome]);

  return (
    <Group
      id={`node-${node.id}`}
      ref={groupRef}
      x={cx}
      y={cy}
      offsetX={node.width  / 2}
      offsetY={node.height / 2}
      draggable={!isLinking}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onClick={(e)    => { e.cancelBubble = true; onSelect(e.evt?.shiftKey); }}
      onTap={(e)      => { e.cancelBubble = true; onSelect(false); }}
      onDblClick={(e) => {
        e.cancelBubble = true;
        onSelect(false);
        onRenameStart?.(node.id);
      }}
      onDblTap={(e) => {
        e.cancelBubble = true;
        onSelect(false);
        onRenameStart?.(node.id);
      }}
      onContextMenu={(e) => {
        e.cancelBubble = true;
        onSelect(false);
        onContextMenu?.(e, node.id);
      }}
      onMouseEnter={()=> setHovered(true)}
      onMouseLeave={()=> { setHovered(false); setGraphPointer(null); }}
      onMouseMove={(e)=>{
        if (node.type !== 'graph' || !node.showCoords || !graphData) return;
        const stage = e.target.getStage();
        if (!stage || !groupRef.current) return;
        const pos = stage.getPointerPosition();
        if (!pos) return;
        const tr = groupRef.current.getAbsoluteTransform().copy();
        tr.invert();
        const local = tr.point(pos);
        const W = node.width - graphData.pad * 2;
        const H = node.height - graphData.pad * 2;
        if (W <= 0 || H <= 0) return;
        const xn = (local.x - graphData.pad) / W;
        const yn = 1 - (local.y - graphData.pad) / H;
        const x = graphData.xmin + xn * (graphData.xmax - graphData.xmin);
        const y = graphData.minY + yn * (graphData.maxY - graphData.minY);
        setGraphPointer({ lx: local.x, ly: local.y, x, y });
      }}
      onMouseDown={(e) => {
        if (node.type !== 'graph') return;
        // Use Shift+Click to add a point to the nearest curve location
        if (!e.evt.shiftKey) return;
        const stage = e.target.getStage();
        if (!stage || !groupRef.current || !graphData) return;
        const pos = stage.getPointerPosition();
        if (!pos) return;
        const tr = groupRef.current.getAbsoluteTransform().copy();
        tr.invert();
        const local = tr.point(pos);
        // Constrain to inner plot region for sanity
        const lx = Math.max(graphData.pad, Math.min(node.width - graphData.pad, local.x));
        const ly = Math.max(graphData.pad, Math.min(node.height - graphData.pad, local.y));
        let best = { d2: Infinity, px: lx, py: ly };
        for (const line of graphData.lines) {
          const pts = line.points || [];
          for (let i = 0; i + 3 < pts.length; i += 2) {
            const x1 = pts[i], y1 = pts[i + 1];
            const x2 = pts[i + 2], y2 = pts[i + 3];
            const dx = x2 - x1, dy = y2 - y1;
            const len2 = dx * dx + dy * dy;
            let t = 0;
            if (len2 > 0) t = ((lx - x1) * dx + (ly - y1) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const px = x1 + dx * t;
            const py = y1 + dy * t;
            const dd2 = (lx - px) * (lx - px) + (ly - py) * (ly - py);
            if (dd2 < best.d2) best = { d2: dd2, px, py };
          }
        }
        const W = node.width - graphData.pad * 2;
        const H = node.height - graphData.pad * 2;
        if (W <= 0 || H <= 0) return;
        const xn = (best.px - graphData.pad) / W;
        const yn = 1 - (best.py - graphData.pad) / H;
        const gx = graphData.xmin + xn * (graphData.xmax - graphData.xmin);
        const gy = graphData.minY + yn * (graphData.maxY - graphData.minY);
        updateNode(node.id, {
          graphPoints: [...(node.graphPoints ?? []), {
            id: uuid(),
            x: gx,
            y: gy,
            startTime: Math.round(getTimelineCursor() * 100) / 100,
            duration: 0.35,
          }],
        });
      }}
      onMouseUp={(e)  => { if (isLinking) { e.cancelBubble = true; onEndLink(node.id, null); }}}
    >
      {renderEditorChrome && (
        <Rect
          width={node.width}
          height={node.height}
          fill={pageColors.blackHitArea}
        />
      )}

      {/* Popup sits behind the body so it appears to come from inside the node. */}
      {!isTextNode && popupEnabled && (
        <Group id={`node-popup-${node.id}`} ref={popupGroupRef} x={0} y={0} opacity={0} listening={false}>
          <Group x={(node.width - popupW) / 2} y={-overlapInside} listening={false}>
            <Rect ref={popupBgRef} id={`node-popup-bg-${node.id}`} width={popupW} height={popupH} x={0} y={0} fill={pageColors.transparent} opacity={0} />
            {(() => {
              const mini = { ...node, width: popupW, height: popupH };
              const tabFill = node.popupFill ?? node.fill;
              return (
                <>
                  {renderNodeBody(mini, node.stroke, node.strokeWidth, false, tabFill, false, { id: `node-popup-body-${node.id}` })}
                  <Text
                    ref={popupTextRef}
                    id={`node-popup-text-${node.id}`}
                    text={popupValue}
                    x={padX}
                    y={padY}
                    width={popupW - padX * 2}
                    height={popupH - padY * 2}
                    align="center"
                    verticalAlign="middle"
                    fontSize={popupFontSize}
                    fill={node.textColor}
                    fontFamily="Inter, system-ui, sans-serif"
                    fontStyle="600"
                    listening={false}
                  />
                </>
              );
            })()}
          </Group>
        </Group>
      )}

      {!isTextNode && (
        renderNodeBody(node, stroke, strokeWidth, isInSelection && !isSelected, node.fill, false, {
          id: `node-body-${node.id}`,
          baseFill: node.fill,
          baseStroke: getNodeStatusStroke(node, node.stroke),
          baseStrokeWidth: node.strokeWidth,
          ...(node.offline ? { dash: getNodeStatusDash(node), dashEnabled: true } : {}),
        })
      )}



      {/* Graph content */}
      {node.type === 'graph' && graphData && (
        <>
          {/* HKDF domain-separation circles — independent output domains, drawn behind the curve */}
          {node.showDomains && (
            <Group id={`graph-domains-${node.id}`} listening={false}>
              {(() => {
                const W = node.width - graphData.pad * 2;
                const H = node.height - graphData.pad * 2;
                const xScale = W / (graphData.xmax - graphData.xmin);
                // Resolve every domain's pixel geometry first. List order is priority:
                // index 0 is highest and wins any overlap ("clash").
                const geos = (node.graphDomains ?? []).map((d, idx) => {
                  const cx = Number.isFinite(d.cx) ? d.cx : 0;
                  const cy = Number.isFinite(d.cy) ? d.cy : 0;
                  const r = Number.isFinite(d.r) ? d.r : 1;
                  const xn = (cx - graphData.xmin) / (graphData.xmax - graphData.xmin);
                  const yn = (cy - graphData.minY) / (graphData.maxY - graphData.minY);
                  return {
                    d,
                    idx,
                    sx: graphData.pad + xn * W,
                    sy: graphData.pad + (1 - yn) * H,
                    rad: Math.max(2, r * xScale),
                    start: Number.isFinite(d.startTime) ? d.startTime : 0,
                  };
                });
                // Render lowest priority first so the highest-priority domain sits on
                // top; each domain also subtracts the circles of every higher-priority
                // domain so the overlap region shows only the winner (no alpha blend).
                const sorted = [...geos].sort((a, b) => b.idx - a.idx);

                // Pass 1 — domain bodies (fill + dots), clipped by higher-priority circles.
                const bodies = sorted.map(({ d, idx, sx, sy, rad }) => {
                  const color = d.color ?? pageColors.purpleAccent;
                  const dStart = Number.isFinite(d.startTime) ? d.startTime : 0;
                  const dDur = Number.isFinite(d.duration) && d.duration > 0 ? d.duration : 0.4;
                  const dots = buildCalcDots(d, sx, sy, rad);
                  const dotColor = d.calc?.dotColor ?? color;
                  const dotSize = Number.isFinite(d.calc?.dotSize) ? d.calc.dotSize : 2.5;
                  // Geometry of every higher-priority domain that may override this one.
                  // The actual clip is built per-frame in applyAnimState so an overriding
                  // domain only punches its hole once it has appeared.
                  const overrideCircles = geos
                    .filter(g => g.idx < idx)
                    .map(g => ({ sx: g.sx, sy: g.sy, rad: g.rad, start: g.start }));
                  return (
                    <Group key={`body-${d.id}`} id={`graph-domain-${d.id}-${node.id}`} dStart={dStart} dDur={dDur} overrideCircles={overrideCircles}>
                      <Circle
                        x={sx}
                        y={sy}
                        radius={rad}
                        fill={withAlpha(color, 0.18)}
                        stroke={color}
                        strokeWidth={1.5}
                        dash={[6, 4]}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                      {/* "Calculate" keyframe: derived outputs scatter inside the domain */}
                      {dots.length > 0 && (
                        <Group name="calc-dots" listening={false}>
                          {dots.map((dot) => (
                            <Circle
                              key={dot.i}
                              x={dot.x}
                              y={dot.y}
                              radius={dotSize}
                              fill={dotColor}
                              opacity={0}
                              cStart={dot.cStart}
                              cDur={dot.cDur}
                              listening={false}
                              perfectDrawEnabled={false}
                            />
                          ))}
                        </Group>
                      )}
                    </Group>
                  );
                });

                // Pass 2 — labels, drawn after every body so they always sit ON TOP of
                // the scattered dots (and stay readable). Unclipped, but still fades in
                // with its domain via dStart/dDur.
                const labels = sorted
                  .filter(({ d }) => d.label)
                  .map(({ d, sx, sy, rad }) => {
                    const dStart = Number.isFinite(d.startTime) ? d.startTime : 0;
                    const dDur = Number.isFinite(d.duration) && d.duration > 0 ? d.duration : 0.4;
                    const labelColor = d.labelColor ?? d.color ?? pageColors.white;
                    const labelSize = Number.isFinite(d.labelSize) ? d.labelSize : 11;
                    return (
                      <Group key={`label-${d.id}`} dStart={dStart} dDur={dDur} listening={false}>
                        <Text
                          x={sx - rad}
                          y={sy - labelSize / 2 - 1}
                          width={rad * 2}
                          text={d.label}
                          align="center"
                          fontSize={labelSize}
                          fontStyle="600"
                          fill={labelColor}
                          listening={false}
                        />
                      </Group>
                    );
                  });

                return [...bodies, ...labels];
              })()}
            </Group>
          )}
          {/* Axes */}
          {(node.showAxes === true) && graphData.axes.map((ax, idx) => (
            <Line
              key={`ax-${idx}`}
              points={ax.points}
              stroke={pageColors.whiteHintSoft}
              strokeWidth={1}
              opacity={0.4}
              listening={false}
            />
          ))}
      {/* Function plot */}
          {graphData.lines.map(line => (
            <Line
              key={`gl-${line.id}`}
              id={`graph-line-${line.id}-${node.id}`}
              points={line.points}
              stroke={node.textColor}
              strokeWidth={2}
              listening={false}
            />
          ))}
          {/* Vectors between points. In chain mode, auto-join all points and alternate point/vector timing using `vectorSpeed`. */}
          <Group id={`graph-vectors-${node.id}`} listening={false} gLocal={node.graphChainPlayback ? 1 : 0} vSeq={node.graphChainPlayback ? 1 : 0}>
          {(() => {
            const W = node.width - graphData.pad * 2;
            const H = node.height - graphData.pad * 2;
            const mapScreen = (x, y) => {
              const xn = (x - graphData.xmin) / (graphData.xmax - graphData.xmin);
              const yn = (y - graphData.minY) / (graphData.maxY - graphData.minY);
              const sx = graphData.pad + xn * W;
              const sy = graphData.pad + (1 - yn) * H;
              return { sx, sy };
            };
            const ptsById = {};
            const allPts = node.graphPoints ?? [];
            for (const p of allPts) ptsById[p.id] = mapScreen(p.x, p.y);
            const speed = Number.isFinite(node.vectorSpeed) && node.vectorSpeed > 0 ? node.vectorSpeed : 0.2;
            const chain = !!node.graphChainPlayback;
            // Build vectors: chain mode auto-joins consecutive points; otherwise use user-defined vectors
            const vectors = chain
              ? (() => {
                  const res = [];
                  for (let j = 0; j + 1 < allPts.length; j += 1) {
                    res.push({ id: `chain-${j}`, fromId: allPts[j].id, toId: allPts[j + 1].id });
                  }
                  return res;
                })()
              : (node.graphVectors ?? []);
            const result = [];
            for (let idx = 0; idx < vectors.length; idx += 1) {
              const v = vectors[idx];
              const a = ptsById[v.fromId];
              const b = ptsById[v.toId];
              if (!a || !b) { continue; }
              const destination = allPts.find(point => point.id === v.toId);
              const destinationStart = Number.isFinite(destination?.startTime) ? destination.startTime : 0;
              // Point keyframes are absolute timeline times. Draw the incoming
              // line immediately before the destination point begins to appear.
              const start = Math.max(0, destinationStart - speed);
              const dur = Math.max(0.0001, destinationStart - start);
              const strokeCol = v.color ?? node.vectorColorDefault ?? '#FFFFFF';
              const width = Number.isFinite(v.width) ? v.width : (Number.isFinite(node.vectorWidthDefault) ? node.vectorWidthDefault : 1.5);
              const headL = Number.isFinite(v.headLength) ? v.headLength : (Number.isFinite(node.vectorHeadLengthDefault) ? node.vectorHeadLengthDefault : 8);
              const headW = Number.isFinite(v.headWidth) ? v.headWidth : (Number.isFinite(node.vectorHeadWidthDefault) ? node.vectorHeadWidthDefault : 8);
              result.push(
                <Arrow
                  key={`gv-${v.id}`}
                  id={`graph-vector-${v.id}-${node.id}`}
                  points={[a.sx, a.sy, b.sx, b.sy]}
                  stroke={strokeCol}
                  fill={strokeCol}
                  strokeWidth={width}
                  pointerLength={headL}
                  pointerWidth={headW}
                  listening={false}
                  vStart={start}
                  vDur={dur}
                  vFrom={v.fromId}
                  vTo={v.toId}
                  opacity={chain ? 0 : 0.9}
                />
              );
            }
            return result;
          })()}
          </Group>
          {/* User-added points */}
          <Group
            id={`graph-points-${node.id}`}
            listening={true}
            bindToCurve={node.pointsBindToCurve ? 1 : 0}
            gLocal={node.graphChainPlayback ? 1 : 0}
          >
          {(() => {
            const speed = Number.isFinite(node.vectorSpeed) && node.vectorSpeed > 0 ? node.vectorSpeed : 0.2;
            const chain = !!node.graphChainPlayback;
            const pts = node.graphPoints ?? [];
            return pts.map((p) => {
              const W = node.width - graphData.pad * 2;
              const H = node.height - graphData.pad * 2;
              const xn = (p.x - graphData.xmin) / (graphData.xmax - graphData.xmin);
              const yn = (p.y - graphData.minY) / (graphData.maxY - graphData.minY);
              const sx = graphData.pad + xn * W;
              const sy = graphData.pad + (1 - yn) * H;
              const radius = Math.max(1, Number.isFinite(p.size) ? p.size : (Number.isFinite(node.graphPointSizeDefault) ? node.graphPointSizeDefault : 4));
              const fill = p.fill ?? (node.graphPointFillDefault ?? pageColors.purpleAccent);
              const stroke = p.stroke ?? (node.graphPointStrokeDefault ?? pageColors.white);
              const pStart = Number.isFinite(p.startTime) ? p.startTime : 0;
              const pDur = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0.35;
              return (
                <React.Fragment key={p.id}>
                  <Group id={`graph-point-${p.id}-${node.id}`} x={sx} y={sy}
                    pId={p.id}
                    pStart={pStart}
                    pDur={pDur}
                    pNX={Math.max(0, Math.min(1, xn))}
                    opacity={0}
                    onMouseDown={(ev)=>{
                    if (ev.evt.altKey) {
                      // Alt+click to remove point
                      ev.cancelBubble = true;
                      updateNode(node.id, { graphPoints: (node.graphPoints ?? []).filter(q => q.id !== p.id) });
                    }
                  }}
                  >
                    <Circle radius={radius} fill={fill} stroke={stroke} strokeWidth={1} />
                  </Group>
                  {renderEditorChrome && isSelected && (
                    <Circle
                      x={sx}
                      y={sy}
                      radius={radius + 3}
                      stroke={fill}
                      strokeWidth={1}
                      dash={[3, 2]}
                      opacity={0.65}
                      editorPreview={1}
                      listening={false}
                    />
                  )}
                </React.Fragment>
              );
            });
          })()}
          </Group>
          {/* Crosshair and coordinate readout */}
          {node.showCoords && editorHovered && graphPointer && (() => {
            const lx = Math.max(graphData.pad, Math.min(node.width - graphData.pad, graphPointer.lx));
            const ly = Math.max(graphData.pad, Math.min(node.height - graphData.pad, graphPointer.ly));
            const innerLeft = graphData.pad;
            const innerTop = graphData.pad;
            const innerRight = node.width - graphData.pad;
            const innerBottom = node.height - graphData.pad;
            const label = `x: ${graphPointer.x.toFixed(2)}  y: ${graphPointer.y.toFixed(2)}`;
            return (
              <>
                <Line points={[lx, innerTop, lx, innerBottom]} stroke={pageColors.whiteHintSoft} opacity={0.5} dash={[4,4]} listening={false} />
                <Line points={[innerLeft, ly, innerRight, ly]} stroke={pageColors.whiteHintSoft} opacity={0.5} dash={[4,4]} listening={false} />
                <Rect x={innerLeft + 4} y={innerBottom - 18} width={Math.max(100, label.length * 6)} height={14} fill={pageColors.blackShadowNode} opacity={0.6} listening={false} cornerRadius={3} />
                <Text x={innerLeft + 8} y={innerBottom - 16} text={label} fontSize={10} fill={pageColors.white} listening={false} />
              </>
            );
          })()}
        </>
      )}

      {transformStyle && (() => {
        const pseudoNode = {
          ...node,
          width: transformStyle.width ?? node.width,
          height: transformStyle.height ?? node.height,
          shape: transformStyle.shape,
          cornerRadius: transformStyle.cornerRadius,
        };
        const dx = ((node.width ?? 0) - (pseudoNode.width ?? 0)) / 2;
        const dy = ((node.height ?? 0) - (pseudoNode.height ?? 0)) / 2;
        return (
          <Group x={dx} y={dy} listening={false}>
            {renderNodeBody(
              pseudoNode,
              transformStyle.stroke,
              transformStyle.strokeWidth ?? node.strokeWidth,
              false,
              transformStyle.fill,
              false,
              { id: `node-body-transform-${node.id}`, opacity: 0 }
            )}
            {renderNodeHighlight(pseudoNode, { id: `node-highlight-transform-${node.id}`, opacity: 0 })}
          </Group>
        );
      })()}

      {/* Failure tint overlay: above both base and transform bodies, below label */}
      {!isTextNode && (
        renderNodeBody(
          node,
          pageColors.transparent,
          0,
          false,
          getNodeFailureStyle(node).color,
          false,
          {
            id: `node-fail-tint-${node.id}`,
            opacity: node.failing ? getFailureTintStrength(node) : 0,
            failTintStrength: getFailureTintStrength(node),
            listening: false,
          }
        )
      )}

      {!isTextNode && renderNodeHighlight(node, { id: `node-highlight-${node.id}` })}

      {isTextNode && showPorts && (
        <Rect
          width={node.width}
          height={node.height}
          cornerRadius={6}
          stroke={isSelected ? pageColors.blueSelection : pageColors.purpleAccent}
          strokeWidth={1}
          dash={[5, 4]}
          opacity={0.35}
          listening={false}
        />
      )}

      {/* Simple hover popup: slides out from the top, shows a short value, then hides */}

      {/* Highlight aura: either background cutout (destination-out) or solid colour plate */}
      {node.textAura && (() => {
        const graphPad = Math.max(8, Math.min(18, Math.round(Math.min(node.width, node.height) * 0.08)));
        const approxTextH = Math.ceil((node.fontSize ?? 13) * 1.3);
        const ly = node.type === 'graph'
          ? Math.max(0, node.height - graphPad - approxTextH)
          : labelFrame.y;
        const lh = node.type === 'graph' ? approxTextH : labelFrame.height;
        const pad = 6;
        const mode = node.textAuraMode ?? 'cutout';
        const auraOpacity = Number.isFinite(node.textAuraOpacity) ? node.textAuraOpacity : 1;
        const blur = Number.isFinite(node.textAuraSize) ? node.textAuraSize : 16;
        const extra = pad + blur * 0.5; // the cleared zone extends past the text
        const w = labelFrame.width + extra * 2;
        const h = lh + extra * 2;
        if (mode === 'cutout') {
          return (
            <Rect
              id={`node-aura-${node.id}`}
              x={labelFrame.x - extra}
              y={ly - extra}
              width={w}
              height={h}
              cornerRadius={Math.min(h / 2, 18)}
              fill={pageColors.black}
              opacity={auraOpacity}
              shadowColor={pageColors.black}
              shadowBlur={blur}
              shadowOpacity={auraOpacity}
              shadowOffsetX={0}
              shadowOffsetY={0}
              globalCompositeOperation="destination-out"
              listening={false}
              perfectDrawEnabled={false}
            />
          );
        }
        const plateColor = node.textAuraColor || pageColors.canvasBackground;
        return (
          <Rect
            id={`node-aura-${node.id}`}
            x={labelFrame.x - extra}
            y={ly - extra}
            width={w}
            height={h}
            cornerRadius={Math.min(h / 2, 18)}
            fill={plateColor}
            opacity={auraOpacity}
            shadowColor={plateColor}
            shadowBlur={blur}
            shadowOpacity={auraOpacity}
            shadowOffsetX={0}
            shadowOffsetY={0}
            listening={false}
            perfectDrawEnabled={false}
          />
        );
      })()}

      {(() => {
        const graphPad = Math.max(8, Math.min(18, Math.round(Math.min(node.width, node.height) * 0.08)));
        const approxTextH = Math.ceil((node.fontSize ?? 13) * 1.3);
        const labelY = node.type === 'graph'
          ? Math.max(0, node.height - graphPad - approxTextH)
          : labelFrame.y;
        const labelH = node.type === 'graph' ? approxTextH : labelFrame.height;
        const vAlign = node.type === 'graph' ? 'top' : 'middle';
        return (
          <Text
            id={`node-label-${node.id}`}
            baseText={node.label}
            equationMode={!!node.equationMode}
            x={labelFrame.x}
            y={labelY}
            width={labelFrame.width}
            height={labelH}
            text={getNodeDisplayText(node)}
            align="center"
            verticalAlign={vAlign}
            fontSize={node.fontSize}
            fill={getNodeStatusTextColor(node, node.textColor)}
            baseFill={getNodeStatusTextColor(node, node.textColor)}
            fontFamily={getNodeTextFontFamily(node)}
            fontStyle={node.bold ? '700' : '500'}
            listening={false}
          />
        );
      })()}

      {(() => {
        const graphPad = Math.max(8, Math.min(18, Math.round(Math.min(node.width, node.height) * 0.08)));
        const approxTextH = Math.ceil((node.fontSize ?? 13) * 1.3);
        const morphY = node.type === 'graph'
          ? Math.max(0, node.height - graphPad - approxTextH)
          : labelFrame.y;
        const labelH = node.type === 'graph' ? approxTextH : labelFrame.height;
        const vAlign = node.type === 'graph' ? 'top' : 'middle';
        return (
          <Text
            id={`node-label-morph-${node.id}`}
            equationMode={!!node.equationMode}
            x={labelFrame.x}
            y={morphY}
            width={labelFrame.width}
            height={labelH}
            text=""
            align="center"
            verticalAlign={vAlign}
            fontSize={node.fontSize}
            fill={getNodeStatusTextColor(node, node.textColor)}
            baseFill={getNodeStatusTextColor(node, node.textColor)}
            fontFamily={getNodeTextFontFamily(node)}
            fontStyle={node.bold ? '700' : '500'}
            opacity={0}
            listening={false}
          />
        );
      })()}

      <NodeStatusMark node={node} />

      {showPorts && ports.map((p, i) => {
        const isCenter = p.side === 'center';
        return (
          <Circle
            key={i}
            x={p.x}
            y={p.y}
            radius={isCenter ? PORT_R - 2 : PORT_R}
            fill={isCenter ? pageColors.transparent : pageColors.blueMain}
            stroke={isCenter ? pageColors.blueSelection : pageColors.blueSelection}
            strokeWidth={isCenter ? 1.5 : 2}
            dash={isCenter ? [3, 2] : undefined}
            onMouseDown={(e) => {
              e.cancelBubble = true;
              onStartLink(node.id, { side: p.side, along: 0, anchorId: null, centered: p.side !== 'center' });
            }}
            onMouseUp={(e) => {
              e.cancelBubble = true;
              onEndLink(node.id, { side: p.side, along: 0, anchorId: null, centered: p.side !== 'center' });
            }}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'crosshair'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          />
        );
      })}

      {showPorts && (node.anchors ?? []).map((anchor) => {
        const point = getNodeAnchorPoint(node, anchor);
        const ax = point.x - node.x;
        const ay = point.y - node.y;
        // Offset the pull handle outward from the node based on the anchor side
        // so it doesn't sit on top of the body.
        const pull = anchor.side === 'top'    ? { x: 0,   y: -18 }
                   : anchor.side === 'bottom' ? { x: 0,   y: 18  }
                   : anchor.side === 'left'   ? { x: -18, y: 0   }
                   : anchor.side === 'right'  ? { x: 18,  y: 0   }
                   : { x: 16, y: -16 };
        const isJunction = anchor.isJunction !== false;
        return (
          <React.Fragment key={anchor.id}>
            <Circle
              x={ax}
              y={ay}
              radius={6}
              fill={isJunction ? pageColors.purpleAccent : pageColors.blueSurfaceSoft}
              stroke={pageColors.white}
              strokeWidth={1.5}
              draggable={isSelected && !isLinking}
              onDragStart={(e) => {
                e.cancelBubble = true;
              }}
              onDragMove={(e) => {
                e.cancelBubble = true;
                const customOutline = node.shape === 'custom'
                  ? getCustomShapeOutline(node.customShape, node.width, node.height)
                  : null;
                if (customOutline) {
                  // Custom shapes: keep the anchor on the drawn outline, at an exact spot.
                  const p = projectOntoOutline(customOutline, e.target.x(), e.target.y());
                  e.target.x(p.x);
                  e.target.y(p.y);
                  updateNodeAnchor(node.id, anchor.id, anchorAtPosition(p.x / node.width, p.y / node.height, node.width, node.height));
                  return;
                }
                const next = getClosestNodeOutlinePosition(node, {
                  x: node.x + e.target.x(),
                  y: node.y + e.target.y(),
                });
                e.target.x(next.point.x - node.x);
                e.target.y(next.point.y - node.y);
                updateNodeAnchor(node.id, anchor.id, { side: next.side, along: next.along, posX: null, posY: null });
              }}
              onDragEnd={(e) => {
                e.cancelBubble = true;
              }}
              onMouseUp={(e) => {
                e.cancelBubble = true;
                if (!isLinking) return;
                onEndLink(node.id, { side: anchor.side, along: anchor.along ?? 0, anchorId: anchor.id });
              }}
              onContextMenu={(e) => {
                // Right-click an anchor to toggle whether it acts as a junction.
                e.cancelBubble = true;
                e.evt?.preventDefault?.();
                updateNodeAnchor(node.id, anchor.id, { isJunction: !isJunction });
              }}
            />
            {isJunction && (
              <>
                <Circle
                  x={ax}
                  y={ay}
                  radius={10}
                  stroke={pageColors.blueSelection}
                  strokeWidth={1.5}
                  dash={[4, 3]}
                  listening={false}
                />
                {isSelected && !isLinking && (
                  <Group
                    x={ax + pull.x}
                    y={ay + pull.y}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                      onStartLink(node.id, {
                        side: anchor.side,
                        along: anchor.along ?? 0,
                        anchorId: anchor.id,
                        centered: false,
                      });
                    }}
                    onTouchStart={(e) => {
                      e.cancelBubble = true;
                      onStartLink(node.id, {
                        side: anchor.side,
                        along: anchor.along ?? 0,
                        anchorId: anchor.id,
                        centered: false,
                      });
                    }}
                    onMouseEnter={(e) => { e.target.getStage().container().style.cursor = 'crosshair'; }}
                    onMouseLeave={(e) => { e.target.getStage().container().style.cursor = 'default'; }}
                  >
                    <Circle
                      radius={8}
                      fill={pageColors.blueMain}
                      stroke={pageColors.blueSelection}
                      strokeWidth={2}
                    />
                    <Line
                      points={[-3, 0, 3, 0, 0, 0, 0, -3, 0, 3]}
                      stroke={pageColors.white}
                      strokeWidth={1.8}
                      lineCap="round"
                      listening={false}
                    />
                  </Group>
                )}
              </>
            )}
          </React.Fragment>
        );
      })}

      {renderEditorChrome && isSelected && node.type === 'graph' && !isLinking && [
        { id: 'tl', x: 0, y: 0, cursor: 'nwse-resize' },
        { id: 'tr', x: node.width, y: 0, cursor: 'nesw-resize' },
        { id: 'bl', x: 0, y: node.height, cursor: 'nesw-resize' },
        { id: 'br', x: node.width, y: node.height, cursor: 'nwse-resize' },
      ].map(handle => (
        <Group
          key={handle.id}
          x={handle.x}
          y={handle.y}
          draggable
          onMouseDown={(e) => { e.cancelBubble = true; }}
          onTouchStart={(e) => { e.cancelBubble = true; }}
          onDragStart={(e) => startGraphResize(e, handle.id)}
          onDragMove={resizeGraph}
          onDragEnd={endGraphResize}
          onMouseEnter={(e) => { e.target.getStage().container().style.cursor = handle.cursor; }}
          onMouseLeave={(e) => { e.target.getStage().container().style.cursor = 'default'; }}
        >
          <Rect x={-9} y={-9} width={18} height={18} fill={pageColors.blackHitArea} />
          <Circle
            radius={GRAPH_RESIZE_HANDLE_R}
            fill={pageColors.blueBright}
            stroke={pageColors.blueSelection}
            strokeWidth={1.5}
            listening={false}
          />
        </Group>
      ))}
    </Group>
  );
}

export default NodeShape;
