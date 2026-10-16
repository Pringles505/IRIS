import { getFailureMarkGeometry, getFailureTintStrength, getLinkFailureMarkGeometry, getLinkFailureStyle, getLinkFailureTintStrength, getNodeFailureStyle } from '../animation/nodeFailureStyle';
import { getCustomShapeOutline } from '../shapes/customShape';
import Konva from 'konva';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { AnimationEngine } from '../animation/AnimationEngine';
import { applyAnimState, computeLinkRenders, resetAnimState } from '../animation/applyAnimState';
import { computeManualTokenTimingByLinkId } from '../animation/manualTokenTiming';
import { buildMirrorBindings } from '../mirror/mirrorData';
import { buildLinkRenderData, getPointAtProgress } from '../links/linkGeometry';
import { buildWebByLinkId, computeVariableWebs } from '../variables/flow';
import { getNodeLabelFrame } from '../nodeLabelFrame';
import { pageColors, withAlpha } from '../colorThemes';
import { buildFullFrameApng } from './apng';
import { GIF_EXPORT_MIN_DURATION_SEC } from './gifTiming';
import { countGifFrames, retimeGif, padGifToMinBytes } from './gifBytes';
// Vendored ffmpeg core: bundled as local assets so exports work offline and
// don't depend on (or trust) a CDN at runtime.
import ffmpegCoreJsUrl from '@ffmpeg/core?url';
import ffmpegCoreWasmUrl from '@ffmpeg/core/wasm?url';

let ffmpegInstance = null;
let ffmpegReady = false;

async function getFFmpeg() {
  if (ffmpegReady) return ffmpegInstance;

  ffmpegInstance = new FFmpeg();
  try {
    await ffmpegInstance.load({
      coreURL: await toBlobURL(ffmpegCoreJsUrl, 'text/javascript'),
      wasmURL: await toBlobURL(ffmpegCoreWasmUrl, 'application/wasm'),
    });
  } catch (err) {
    // Drop the half-initialized instance so the next export retries cleanly.
    ffmpegInstance = null;
    throw err;
  }

  ffmpegReady = true;
  return ffmpegInstance;
}

function normalizeStageForExport(stage) {
  const position = { x: stage.x(), y: stage.y() };
  const scale = { x: stage.scaleX(), y: stage.scaleY() };
  stage.position({ x: 0, y: 0 });
  stage.scale({ x: 1, y: 1 });
  return () => {
    stage.position(position);
    stage.scale(scale);
    stage.batchDraw();
  };
}

// Re-assert the identity transform before each capture. The exporter updates
// store state (progress/status) during the capture loop, which re-renders the
// canvas and makes react-konva re-apply the live camera (stage x/scale) to the
// Stage — overriding normalizeStageForExport. Calling this immediately before
// every toDataURL keeps the crop in content coordinates so the framing can't
// drift mid-export. Safe to call every frame: it's a no-op once identity holds.
function lockStageIdentity(stage) {
  if (stage.x() !== 0 || stage.y() !== 0) stage.position({ x: 0, y: 0 });
  if (stage.scaleX() !== 1 || stage.scaleY() !== 1) stage.scale({ x: 1, y: 1 });
}


// ── Off-screen overlay rendering ────────────────────────────────────────────

const OVERLAY_W = 820;   // matches SubdiagramOverlay STAGE_W
const OVERLAY_H = 430;   // matches SubdiagramOverlay STAGE_H
const OVERLAY_PAD = 48;  // matches SubdiagramOverlay PAD
const MAX_POPUP_DEPTH = 4;

function overlayRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeEven(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function getOverlayCardMetrics(frameW, frameH) {
  const cardW = Math.round(Math.min(frameW * 0.82, OVERLAY_W * (frameH / OVERLAY_H) * 0.82));
  const cardH = Math.round(cardW * OVERLAY_H / OVERLAY_W);
  const cardX = (frameW - cardW) >> 1;
  const cardY = (frameH - cardH) >> 1;
  const cardRadius = Math.round(18 * cardW / OVERLAY_W);
  return { cardW, cardH, cardX, cardY, cardRadius };
}

function normalizePopupSnapshotNodes(snapshotNodes = []) {
  return snapshotNodes.map(node =>
    node.type === 'subdiagram' ? { ...node, animStartTime: null, animDuration: null } : node
  );
}

function makeBodyShape(shapeKind, w, h, cornerRadius, fill, stroke, strokeWidth, id, customShape = null) {
  const common = { fill, stroke, strokeWidth };
  if (id) common.id = id;

  if (shapeKind === 'custom') {
    const outline = getCustomShapeOutline(customShape, w, h);
    if (outline) return new Konva.Line({ points: outline, closed: true, ...common });
  }

  if (shapeKind === 'diamond') {
    return new Konva.Line({ points: [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2], closed: true, ...common });
  }
  if (shapeKind === 'hexagon') {
    const inset = Math.min(w * 0.24, h * 0.5);
    return new Konva.Line({ points: [inset, 0, w - inset, 0, w, h / 2, w - inset, h, inset, h, 0, h / 2], closed: true, ...common });
  }
  if (shapeKind === 'circle') {
    return new Konva.Ellipse({ x: w / 2, y: h / 2, radiusX: w / 2, radiusY: h / 2, ...common });
  }
  if (shapeKind === 'pillar' || shapeKind === 'cylinder' || shapeKind === 'database') {
    const curve = Math.min(w, h) * 0.12;
    const data = [
      `M ${curve},0`,
      `L ${w - curve},0`,
      `Q ${w - curve * 0.2},${h / 2} ${w - curve},${h}`,
      `L ${curve},${h}`,
      `Q ${curve * 0.2},${h / 2} ${curve},0`,
      'Z',
    ].join(' ');
    return new Konva.Path({ data, ...common });
  }
  if (shapeKind === 'slanted') {
    const inset = Math.min(w * 0.18, h * 0.42);
    return new Konva.Line({ points: [inset, 0, w, 0, w - inset, h, 0, h], closed: true, ...common });
  }
  const cr = shapeKind === 'pill' ? Math.min(w, h) / 2 : (cornerRadius ?? 8);
  return new Konva.Rect({ width: w, height: h, cornerRadius: cr, ...common });
}

function addSnapshotNode(layer, node) {
  const w = node.width ?? 150;
  const h = node.height ?? 52;
  const isArea = node.type === 'area';
  const isText = node.type === 'text';

  if (isArea) {
    if (node.areaInvisible) {
      // Do not render invisible areas in overlay snapshots.
      return;
    }
    const group = new Konva.Group({ id: `node-${node.id}`, x: node.x, y: node.y });
    const fill = node.fill ?? withAlpha(pageColors.purpleAccent, 0.07);
    const stroke = node.stroke ?? pageColors.purpleAccent;
    const rect = new Konva.Rect({
      id: `area-rect-${node.id}`,
      width: w, height: h,
      fill, stroke, strokeWidth: node.strokeWidth ?? 1.5,
      cornerRadius: node.cornerRadius ?? 12,
      dash: [10, 6], dashEnabled: true,
    });
    rect.setAttr('baseWidth', w);
    rect.setAttr('baseHeight', h);
    rect.setAttr('areaAnimMode', node.areaAnimMode ?? 'fade');
    const label = new Konva.Text({
      id: `area-label-${node.id}`,
      x: 16, y: 14,
      text: node.label ?? '',
      fontSize: node.fontSize ?? 12,
      fill: node.textColor ?? stroke,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontStyle: '600',
    });
    group.add(rect, label);
    layer.add(group);
    return;
  }

  const cx = node.x + w / 2;
  const cy = node.y + h / 2;
  const group = new Konva.Group({ id: `node-${node.id}`, x: cx, y: cy, offsetX: w / 2, offsetY: h / 2 });

  if (!isText) {
    const fill = node.fill ?? pageColors.blueNodeFill;
    const stroke = node.stroke ?? pageColors.blueNodeStroke;
    const strokeWidth = node.strokeWidth ?? 2;
    const body = makeBodyShape(node.shape ?? 'rounded', w, h, node.cornerRadius, fill, stroke, strokeWidth, `node-body-${node.id}`, node.customShape);
    body.setAttr('baseFill', fill);
    body.setAttr('baseStroke', stroke);
    body.setAttr('baseStrokeWidth', strokeWidth);
    group.add(body);

    // Failure tint overlay: subtle red veil above the body, below text
    const failTint = makeBodyShape(
      node.shape ?? 'rounded',
      w,
      h,
      node.cornerRadius,
      getNodeFailureStyle(node).color,
      pageColors.transparent,
      0,
      `node-fail-tint-${node.id}`,
      node.customShape,
    );
    failTint.setAttr('failTintStrength', getFailureTintStrength(node));
    failTint.opacity(node.failing ? getFailureTintStrength(node) : 0);
    failTint.listening(false);
    group.add(failTint);
  }

  const textFill = node.textColor ?? pageColors.white;
  const labelFrame = getNodeLabelFrame(node, {
    reserveBottomRightBadge: node.type === 'subdiagram' && (node.showSubBadge ?? true),
  });
  const lbl = new Konva.Text({
    id: `node-label-${node.id}`,
    x: labelFrame.x, y: labelFrame.y, width: labelFrame.width, height: labelFrame.height,
    text: node.label ?? '',
    align: 'center', verticalAlign: 'middle',
    fontSize: node.fontSize ?? 13,
    fill: textFill,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontStyle: '500',
  });
  lbl.setAttr('baseText', node.label ?? '');
  lbl.setAttr('baseFill', textFill);

  const morphLbl = new Konva.Text({
    id: `node-label-morph-${node.id}`,
    x: labelFrame.x, y: labelFrame.y, width: labelFrame.width, height: labelFrame.height,
    text: '', opacity: 0,
    align: 'center', verticalAlign: 'middle',
    fontSize: node.fontSize ?? 13,
    fill: textFill,
    fontFamily: 'Inter, system-ui, sans-serif',
  });
  morphLbl.setAttr('baseFill', textFill);

  group.add(lbl, morphLbl);
  if (node.failing || (node.failureKeyframes?.length ?? 0) > 0) {
    const fail = getFailureMarkGeometry(node);
    const failMark = new Konva.Group({
      id: `node-fail-${node.id}`,
      x: w / 2,
      y: h / 2,
      opacity: node.failing ? 1 : 0,
      listening: false,
    });
    if (fail.halo) {
      failMark.add(
        new Konva.Circle({ radius: fail.halo.glowRadius, fill: fail.style.color, opacity: 0.18 }),
        new Konva.Circle({ radius: fail.halo.ringRadius, stroke: fail.style.color, strokeWidth: 1, opacity: 0.35 }),
      );
    }
    if (fail.ring != null) {
      failMark.add(new Konva.Circle({ radius: fail.ring, stroke: fail.style.color, strokeWidth: fail.strokeWidth }));
    }
    for (const points of fail.lines) {
      failMark.add(new Konva.Line({ points, stroke: fail.style.color, strokeWidth: fail.strokeWidth, lineCap: 'round' }));
    }
    group.add(failMark);
  }
  layer.add(group);
}

function addSnapshotLink(layer, link, fromNode, toNode, allLinks, allNodes) {
  const render = buildLinkRenderData(link, fromNode, toNode, allLinks, allNodes);
  if (!render) return;
  const failStyle = getLinkFailureStyle(link);
  const color = link.failing && failStyle.tint ? failStyle.color : (link.stroke ?? pageColors.blueNodeStroke);
  const sw = link.strokeWidth ?? 2;

  const shaft = new Konva.Path({
    id: `link-shaft-${link.id}`,
    data: render.pathData,
    stroke: color, strokeWidth: sw,
    lineCap: 'round', lineJoin: 'round',
  });
  const head = new Konva.Line({
    id: `link-head-${link.id}`,
    points: render.arrowHeadPoints,
    closed: true, fill: color, stroke: color, strokeWidth: 1,
    opacity: render.showArrowTip && !link.failing ? 1 : 0,
  });
  head.setAttr('basePoints', render.arrowHeadPoints);
  head.setAttr('showTip', render.showArrowTip && !link.failing);

  const failOverlay = new Konva.Path({
    id: `link-shaft-fail-overlay-${link.id}`,
    data: render.pathData,
    stroke: failStyle.color,
    failTintStrength: getLinkFailureTintStrength(link),
    strokeWidth: sw,
    lineCap: 'round',
    lineJoin: 'round',
    opacity: 0,
    listening: false,
  });

  const midpoint = getPointAtProgress(render, 0.5, true)?.point ?? render.endPoint;
  const fail = getLinkFailureMarkGeometry(link);
  const failMark = new Konva.Group({
    id: `link-fail-${link.id}`,
    x: midpoint.x,
    y: midpoint.y,
    opacity: link.failing ? 1 : 0,
    listening: false,
  });
  if (fail.halo) {
    failMark.add(
      new Konva.Circle({ radius: fail.halo.glowRadius, fill: fail.style.color, opacity: 0.18 }),
      new Konva.Circle({ radius: fail.halo.ringRadius, stroke: fail.style.color, strokeWidth: 1, opacity: 0.35 }),
    );
  }
  if (fail.ring != null) {
    failMark.add(new Konva.Circle({ radius: fail.ring, stroke: fail.style.color, strokeWidth: fail.strokeWidth }));
  }
  for (const points of fail.lines) {
    failMark.add(new Konva.Line({ points, stroke: fail.style.color, strokeWidth: fail.strokeWidth, lineCap: 'round' }));
  }

  layer.add(shaft, failOverlay, head, failMark);
}

function buildPopupOverlay(snapshotNodes, snapshotLinks, nestedEngine) {
  const bb = nestedEngine.getBoundingBox();
  const contentScale = Math.min(
    (OVERLAY_W - OVERLAY_PAD * 2) / Math.max(bb.w, 1),
    (OVERLAY_H - OVERLAY_PAD * 2) / Math.max(bb.h, 1),
    2.5
  );
  const contentX = OVERLAY_W / 2 - bb.cx * contentScale;
  const contentY = OVERLAY_H / 2 - bb.cy * contentScale;

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;';
  document.body.appendChild(container);

  const offStage = new Konva.Stage({ container, width: OVERLAY_W, height: OVERLAY_H });

  // Static background layer
  const bgLayer = new Konva.Layer();
  bgLayer.add(new Konva.Rect({ width: OVERLAY_W, height: OVERLAY_H, fill: pageColors.canvasBackground }));
  offStage.add(bgLayer);
  bgLayer.draw();

  // Animated content layer
  const contentLayer = new Konva.Layer();
  contentLayer.scaleX(contentScale);
  contentLayer.scaleY(contentScale);
  contentLayer.x(contentX);
  contentLayer.y(contentY);

  const nodeMap = Object.fromEntries(snapshotNodes.map(n => [n.id, n]));

  // Area nodes behind everything
  snapshotNodes.filter(n => n.type === 'area').forEach(n => addSnapshotNode(contentLayer, n));
  // Links
  snapshotLinks.forEach(link => {
    const fromNode = nodeMap[link.fromId];
    const toNode = nodeMap[link.toId];
    if (fromNode && toNode) addSnapshotLink(contentLayer, link, fromNode, toNode, snapshotLinks, snapshotNodes);
  });
  // Content nodes on top
  snapshotNodes.filter(n => n.type !== 'area').forEach(n => addSnapshotNode(contentLayer, n));

  offStage.add(contentLayer);

  const nestedLinkRenders = computeLinkRenders(snapshotNodes, snapshotLinks);
  const nestedTimeline = nestedEngine.getTimeline();
  const nestedWebs = computeVariableWebs(snapshotNodes, snapshotLinks, { timeline: nestedTimeline });
  const nestedWebByLinkId = buildWebByLinkId(nestedWebs);
  const nestedManualTokenTimingById = computeManualTokenTimingByLinkId(snapshotLinks, nestedTimeline);
  const nestedFailingById = Object.fromEntries(snapshotLinks.map(link => [link.id, !!link.failing]));
  const nestedLinkFailureById = Object.fromEntries(snapshotLinks
    .filter(link => link.failureKeyframes?.length)
    .map(link => [link.id, { failureKeyframes: link.failureKeyframes }]));
  const nestedFailAtEndsById = Object.fromEntries(snapshotLinks.map(link => [link.id, !!link.failAtEnds]));
  const nestedFailOnTokenEndById = Object.fromEntries(snapshotLinks.map(link => [link.id, !!link.failOnTokenEnd]));
  const nestedMonitors = snapshotNodes.filter(n => n.type === 'monitor');

  return {
    offStage, bgLayer, contentLayer, container,
    nestedLinkRenders, nestedWebs, nestedWebByLinkId,
    nestedManualTokenTimingById, nestedFailingById, nestedLinkFailureById, nestedFailAtEndsById, nestedFailOnTokenEndById, nestedMonitors,
  };
}

function findActivePopupWindow(popupWindows, time) {
  return popupWindows.find(pw => time >= pw.popupStart && time <= pw.popupEnd) ?? null;
}

function buildPopupRenderTree({
  nodes,
  links,
  engine,
  ancestorSubdiagramIds = [],
  depth = 0,
  includePreviewPopups = false,
}) {
  if (depth >= MAX_POPUP_DEPTH) return [];

  const timeline = engine.getTimeline();
  const nodeEventsById = Object.fromEntries(
    timeline.filter(event => event.type === 'node').map(event => [event.id, event])
  );
  const linkEventsById = Object.fromEntries(
    timeline.filter(event => event.type === 'link').map(event => [event.id, event])
  );

  return nodes
    .filter(node => (
      node.type === 'subdiagram' &&
      !ancestorSubdiagramIds.includes(node.id) &&
      (node.showPopupInPlayback === true || (includePreviewPopups && node.showPreviewInPlayback === true)) &&
      (node.snapshotNodes?.length ?? 0) > 0
    ))
    .map(node => {
      const event = nodeEventsById[node.id];
      if (!event) return null;

      const triggerLinkEvent = node.triggerAfterLinkId
        ? linkEventsById[node.triggerAfterLinkId]
        : null;
      const snapshotNodes = normalizePopupSnapshotNodes(node.snapshotNodes ?? []);
      const snapshotLinks = node.snapshotLinks ?? [];
      const nextAncestry = [...ancestorSubdiagramIds, node.id];
      const nestedEngine = new AnimationEngine(snapshotNodes, snapshotLinks, {
        holdAfter: 0,
        ancestorSubdiagramIds: nextAncestry,
      });
      const popupDelay = Math.max(0, node.popupDelay ?? 0);
      const popupPlaybackSpeed = Math.max(0.25, node.popupPlaybackSpeed ?? 1);
      const popupHold = Math.max(0, node.popupHold ?? 0);
      const popupStart = Math.max(
        event.start + popupDelay,
        triggerLinkEvent ? triggerLinkEvent.start + triggerLinkEvent.duration + popupDelay : -Infinity
      );
      const nestedContentDuration = nestedEngine.getContentDuration();
      const popupEnd = popupStart + nestedContentDuration / popupPlaybackSpeed + popupHold;
      const children = buildPopupRenderTree({
        nodes: snapshotNodes,
        links: snapshotLinks,
        engine: nestedEngine,
        ancestorSubdiagramIds: nextAncestry,
        depth: depth + 1,
      });

      return {
        node,
        eventStart: event.start,
        popupStart,
        popupEnd,
        popupPlaybackSpeed,
        nestedContentDuration,
        nestedEngine,
        snapshotNodes,
        snapshotLinks,
        children,
        overlayInfo: null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.eventStart - a.eventStart || a.node.id.localeCompare(b.node.id));
}

function attachPopupOverlays(popupWindows) {
  popupWindows.forEach((popupWindow) => {
    popupWindow.overlayInfo = buildPopupOverlay(
      popupWindow.snapshotNodes,
      popupWindow.snapshotLinks,
      popupWindow.nestedEngine
    );
    attachPopupOverlays(popupWindow.children);
  });
}

function destroyPopupOverlays(popupWindows) {
  popupWindows.forEach((popupWindow) => {
    destroyPopupOverlays(popupWindow.children);
    if (popupWindow.overlayInfo) {
      popupWindow.overlayInfo.offStage.destroy();
      document.body.removeChild(popupWindow.overlayInfo.container);
      popupWindow.overlayInfo = null;
    }
  });
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cloneBytes(bytes) {
  if (!bytes) return new Uint8Array();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function dataUrlToBlob(dataUrl) {
  const bytes = dataUrlToBytes(dataUrl);
  return new Blob([bytes], { type: 'image/png' });
}

function drawBitmapContained(ctx, bitmap, width, height) {
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  ctx.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

// Teal export palette for the GIF border options.
const GIF_BORDER_PALETTE = {
  matTop: '#23444b',
  matBottom: '#002f33',
  accent: '#33d6be',
  accentSoft: '#19a686',
  edge: '#3e4b4b',
  hair: '#74c0c2',
};

// Wrap an already-composed frame canvas in a clean teal border so exported GIFs
// read as an intentional framed card on a white slide instead of a bare rectangle.
//   'frame' — a matted card: teal mat, inset content, bright accent rule.
//   'line'  — full-bleed content with a single crisp accent rule inside the edge.
function frameContentCanvas(content, width, height, mode) {
  if (!mode || mode === 'none') return content;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const minD = Math.min(width, height);

  if (mode === 'line') {
    ctx.drawImage(content, 0, 0, width, height);
    const lw = Math.max(2, Math.round(minD * 0.007));
    ctx.strokeStyle = GIF_BORDER_PALETTE.accent;
    ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, width - lw, height - lw);
    return out;
  }

  // 'frame' (default styled border)
  const pad = Math.max(12, Math.round(minD * 0.045));
  // Solid mat (avoid gradients to keep GIF palette compact and importer-friendly)
  ctx.fillStyle = GIF_BORDER_PALETTE.matTop;
  ctx.fillRect(0, 0, width, height);

  const ix = pad;
  const iy = pad;
  const iw = Math.max(1, width - pad * 2);
  const ih = Math.max(1, height - pad * 2);
  // Keep contained letterboxing dark rather than mat-coloured.
  ctx.fillStyle = pageColors.canvasBackground;
  ctx.fillRect(ix, iy, iw, ih);
  const scale = Math.min(iw / content.width, ih / content.height);
  const dw = content.width * scale;
  const dh = content.height * scale;
  ctx.drawImage(content, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);

  // Bright accent rule hugging the content, then a hairline at the outer edge.
  const lw = Math.max(2, Math.round(minD * 0.004));
  ctx.strokeStyle = GIF_BORDER_PALETTE.accent;
  ctx.lineWidth = lw;
  ctx.strokeRect(ix - lw / 2, iy - lw / 2, iw + lw, ih + lw);
  ctx.strokeStyle = GIF_BORDER_PALETTE.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  return out;
}

// Composite a composed animation frame onto an imported slide image, replacing the
// marked placeholder rectangle. Output is the full slide so every exported frame can
// be dropped straight into the deck, perfectly aligned across slides.
//   tpl = { bitmap, width, height, rect: { x, y, w, h } }
function compositeOntoTemplate(content, tpl) {
  const out = document.createElement('canvas');
  out.width = tpl.width;
  out.height = tpl.height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tpl.bitmap, 0, 0, tpl.width, tpl.height);
  const { x, y, w, h } = tpl.rect;
  // Paint over the placeholder so its marker colour never shows, even where the
  // animation is letterboxed inside the rectangle.
  ctx.fillStyle = pageColors.canvasBackground;
  ctx.fillRect(x, y, w, h);
  const scale = Math.min(w / content.width, h / content.height);
  const dw = content.width * scale;
  const dh = content.height * scale;
  ctx.drawImage(content, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return out;
}

function getCropPixelRatio(crop, exportWidth, exportHeight) {
  if (!crop) return null;
  return Math.max(0.5, Math.min(8, Math.min(
    exportWidth / Math.max(1, crop.width),
    exportHeight / Math.max(1, crop.height)
  )));
}

async function compositeFrame(mainDataUrl, overlayDataUrl, mainW, mainH) {
  // Load both images in parallel for speed
  const [mainBmp, overlayBmp] = await Promise.all([
    createImageBitmap(dataUrlToBlob(mainDataUrl)),
    createImageBitmap(dataUrlToBlob(overlayDataUrl)),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = mainW;
  canvas.height = mainH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Always start from an opaque canvas. GIF transparency optimization can
  // otherwise expose the black slide background at cropped viewport edges.
  ctx.fillStyle = pageColors.canvasBackground;
  ctx.fillRect(0, 0, mainW, mainH);

  // Main diagram frame
  drawBitmapContained(ctx, mainBmp, mainW, mainH);
  mainBmp.close();

  // Dark backdrop matching SubdiagramOverlay's background
  ctx.fillStyle = 'rgba(12, 13, 22, 0.86)';
  ctx.fillRect(0, 0, mainW, mainH);

  // Scale overlay card to fit frame (max 82% of frame, maintain aspect ratio)
  const { cardW, cardH, cardX, cardY, cardRadius } = getOverlayCardMetrics(mainW, mainH);

  // Clip to rounded card and draw overlay content
  ctx.save();
  overlayRoundRect(ctx, cardX, cardY, cardW, cardH, cardRadius);
  ctx.clip();
  ctx.drawImage(overlayBmp, cardX, cardY, cardW, cardH);
  overlayBmp.close();
  ctx.restore();

  // Subtle card border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  overlayRoundRect(ctx, cardX, cardY, cardW, cardH, cardRadius);
  ctx.stroke();

  return canvas;
}

async function compositeFrameBytes(mainDataUrl, overlayDataUrl, mainW, mainH, border = 'none', slideTemplate = null) {
  const canvas = await compositeFrame(mainDataUrl, overlayDataUrl, mainW, mainH);
  const out = slideTemplate
    ? compositeOntoTemplate(canvas, slideTemplate)
    : frameContentCanvas(canvas, mainW, mainH, border);
  return dataUrlToBytes(out.toDataURL('image/png'));
}

async function compositeFrameDataUrl(mainDataUrl, overlayDataUrl, mainW, mainH) {
  const canvas = await compositeFrame(mainDataUrl, overlayDataUrl, mainW, mainH);
  return canvas.toDataURL('image/png');
}

async function makeOpaqueFrameBytes(dataUrl, width, height, border = 'none', slideTemplate = null) {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = pageColors.canvasBackground;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawBitmapContained(ctx, bitmap, width, height);
  bitmap.close();
  const out = slideTemplate
    ? compositeOntoTemplate(canvas, slideTemplate)
    : frameContentCanvas(canvas, width, height, border);
  return dataUrlToBytes(out.toDataURL('image/png'));
}

async function renderPopupFrameDataUrl(popupWindow, localTime, overlayPixelRatio) {
  const overlayInfo = popupWindow.overlayInfo;
  if (!overlayInfo) return null;

  const nestedState = popupWindow.nestedEngine.getStateAtTime(localTime);
  applyAnimState(overlayInfo.contentLayer, nestedState, overlayInfo.nestedLinkRenders, null, {
    webs: overlayInfo.nestedWebs,
    webByLinkId: overlayInfo.nestedWebByLinkId,
    manualTokenTimingById: overlayInfo.nestedManualTokenTimingById,
    failingById: overlayInfo.nestedFailingById,
    linkFailureById: overlayInfo.nestedLinkFailureById,
    failAtEndsById: overlayInfo.nestedFailAtEndsById,
    failOnTokenEndById: overlayInfo.nestedFailOnTokenEndById,
    monitors: overlayInfo.nestedMonitors,
    currentTime: localTime,
  });
  overlayInfo.contentLayer.draw();

  let composedDataUrl = overlayInfo.offStage.toDataURL({
    mimeType: 'image/png',
    pixelRatio: overlayPixelRatio,
  });

  const activeChild = findActivePopupWindow(popupWindow.children, localTime);
  if (!activeChild) return composedDataUrl;

  const childTime = clamp(
    (localTime - activeChild.popupStart) * activeChild.popupPlaybackSpeed,
    0,
    activeChild.nestedContentDuration
  );
  const childDataUrl = await renderPopupFrameDataUrl(activeChild, childTime, overlayPixelRatio);
  if (!childDataUrl) return composedDataUrl;

  return compositeFrameDataUrl(
    composedDataUrl,
    childDataUrl,
    makeEven(Math.round(OVERLAY_W * overlayPixelRatio)),
    makeEven(Math.round(OVERLAY_H * overlayPixelRatio))
  );
}

// ── Main export function ─────────────────────────────────────────────────────

export async function exportToMP4({
  stageRef,
  layerRef,
  nodes,
  links,
  fps = 60,
  exportWidth = 1920,
  exportHeight = 1080,
  viewportRect = null,
  onProgress,
  onStatus,
}) {
  const stage = stageRef.current;
  const layer = layerRef.current;
  if (!stage || !layer) throw new Error('Canvas not ready');
  if (!nodes.length) throw new Error('Nothing to export. Add some nodes first.');

  onStatus?.('Loading FFmpeg WASM (~32 MB, cached after first use)…');
  const ffmpeg = await getFFmpeg();

  const engine = new AnimationEngine(nodes, links);
  const totalTime = engine.getTotalDuration();
  const totalFrames = Math.ceil(totalTime * fps);
  const linkRenders = computeLinkRenders(nodes, links);
  const mirrorBindings = buildMirrorBindings(nodes, links);
  const allLinkRenders = { ...linkRenders, ...mirrorBindings.linkRenders };
  const exportWebs = engine.getVariableWebs();
  const exportWebByLinkId = buildWebByLinkId(exportWebs);
  const exportMonitors = nodes.filter(n => n.type === 'monitor');
  const bindToTokenHopById = Object.fromEntries(links.map(l => [l.id, !!l.bindToTokenHop]));
  const bindMetaById = Object.fromEntries(links.map(l => [l.id, { offset: Number.isFinite(l.bindHopOffset) ? l.bindHopOffset : 0, scale: Number.isFinite(l.bindHopScale) && l.bindHopScale > 0 ? l.bindHopScale : 1 }]));
  const linkStartOverrideById = Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animStartTime)) ? l.animStartTime : null]));
  const linkDurationOverrideById = Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animDuration)) ? l.animDuration : null]));
  const manualTokenTimingById = computeManualTokenTimingByLinkId(links, engine.getTimeline());
  const failAtEndsById = Object.fromEntries(links.map(l => [l.id, !!l.failAtEnds]));
  const failOnTokenEndById = Object.fromEntries(links.map(l => [l.id, !!l.failOnTokenEnd]));
  const failingById = Object.fromEntries(links.map(l => [l.id, !!l.failing]));
  const linkFailureById = Object.fromEntries(links
    .filter(l => l.failureKeyframes?.length)
    .map(l => [l.id, { failureKeyframes: l.failureKeyframes }]));

  const stageW = stage.width();
  const stageH = stage.height();
  const crop = viewportRect && Number.isFinite(viewportRect.width) && Number.isFinite(viewportRect.height)
    ? { x: viewportRect.x || 0, y: viewportRect.y || 0, width: viewportRect.width, height: viewportRect.height }
    : null;
  const pixelRatio = crop
    ? getCropPixelRatio(crop, exportWidth, exportHeight)
    : (() => {
        const rawRatio = Math.max(exportWidth / stageW, exportHeight / stageH);
        const rawW = Math.round(stageW * rawRatio);
        return (Math.floor(rawW / 2) * 2) / stageW;
      })();
  const evenW = crop ? exportWidth : Math.floor((stageW * pixelRatio) / 2) * 2;
  const exportH = crop ? exportHeight : Math.round(stageH * pixelRatio);
  const { cardW } = getOverlayCardMetrics(evenW, exportH);
  const overlayPixelRatio = Math.max(1, Math.min(4, cardW / OVERLAY_W));

  const popupWindows = buildPopupRenderTree({
    nodes,
    links,
    engine,
    includePreviewPopups: true,
  });
  attachPopupOverlays(popupWindows);

  // Hide mirror chrome for clean export
  const mirrorChromeNodes = mirrorBindings.bindings
    .map(b => layer.findOne(`#mirror-chrome-${b.mirrorId}`))
    .filter(Boolean);
  mirrorChromeNodes.forEach(n => n.visible(false));

  onStatus?.(`Capturing ${totalFrames} frames…`);
  const frameBytes = [];

  const timelineStart = (() => { const tl = engine.getTimeline(); return tl && tl.length ? Math.min(...tl.map(ev => ev.start)) : 0; })();
  const restoreStageViewport = normalizeStageForExport(stage);

  // Export may begin after live preview has already moved or wrapped scrolling
  // groups. Start from the stored layout so every captured frame is derived only
  // from its timestamp and the scroll animation is preserved in the output.
  resetAnimState(layer, nodes, links, mirrorBindings);

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    // Re-assert identity each frame so a store-update re-render can't snap the
    // stage back to the live camera and drift the framing mid-export.
    lockStageIdentity(stage);
    const animState = engine.getStateAtTime(t, t);
    applyAnimState(layer, animState, allLinkRenders, mirrorBindings, {
      webs: exportWebs,
      webByLinkId: exportWebByLinkId,
      monitors: exportMonitors,
      currentTime: t,
      timelineStart,
      bindToTokenHopById,
      bindMetaById,
      linkStartOverrideById,
      linkDurationOverrideById,
      manualTokenTimingById,
      failAtEndsById,
      failOnTokenEndById,
      failingById,
      linkFailureById,
      isPlaying: true,
    });
    layer.draw();

    const toDataUrlOpts = crop
      ? { mimeType: 'image/png', pixelRatio, x: crop.x, y: crop.y, width: crop.width, height: crop.height }
      : { mimeType: 'image/png', pixelRatio };
    const mainDataUrl = stage.toDataURL(toDataUrlOpts);

    const activePopup = findActivePopupWindow(popupWindows, t);

    if (activePopup) {
      const nestedT = clamp(
        (t - activePopup.popupStart) * activePopup.popupPlaybackSpeed,
        0,
        activePopup.nestedContentDuration
      );
      const overlayDataUrl = await renderPopupFrameDataUrl(activePopup, nestedT, overlayPixelRatio);

      const bytes = await compositeFrameBytes(mainDataUrl, overlayDataUrl, evenW, exportH);
      frameBytes.push(bytes);
    } else {
      frameBytes.push(dataUrlToBytes(mainDataUrl));
    }

    if (frame % 15 === 0) {
      onProgress?.((frame / totalFrames) * 0.65);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  restoreStageViewport();

  // Restore mirror chrome and animation state
  mirrorChromeNodes.forEach(n => n.visible(true));
  resetAnimState(layer, nodes, links, mirrorBindings);

  // Clean up overlay stages
  destroyPopupOverlays(popupWindows);

  onStatus?.('Writing frames to encoder…');
  for (let i = 0; i < frameBytes.length; i++) {
    await ffmpeg.writeFile(`f${String(i).padStart(5, '0')}.png`, cloneBytes(frameBytes[i]));
    if (i % 30 === 0) {
      onProgress?.(0.65 + (i / frameBytes.length) * 0.15);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onStatus?.('Encoding H.264 MP4…');
  onProgress?.(0.8);

  const ffmpegLogs = [];
  const logHandler = ({ message }) => ffmpegLogs.push(message);
  ffmpeg.on('log', logHandler);

  try {
    await ffmpeg.exec([
      '-framerate', String(fps),
      '-i', 'f%05d.png',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '14',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-r', String(fps),
      '-movflags', '+faststart',
      'out.mp4',
    ]);
  } catch (err) {
    ffmpeg.off('log', logHandler);
    throw new Error(`FFmpeg encode failed:\n${ffmpegLogs.slice(-20).join('\n')}\n\nOriginal: ${err.message}`);
  }
  ffmpeg.off('log', logHandler);

  onProgress?.(0.95);
  onStatus?.('Preparing download…');

  const data = await ffmpeg.readFile('out.mp4');
  if (!data || data.byteLength < 1000) {
    throw new Error(`FFmpeg produced an invalid file (${data?.byteLength ?? 0} bytes).`);
  }

  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), { href: url, download: 'echo-vis-export.mp4' });
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  for (let i = 0; i < frameBytes.length; i++) {
    try { await ffmpeg.deleteFile(`f${String(i).padStart(5, '0')}.png`); } catch {}
  }
  try { await ffmpeg.deleteFile('out.mp4'); } catch {}

  onProgress?.(1);
  onStatus?.('Done!');
}

// Render a subrange [startTime, endTime] of the current animation to MP4 bytes
// and return a poster PNG from the first frame. Used by presentation exports.
export async function renderAnimationClipToMP4({
  stageRef,
  layerRef,
  nodes,
  links,
  startTime = 0,
  endTime = 0,
  fps = 60,
  exportWidth = 1920,
  exportHeight = 1080,
  viewport = null, // reserved for future crop; currently unused
  filePrefix = 'clip', // reserved; not used because we return bytes
  alsoGif = false,
  alsoApng = false,
  produceVideo = true,
  gifPlayOnce = true,
  gifScale = 1,
  captureScale = 1,
  // If true, encode frames for seamless looping:
  // - no extra boundary frame,
  // - no final hold in retiming,
  // - preserve first-frame transparency in GIF timing.
  gifLoopable = false,
  // GIF/APNG playback speed multiplier (2 = 2x, 0.5 = half-speed). When
  // producing video, this value is ignored so MP4 remains at real-time speed.
  gifPlaybackRate = 1,
  gifPaletteBytes = null,
  gifPaletteSampleTimes = [],
  initialFrameBytes = null,
  // Extra seconds to hold the final frame in GIF timing. APNG remains on last
  // frame naturally; this parameter is primarily for GIF cadence.
  gifHoldSeconds = 0,
  // Clean teal border drawn around every exported frame: 'none' | 'frame' | 'line'.
  border = 'none',
  // Imported slide image with a marked placeholder rectangle. When provided, each
  // exported frame is the full slide with the animation composited into the rect.
  //   { bitmap, width, height, rect: { x, y, w, h } }
  slideTemplate = null,
  onProgress,
  onStatus,
}) {
  const stage = stageRef.current;
  const layer = layerRef.current;
  if (!stage || !layer) throw new Error('Canvas not ready');
  if (!nodes.length) throw new Error('Nothing to export. Add some nodes first.');

  const clipLen = Math.max(0, (Number(endTime) ?? 0) - (Number(startTime) ?? 0));
  // For GIF/APNG, capture frames at an effective sample rate that achieves the
  // requested playback speed while preserving ~20ms cadence in common decoders.
  const useAltSampleForGif = (alsoGif || alsoApng) && !produceVideo;
  const effPlaybackRate = useAltSampleForGif ? Math.max(0.25, Number(gifPlaybackRate) || 1) : 1;
  const sampleFps = useAltSampleForGif ? (fps / effPlaybackRate) : fps;
  // Include the exact segment end so adjacent GIFs share an identical
  // boundary frame instead of jumping by one sample during slide changes.
  const animationFrames = Math.max(1, Math.ceil(clipLen * sampleFps));
  // For loopable sequences, avoid the extra boundary frame so the last->first
  // transition does not stutter. Non-loopable clips include the exact end.
  let totalFrames = gifLoopable
    ? animationFrames
    : (animationFrames + (clipLen > 0 ? 1 : 0));
  // Ensure at least 2 frames for GIF exports; single-frame GIFs can be rejected
  // or treated as static by some importers (notably Google Slides).
  if ((alsoGif || alsoApng) && totalFrames < 2) totalFrames = 2;

  if (!ffmpegReady) {
    onStatus?.('Loading FFmpeg WASM (~32 MB, cached after first use)…');
  }
  const ffmpeg = await getFFmpeg();

  const engine = new AnimationEngine(nodes, links);
  const linkRenders = computeLinkRenders(nodes, links);
  const mirrorBindings = buildMirrorBindings(nodes, links);
  const allLinkRenders = { ...linkRenders, ...mirrorBindings.linkRenders };
  const exportWebs = engine.getVariableWebs();
  const exportWebByLinkId = buildWebByLinkId(exportWebs);
  const exportMonitors = nodes.filter(n => n.type === 'monitor');
  const bindToTokenHopById = Object.fromEntries(links.map(l => [l.id, !!l.bindToTokenHop]));
  const bindMetaById = Object.fromEntries(links.map(l => [l.id, { offset: Number.isFinite(l.bindHopOffset) ? l.bindHopOffset : 0, scale: Number.isFinite(l.bindHopScale) && l.bindHopScale > 0 ? l.bindHopScale : 1 }]));
  const linkStartOverrideById = Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animStartTime)) ? l.animStartTime : null]));
  const linkDurationOverrideById = Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animDuration)) ? l.animDuration : null]));
  const manualTokenTimingById = computeManualTokenTimingByLinkId(links, engine.getTimeline());
  const failAtEndsById = Object.fromEntries(links.map(l => [l.id, !!l.failAtEnds]));
  const failOnTokenEndById = Object.fromEntries(links.map(l => [l.id, !!l.failOnTokenEnd]));
  const failingById = Object.fromEntries(links.map(l => [l.id, !!l.failing]));
  const linkFailureById = Object.fromEntries(links
    .filter(l => l.failureKeyframes?.length)
    .map(l => [l.id, { failureKeyframes: l.failureKeyframes }]));

  const stageW = stage.width();
  const stageH = stage.height();
  const crop = viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
    ? { x: viewport.x || 0, y: viewport.y || 0, width: viewport.width, height: viewport.height }
    : null;
  const pixelRatio = crop ? getCropPixelRatio(crop, exportWidth, exportHeight) : (() => {
    const rawRatio = Math.max(exportWidth / stageW, exportHeight / stageH);
    const rawW = Math.round(stageW * rawRatio);
    return (Math.floor(rawW / 2) * 2) / stageW;
  })();
  const evenW = crop ? exportWidth : Math.floor((stageW * pixelRatio) / 2) * 2;
  const exportH = crop ? exportHeight : Math.round(stageH * pixelRatio);
  const { cardW } = getOverlayCardMetrics(evenW, exportH);
  const overlayPixelRatio = Math.max(1, Math.min(4, cardW / OVERLAY_W));

  const popupWindows = buildPopupRenderTree({
    nodes,
    links,
    engine,
    includePreviewPopups: true,
  });
  attachPopupOverlays(popupWindows);

  // Hide mirror chrome for clean export
  const mirrorChromeNodes = mirrorBindings.bindings
    .map(b => layer.findOne(`#mirror-chrome-${b.mirrorId}`))
    .filter(Boolean);
  mirrorChromeNodes.forEach(n => n.visible(false));

  const frameBytes = [];
  const paletteFrameBytes = [];
  const timelineStart = (() => { const tl = engine.getTimeline(); return tl && tl.length ? Math.min(...tl.map(ev => ev.start)) : 0; })();
  const restoreStageViewport = normalizeStageForExport(stage);

  // Clear positions and wrap bookkeeping left by live preview or a previous slide.
  // Segment exports use absolute animation timestamps, so pass the same timestamp
  // explicitly as the scroll clock for deterministic GIF/APNG/MP4 frames.
  resetAnimState(layer, nodes, links, mirrorBindings);

  const captureFrameAtTime = async (t) => {
    // Guard against a mid-loop re-render snapping the stage back to the live
    // camera (see lockStageIdentity). Synchronous through toDataURL below.
    lockStageIdentity(stage);
    const animState = engine.getStateAtTime(t, t);
    applyAnimState(layer, animState, allLinkRenders, mirrorBindings, {
      webs: exportWebs,
      webByLinkId: exportWebByLinkId,
      monitors: exportMonitors,
      currentTime: t,
      timelineStart,
      bindToTokenHopById,
      bindMetaById,
      linkStartOverrideById,
      linkDurationOverrideById,
      manualTokenTimingById,
      failAtEndsById,
      failOnTokenEndById,
      failingById,
      linkFailureById,
      isPlaying: true,
    });
    layer.draw();

    const effPR = Math.max(0.5, Math.min(8, pixelRatio * (Number(captureScale) || 1)));
    const toDataUrlOpts = crop
      ? { mimeType: 'image/png', pixelRatio: effPR, x: crop.x, y: crop.y, width: crop.width, height: crop.height }
      : { mimeType: 'image/png', pixelRatio: effPR };
    const mainDataUrl = stage.toDataURL(toDataUrlOpts);
    const activePopup = findActivePopupWindow(popupWindows, t);
    if (!activePopup) return makeOpaqueFrameBytes(mainDataUrl, evenW, exportH, border, slideTemplate);

    const nestedT = clamp(
      (t - activePopup.popupStart) * activePopup.popupPlaybackSpeed,
      0,
      activePopup.nestedContentDuration
    );
    const overlayDataUrl = await renderPopupFrameDataUrl(activePopup, nestedT, overlayPixelRatio);
    return compositeFrameBytes(mainDataUrl, overlayDataUrl, evenW, exportH, border, slideTemplate);
  };

  onStatus?.(`Capturing ${totalFrames} frames (${startTime.toFixed(2)}s–${endTime.toFixed(2)}s)…`);
  for (let i = 0; i < totalFrames; i++) {
    const t = i === totalFrames - 1
      ? (endTime ?? startTime ?? 0)
      : (startTime ?? 0) + (i * (effPlaybackRate / fps));
    frameBytes.push(await captureFrameAtTime(t));

    if (i % 15 === 0) {
      onProgress?.(i / Math.max(1, totalFrames));
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (initialFrameBytes?.byteLength && frameBytes.length) {
    frameBytes[0] = cloneBytes(initialFrameBytes);
  }

  if (!gifPaletteBytes && alsoGif && Array.isArray(gifPaletteSampleTimes)) {
    onStatus?.('Sampling colors across all slides…');
    resetAnimState(layer, nodes, links, mirrorBindings);
    for (let i = 0; i < gifPaletteSampleTimes.length; i++) {
      paletteFrameBytes.push(await captureFrameAtTime(gifPaletteSampleTimes[i]));
      if (i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  restoreStageViewport();

  // Restore mirror chrome and animation state
  mirrorChromeNodes.forEach(n => n.visible(true));
  resetAnimState(layer, nodes, links, mirrorBindings);
  destroyPopupOverlays(popupWindows);

  // Prepare poster copy BEFORE passing frames to ffmpeg (ffmpeg may detach buffers)
  let posterBytes = new Uint8Array();
  if (frameBytes[0]) {
    posterBytes = new Uint8Array(frameBytes[0].length);
    posterBytes.set(frameBytes[0]);
  }

  // Write frames to FFmpeg FS (used for MP4/GIF/APNG encodes)
  onStatus?.('Preparing frames…');
  // Ensure a minimum number of frames for GIF/APNG so importers do not reject
  // near-static animations. Duplicate the last frame to reach the floor.
  const minFramesForGif = (alsoGif || alsoApng) ? 8 : 1;
  while (frameBytes.length > 0 && frameBytes.length < minFramesForGif) {
    const last = frameBytes[frameBytes.length - 1];
    frameBytes.push(cloneBytes(last));
  }
  for (let i = 0; i < frameBytes.length; i++) {
    await ffmpeg.writeFile(`c${String(i).padStart(5, '0')}.png`, cloneBytes(frameBytes[i]));
    if (i % 30 === 0) {
      onProgress?.(0.5 + (i / frameBytes.length) * 0.2);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  for (let i = 0; i < paletteFrameBytes.length; i++) {
    await ffmpeg.writeFile(`p${String(i).padStart(5, '0')}.png`, cloneBytes(paletteFrameBytes[i]));
  }

  // Optionally encode MP4
  let videoCopy = null;
  if (produceVideo) {
    const ffmpegLogs = [];
    const logHandler = ({ message }) => ffmpegLogs.push(message);
    ffmpeg.on('log', logHandler);
    try {
      onStatus?.('Encoding clip (H.264 MP4)…');
      await ffmpeg.exec([
        '-framerate', String(fps),
        '-i', 'c%05d.png',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '14',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', String(fps),
        '-movflags', '+faststart',
        'out.mp4',
      ]);
    } catch (err) {
      ffmpeg.off('log', logHandler);
      throw new Error(`FFmpeg encode failed (clip):\n${ffmpegLogs.slice(-20).join('\n')}\n\nOriginal: ${err.message}`);
    }
    ffmpeg.off('log', logHandler);

    const data = await ffmpeg.readFile('out.mp4');
    if (!data || data.byteLength < 1000) {
      throw new Error(`FFmpeg produced an invalid clip file (${data?.byteLength ?? 0} bytes).`);
    }

    // Clone bytes before deleting from FFmpeg FS to avoid detached buffer issues
    const copy = new Uint8Array(data.length);
    copy.set(data);
    videoCopy = copy;
  }

  // Optional: also produce a GIF using the same frames (palettegen/paletteuse)
  let gifBytes = null;
  let sharedGifPaletteBytes = gifPaletteBytes ? cloneBytes(gifPaletteBytes) : null;
  if (alsoGif) {
    try {
      onStatus?.(`Encoding GIF (${fps} FPS)…`);
      const gs = Math.max(0.5, Math.min(1, Number(gifScale) || 0.75));
      const cs = Math.max(0.5, Math.min(4, Number(captureScale) || 1));
      const eff = Math.max(0.5, Math.min(1, gs / cs));
      const scaleExpr = `scale=trunc(iw*${eff}/2)*2:trunc(ih*${eff}/2)*2:flags=lanczos`;
      // GIF delays are stored in centiseconds. Capture every requested frame,
      // then retime the output below to the closest evenly distributed cadence.
      if (sharedGifPaletteBytes) {
        await ffmpeg.writeFile('palette.png', cloneBytes(sharedGifPaletteBytes));
      } else {
        const paletteInput = paletteFrameBytes.length ? 'p%05d.png' : 'c%05d.png';
        await ffmpeg.exec([
          '-framerate', String(fps),
          '-i', paletteInput,
          // Generate a compact palette without reserving a transparent index.
          '-vf', `${scaleExpr},palettegen=stats_mode=full`,
          'palette.png',
        ]);
        const paletteData = await ffmpeg.readFile('palette.png');
        sharedGifPaletteBytes = cloneBytes(paletteData);
      }
      await ffmpeg.exec([
        // Feed the exact frame sequence; avoid output -r so ffmpeg doesn't retime
        '-framerate', String(fps),
        '-i', 'c%05d.png',
        '-i', 'palette.png',
        // Ordered dithering preserves color fidelity without introducing
        // frame-to-frame noise; the shared palette keeps slide boundaries stable.
        '-lavfi', `${scaleExpr}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
        // Keep ffmpeg's default frame optimization (offsetting + transdiff).
        // retimeGif preserves the per-frame transparency flag, so the diffed
        // frames decode correctly and stay compact.
        '-gifflags', '0',
        // Loop control for the muxer: -1 means no extension (play once), 0 means infinite loop
        '-loop', gifPlayOnce ? '-1' : '0',
        'out.gif',
      ]);
      const gifData = await ffmpeg.readFile('out.gif');
      let gifCopy = new Uint8Array(gifData.length);
      gifCopy.set(gifData);
      const gifFrameCount = countGifFrames(gifCopy);
      if (gifFrameCount !== frameBytes.length) {
        console.warn(`GIF encoder preserved ${gifFrameCount}/${frameBytes.length} frames at ${fps} FPS (continuing).`);
      }
      // Apply precise timing including any requested final-frame hold so the
      // clip ends at the last slide break and visibly rests before advancing.
      const effectiveGifSeconds = (Math.max(0, Number(clipLen) || 0) / Math.max(0.25, Number(effPlaybackRate) || 1));
      const totalGifSeconds = Math.max(
        Math.max(0.1, Number(GIF_EXPORT_MIN_DURATION_SEC) || 0),
        effectiveGifSeconds + (gifLoopable ? 0 : Math.max(0, Number(gifHoldSeconds) || 0))
      );
      gifCopy = retimeGif(gifCopy, fps, totalGifSeconds, { loopable: gifLoopable });
      gifCopy = padGifToMinBytes(gifCopy, 24576);
      gifBytes = gifCopy;
    } catch (err) {
      throw new Error(`GIF encode failed: ${err.message}`);
    }
  }

  // Optional: APNG (24-bit color, smoother timing). Plays once and holds last frame.
  let apngBytes = null;
  if (alsoApng) {
    try {
      onStatus?.('Encoding APNG…');
      // FFmpeg optimizes APNGs into cropped delta frames with mixed disposal
      // modes. Some renderers retain those old pixels, producing dark trails.
      // Use the original fps for per-frame timing. Combined with sampling at
      // (fps / gifPlaybackRate), this yields total duration clipLen / rate.
      apngBytes = buildFullFrameApng(frameBytes, fps, 1);
    } catch (err) {
      console.warn('APNG encode failed; continuing without APNG:', err);
    }
  }

  // Cleanup frames and temp files
  for (let i = 0; i < frameBytes.length; i++) {
    try { await ffmpeg.deleteFile(`c${String(i).padStart(5, '0')}.png`); } catch {}
  }
  for (let i = 0; i < paletteFrameBytes.length; i++) {
    try { await ffmpeg.deleteFile(`p${String(i).padStart(5, '0')}.png`); } catch {}
  }
  try { await ffmpeg.deleteFile('palette.png'); } catch {}
  try { await ffmpeg.deleteFile('out.png'); } catch {}
  try { await ffmpeg.deleteFile('out.gif'); } catch {}
  try { await ffmpeg.deleteFile('out.mp4'); } catch {}

  const mediaDuration = clipLen > 0
    ? (useAltSampleForGif ? (clipLen / Math.max(0.25, Number(effPlaybackRate) || 1)) : clipLen)
    : (frameBytes.length / fps);
  onProgress?.(1);
  return {
    ...(videoCopy ? { videoBytes: videoCopy } : {}),
    posterBytes,
    mediaDuration,
    ...(gifBytes ? { gifBytes } : {}),
    ...(sharedGifPaletteBytes ? { gifPaletteBytes: cloneBytes(sharedGifPaletteBytes) } : {}),
    ...(frameBytes.length ? { lastFrameBytes: cloneBytes(frameBytes[frameBytes.length - 1]) } : {}),
    ...(apngBytes ? { apngBytes } : {}),
  };
}
