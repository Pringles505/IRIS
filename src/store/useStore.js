import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { pageColors, withAlpha } from '../colorThemes';
import { normalizeTextMorphList } from '../text/textMorphs';
import { getNodeDisplayText, EQUATION_FONT_FAMILY } from '../text/equationText';
import { getMirrorSelectionPayload, isMirrorNode } from '../mirror/mirrorData';
import { PPTX_EXPORT_SIZE } from '../presentation/pptxFrame';
import { getTimelineCursor } from '../timelineCursor';
import { getManualTokenLinkId } from '../animation/manualTokenTiming';
import { normalizeNodeFailureKeyframes } from '../animation/nodeFailureTiming';
import { buildLinkRenderData, getLinkParallelOffset } from '../links/linkGeometry';
import { DEFAULT_ALIGNMENT_SETTINGS, orthogonalizeJointPoint } from '../components/canvas/alignmentEngine';

// Alignment/snapping preferences persist across sessions (app-level, not
// per-project — same model as Figma/draw.io).
const ALIGNMENT_SETTINGS_KEY = 'echo-vis-alignment-settings';
function loadAlignmentSettings() {
  try {
    const raw = localStorage.getItem(ALIGNMENT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ALIGNMENT_SETTINGS };
    return { ...DEFAULT_ALIGNMENT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ALIGNMENT_SETTINGS };
  }
}

// Arrow-key nudges arrive in bursts (key repeat); collapse a burst into one
// undo step instead of one per keypress.
let lastNudgeAt = 0;

// Cross-tab clipboard for the Ctrl+B alignment ghost. localStorage is shared across
// all tabs of the same origin, so a selection copied in one tab can be ghost-pasted in
// another.
const GHOST_CLIPBOARD_KEY = 'echo-vis-ghost-clipboard';
// Cross-tab real clipboard (for Ctrl+C/Ctrl+V actual paste, not just ghost). We also
// attempt to use the async Clipboard API so copy/paste works across tabs and windows
// even when localStorage quota is exceeded by very large selections.
const CROSS_TAB_CLIPBOARD_KEY = 'echo-vis-clipboard';

// ── IndexedDB clipboard (large selections, cross-tab) ───────────────────────
let _idbClipDb = null;
function openClipboardDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    if (_idbClipDb) { resolve(_idbClipDb); return; }
    const req = indexedDB.open('ECHO_VIS_DB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('clipboard')) {
        db.createObjectStore('clipboard', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { _idbClipDb = req.result; resolve(_idbClipDb); };
    req.onerror = () => { resolve(null); };
  });
}

async function idbWriteClipboard(payload) {
  try {
    const db = await openClipboardDb();
    if (!db) return false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('clipboard', 'readwrite');
      const store = tx.objectStore('clipboard');
      store.put({ id: 'global', ts: Date.now(), data: payload });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    return true;
  } catch { return false; }
}

async function idbReadClipboard() {
  try {
    const db = await openClipboardDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction('clipboard', 'readonly');
      const store = tx.objectStore('clipboard');
      const req = store.get('global');
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export function isAreaNode(node) { return node?.type === 'area'; }
export function isSubdiagramNode(node) { return node?.type === 'subdiagram'; }
export function isMonitorNode(node) { return node?.type === 'monitor'; }

function snapshotMirrorOverrides(sourceNodes, sourceLinks, existingNodeOverrides = {}, existingLinkOverrides = {}) {
  const mirrorNodeOverrides = { ...existingNodeOverrides };
  for (const node of sourceNodes) {
    if (!mirrorNodeOverrides[node.id]) {
      mirrorNodeOverrides[node.id] = {
        label: node.label,
        fill: node.fill,
        stroke: node.stroke,
        textColor: node.textColor,
      };
    }
  }
  const mirrorLinkOverrides = { ...existingLinkOverrides };
  for (const link of sourceLinks) {
    if (!mirrorLinkOverrides[link.id]) {
      mirrorLinkOverrides[link.id] = { stroke: link.stroke };
    }
  }
  return { mirrorNodeOverrides, mirrorLinkOverrides };
}

export const NODE_SHAPE_PRESETS = {
  rectangle: { shape: 'rectangle', width: 150, height: 52, cornerRadius: 0 },
  rounded: { shape: 'rounded', width: 150, height: 52, cornerRadius: 10 },
  pill: { shape: 'pill', width: 176, height: 54, cornerRadius: 999 },
  database: { shape: 'database', width: 168, height: 64, cornerRadius: 12 },
  cylinder: { shape: 'cylinder', width: 160, height: 58, cornerRadius: 12 },
  diamond: { shape: 'diamond', width: 154, height: 86, cornerRadius: 0 },
  hexagon: { shape: 'hexagon', width: 168, height: 92, cornerRadius: 0 },
  slanted: { shape: 'slanted', width: 168, height: 58, cornerRadius: 0 },
  circle: { shape: 'circle', width: 96, height: 96, cornerRadius: 999 },
  // A compact "module" block (rounded body with side connector pins) meant to
  // represent a protocol as one component.
  protocol: { shape: 'protocol', width: 152, height: 60, cornerRadius: 10 },
};

function createTransformTarget(overrides = {}) {
  return {
    label: '',
    width: 150,
    height: 52,
    fill: pageColors.blueNodeFill,
    stroke: pageColors.blueNodeStroke,
    textColor: pageColors.white,
    strokeWidth: 2,
    shape: 'rounded',
    cornerRadius: 8,
    showSubBadge: false,
    ...overrides,
  };
}

function normalizeTransformTarget(target, fallback = {}) {
  return createTransformTarget({
    ...fallback,
    ...(target ?? {}),
  });
}

const NODE_DEFAULTS = {
  type: 'node',
  shape: 'rounded',
  width: 150,
  height: 52,
  fill: pageColors.blueNodeFill,
  stroke: pageColors.blueNodeStroke,
  strokeWidth: 2,
  cornerRadius: 8,
  fontSize: 13,
  textColor: pageColors.white,
  // When true, the node label renders in a bold weight.
  bold: false,
  // Highlight "aura": a soft cutout behind the label that erases surrounding nodes/links
  // so the real page background shows through and the text reads clearly. textAuraSize
  // is the soft feather radius (px); textAuraOpacity is how fully it clears.
  textAura: false,
  // Aura mode:
  //  - 'cutout' (default): destination-out clears through to the real background
  //  - 'solid': draws a solid colour plate behind the text (covers content)
  textAuraMode: 'cutout',
  // When mode is 'solid', the fill colour to use behind the text
  textAuraColor: pageColors.canvasBackground,
  textAuraOpacity: 0.7,
  textAuraSize: 16,
  label: 'Node',
  textAnimMode: 'fade',
  textMorphs: [],
  failing: false,
  failureKeyframes: [],
  offline: false,
  animStartTime: null,
  animDuration: null,
  // When true, the node skips its entry fade/scale-in and appears instantly the
  // moment its keyframe (animStartTime) is reached. Morphs/transforms still play.
  disableAnimation: false,
  triggerAfterLinkId: null,
  triggerMode: 'overlap',
  triggerDelay: 0,
  popupValue: '',
  // Simple popup bubble during playback (independent of subdiagram overlay popups)
  showSimplePopupInPlayback: false,
  simplePopupDelay: 0.2,
  simplePopupDuration: 0.7,
  popupStayOpen: false,
  popupFill: null,
  popupWidth: null,
  popupHeight: null,
  // Per-variable kill switch at this node: when true for a variable id,
  // that variable's token stops here and does not traverse any downstream links.
  tokenKillFor: {},
  transformMode: 'none',
  transformTargetNodeId: null,
  transformStartTime: null,
  transformDuration: 0.4,
  transformTarget: createTransformTarget({ label: 'Node' }),
  anchors: [],
};

const TEXT_NODE_DEFAULTS = {
  ...NODE_DEFAULTS,
  type: 'text',
  fill: pageColors.transparent,
  stroke: pageColors.transparent,
  strokeWidth: 0,
  cornerRadius: 0,
  label: 'Text',
  equationMode: false,
  textPadX: 14,
  textPadY: 8,
};

const VARIABLE_NODE_DEFAULTS = {
  ...NODE_DEFAULTS,
  type: 'variable',
  label: 'Variable',
  variableLabel: 'var',
  variableValue: '',
  // Token visibility along the variable's outgoing web:
  //   'visual' → token is drawn flowing through links
  //   'silent' → value still flows logically (monitors update) but no token sprite
  inputMode: 'visual',
  // Time the token spends on each link in the variable's web. Drives speed.
  tokenHopDuration: 0.6,
  // Extra delay applied AFTER the natural chain origin (variable draw end + link draw end).
  tokenStartOffset: 0,
  // Per-variable token appearance overrides. null → inherit the global
  // simulateOptions value, otherwise this variable's token uses these.
  tokenText: null,
  tokenShape: null,
  tokenSize: null,
  tokenFill: null,
  tokenStroke: null,
  tokenTextColor: null,
  tokenTextSize: null,
  width: 180,
  height: 60,
  fill: withAlpha(pageColors.purpleAccent, 0.12),
  stroke: pageColors.purpleAccent,
  textColor: pageColors.white,
  strokeWidth: 2,
  shape: 'rounded',
  cornerRadius: 10,
};

const MONITOR_NODE_DEFAULTS = {
  ...NODE_DEFAULTS,
  type: 'monitor',
  shape: 'rounded',
  width: 200,
  height: 72,
  cornerRadius: 10,
  strokeWidth: 2,
  fill: withAlpha(pageColors.purpleAccent, 0.10),
  stroke: pageColors.purpleAccent,
  textColor: pageColors.white,
  label: 'Monitor',
  monitorTitle: '',
  showMonitorTag: true,
  // Variable-node id or manual-token track id selected by this monitor.
  variableNodeId: null,
  // Each watch: { id, nodeId, template }. nodeId must belong to the tracked
  // variable's web — the PropertiesPanel filters candidates accordingly.
  monitorWatches: [],
  // Text shown before the variable's token has reached any watched node.
  initialValue: '',
};

const GRAPH_NODE_DEFAULTS = {
  ...NODE_DEFAULTS,
  type: 'graph',
  label: 'Graph',
  width: 260,
  height: 160,
  cornerRadius: 10,
  // Keep a subtle purple tint to differentiate visually
  fill: withAlpha(pageColors.purpleAccent, 0.10),
  stroke: pageColors.purpleAccent,
  textColor: pageColors.white,
  strokeWidth: 2,
  // Graph-specific
  formula: 'y = sin(x)', // Accepts: 'y = …' or 'y^2 = …' (EC-style)
  graphParams: 'a=-1, b=1',
  xMin: -10,
  xMax: 10,
  yMin: null,
  yMax: null,
  centerX: null,
  centerY: null,
  samples: 400,
  showAxes: true,
  showCoords: false,
  graphPoints: [], // { id, x, y, size?, fill?, stroke?, startTime?, duration?, afterVector? }
  graphVectors: [], // { id, fromId, toId, color?, width?, headLength?, headWidth? }
  // HKDF domain separation: each circle is an independent output domain (one "info" label)
  showDomains: false,
  // { id, label, labelColor?, labelSize?, cx, cy, r, color, startTime?, duration?,
  //   calc?: { time, duration, count, dotColor?, dotSize?, seed } } — `calc` is the
  //   optional "calculate" keyframe that scatters dots inside the domain over time.
  //   Labels render on top of all domain dots.
  graphDomains: [],
  vectorSpeed: 0.2, // seconds per vector animation
  graphChainPlayback: true, // when true, auto-join points and alternate point/vector by vectorSpeed
  // Deprecated: pointsFollowVectors/pointsSequentialWithVectors removed — points now
  // appear at runtime based on vector playback when sequential is enabled.
  // Styling defaults
  graphPointSizeDefault: 4,
  graphPointFillDefault: '#A66BFF',
  graphPointStrokeDefault: '#FFFFFF',
  vectorColorDefault: '#FFFFFF',
  vectorWidthDefault: 1.5,
  vectorHeadLengthDefault: 8,
  vectorHeadWidthDefault: 8,
};

const MIRROR_NODE_DEFAULTS = {
  ...NODE_DEFAULTS,
  type: 'mirror',
  shape: 'rounded',
  width: 320,
  height: 220,
  fill: 'transparent',
  stroke: pageColors.purpleAccent,
  strokeWidth: 2,
  cornerRadius: 12,
  label: 'Mirror',
  sourceNodeIds: [],
  sourceLinkIds: [],
  mirrorMode: 'mirror',
  mirrorNodeOverrides: {},
  mirrorLinkOverrides: {},
  mirrorScale: 1,
};

const AREA_DEFAULTS = {
  type: 'area',
  width: 340,
  height: 240,
  fill: withAlpha(pageColors.purpleAccent, 0.07),
  stroke: pageColors.purpleAccent,
  strokeWidth: 1.5,
  cornerRadius: 12,
  label: 'Area',
  fontSize: 12,
  textColor: pageColors.purpleAccent,
  // When true, the area is not drawn in the canvas or exports. It still
  // participates in scrolling/clipping behavior and selection via editor chrome.
  areaInvisible: false,
  areaAnimMode: 'fade',  // 'fade' | 'draw'
  areaOpacity: 1,
  // Scroll mode: during playback the nodes inside this area's bounds continuously
  // scroll and wrap, with soft edge fade — e.g. an endless double-ratchet message feed.
  scrollEnabled: false,
  scrollAxis: 'up',      // 'up' | 'down' | 'left' | 'right'
  scrollSpeed: 40,       // pixels per second
  scrollGap: 0,          // extra spacing added to the wrap period
  scrollFade: true,      // soft-fade members as they cross the area edges
  scrollSeamless: true,  // snap speed so the loop has no jump when the clip repeats
  scrollStartTime: 0,    // seconds to hold still before the scroll begins (first run)
  scrollMode: 'continuous', // 'continuous' glide | 'stepped' one-tile-per-run jumps
  scrollStepInterval: 1, // seconds per step (hold + shift) when stepped w/o keyframes
  scrollStepDuration: 0.4, // seconds of the shift transition within each step
  scrollSteps: [],       // keyframed steps [{ id, time, duration }]; each advances one tile
  scrollTiles: 0,        // 0 = auto-detect; >0 sets a minimum tile count for the loop
  scrollTileSize: 0,     // 0 = auto-detect tile pitch; >0 forces one tile/step distance (px)
  animStartTime: null,
  animDuration: null,
  disableAnimation: false,
};

const SUBDIAGRAM_DEFAULTS = {
  type: 'subdiagram',
  shape: 'rounded',
  width: 150,
  height: 52,
  cornerRadius: 8,
  label: 'Sub-diagram',
  fontSize: 13,
  fill: pageColors.blueNodeFill,
  stroke: pageColors.blueNodeStroke,
  textColor: pageColors.textMain,
  variableLabel: '',
  snapshotNodes: [],
  snapshotLinks: [],
  sourceProjectId: null,
  popupTitle: '',
  showSubBadge: true,
  failing: false,
  failureKeyframes: [],
  offline: false,
  showPopupInPlayback: false,
  popupDelay: 0.4,
  popupPlaybackSpeed: 1,
  popupHold: 0.9,
  transformMode: 'none',
  transformTargetNodeId: null,
  transformStartTime: null,
  transformDuration: 0.4,
  transformTarget: createTransformTarget({
    label: 'Sub-diagram',
    textColor: pageColors.textMain,
    showSubBadge: true,
  }),
  animStartTime: null,
  animDuration: null,
  disableAnimation: false,
  triggerAfterLinkId: null,
  triggerMode: 'overlap',
  triggerDelay: 0,
  anchors: [],
};

  const LINK_DEFAULTS = {
  stroke: pageColors.blueNodeStroke,
  strokeWidth: 2,
  showArrowTip: false,
  arrowTipMode: 'flow',
  failing: false,
  // When true, show a fail mark at the start or end of the link
  // right when the drawing head reaches that endpoint.
  failAtEnds: false,
  // When true, fail when the TOKEN reaches the link's end (to-node),
  // regardless of draw direction or manual token invert.
  failOnTokenEnd: false,
  exemptFromSync: false,
  syncGroupKey: null,
  messageLabel: '',
  // Bind this link's animation to a variable token hop timing
  bindToTokenHop: false,
  // When set, bind specifically to this variable's hop on this link; otherwise first available
  bindVariableId: null,
  // Additive offset (seconds) relative to hop start when bound
  bindHopOffset: 0,
  // Scale factor applied to hop duration when bound (1 = same)
  bindHopScale: 1,
  // If true and binding is enabled, auto-trigger the target node to appear at hop end when toggled on via UI
  autoTriggerTarget: true,
  fromJunctionLinkId: null,
  fromJunctionJointId: null,
  toJunctionLinkId: null,
  toJunctionJointId: null,
  fromAnchorSide: null,
  toAnchorSide: null,
  fromAnchorLockedCenter: false,
  toAnchorLockedCenter: false,
  fromAnchorId: null,
  toAnchorId: null,
  fromAlongPos: 0,
  toAlongPos: 0,
  animStartTime: null,
  animDuration: null,
    // When true, the link skips its draw-in animation and appears fully drawn
    // the instant its keyframe (animStartTime) is reached.
    disableAnimation: false,
    // Per-hop override for variable token timing. null → use the variable's
    // tokenHopDuration default. Otherwise this link's hop takes exactly this many seconds.
    tokenHopDuration: null,
    // Extra delay inserted BEFORE this hop runs (clamped ≥ 0). 0 means the hop
    // starts at its natural chained time (max of upstream-end and link draw end).
    tokenHopDelay: 0,
    // When true, this link's hop is excluded from the variable's token animation.
    // Downstream hops chain normally; the token "jumps" across this link in zero time.
    tokenHopSkip: false,
    // Per-variable hop overrides: { [variableNodeId]: { skip?: boolean, delay?: number, duration?: number|null } }
    // If a property is present under the variable id, it takes precedence over the global tokenHop* above.
    tokenHopOverrides: {},
    joints: [],
    // Manual per-link token (independent of variables)
    manualTokenEnabled: false,
    // 'start' → begin X sec after link begins; 'end' → begin X sec after link completes
    manualTokenAnchor: 'start',
    manualTokenDelay: 0,
    // null preserves the link animation duration until the user sets a travel time.
    manualTokenDuration: null,
    // When true, the manual token travels from target back to source (reverse).
    manualTokenInvert: false,
    // Optional variable identity exposed to Monitor nodes. Empty values fall
    // back to the link message so existing manual tokens remain trackable.
    manualTokenVariableName: '',
    manualTokenVariableValue: '',
    // Absolute timeline keyframes: { id, time, text }.
    manualTokenTextKeyframes: [],
    // When false, render the message above the token instead of over its shape.
    manualTokenMessageOverlap: true,
    // Per-link appearance overrides. null inherits variable/global token styling.
    manualTokenColor: null,
    manualTokenSize: null,
    manualTokenTextColor: null,
    manualTokenTextSize: null,
  };

const MAX_HISTORY = 60;

// Merge a (possibly older) saved link with current defaults so new fields exist,
// mirroring what normalizeNode does for nodes. Nested containers get fresh
// copies so loaded links never share the defaults' array/object instances.
function normalizeLink(link) {
  return {
    ...LINK_DEFAULTS,
    ...link,
    joints: (link.joints ?? []).map(joint => ({ ...joint })),
    tokenHopOverrides: { ...(link.tokenHopOverrides ?? {}) },
    manualTokenTextKeyframes: (link.manualTokenTextKeyframes ?? []).map(kf => ({ ...kf })),
  };
}

// Strip references other elements hold to deleted nodes/links, so behavior
// degrades explicitly (back to defaults) instead of via silent lookup misses —
// e.g. a node triggered by a deleted link goes back to free scheduling.
function cleanDanglingRefs(nodes, removedNodeIds, removedLinkIds) {
  return nodes.map(node => {
    let next = node;
    const ensure = () => (next === node ? (next = { ...node }) : next);
    if (node.triggerAfterLinkId && removedLinkIds.has(node.triggerAfterLinkId)) {
      ensure().triggerAfterLinkId = null;
    }
    if (node.transformTargetNodeId && removedNodeIds.has(node.transformTargetNodeId)) {
      ensure().transformTargetNodeId = null;
      if (node.transformMode === 'existing') ensure().transformMode = 'none';
    }
    if (node.variableNodeId) {
      const manualLinkId = getManualTokenLinkId(node.variableNodeId);
      if (removedNodeIds.has(node.variableNodeId) || (manualLinkId && removedLinkIds.has(manualLinkId))) {
        ensure().variableNodeId = null;
      }
    }
    if ((node.monitorWatches ?? []).some(watch => removedNodeIds.has(watch.nodeId))) {
      ensure().monitorWatches = node.monitorWatches.filter(watch => !removedNodeIds.has(watch.nodeId));
    }
    if ((node.sourceNodeIds ?? []).some(id => removedNodeIds.has(id))) {
      ensure().sourceNodeIds = node.sourceNodeIds.filter(id => !removedNodeIds.has(id));
    }
    if ((node.sourceLinkIds ?? []).some(id => removedLinkIds.has(id))) {
      ensure().sourceLinkIds = node.sourceLinkIds.filter(id => !removedLinkIds.has(id));
    }
    return next;
  });
}

// ── Coalesced history for high-frequency edits ───────────────────────────────
// Inspector sliders, color pickers and drags call updateNode/updateLink on every
// input event. One snapshot per event would flood the undo stack; none (the old
// behavior) made those edits non-undoable. Instead, push one snapshot when a
// burst of same-kind edits begins and fold the rest of the burst into it.
const COALESCE_WINDOW_MS = 800;
let _lastHistoryPush = { key: null, at: 0 };

// Measure text with a real canvas context so wide glyphs and non-Latin text get
// an accurate box (a chars × fontSize heuristic overflows on those). Falls back
// to the old estimate in non-DOM environments (tests).
let _textMeasureCtx;
function measureLineWidth(line, fontSize, fontFamily) {
  if (_textMeasureCtx === undefined) {
    _textMeasureCtx = typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null;
  }
  if (!_textMeasureCtx) return line.length * fontSize * 0.62;
  _textMeasureCtx.font = `${fontSize}px ${fontFamily}`;
  return _textMeasureCtx.measureText(line).width;
}

function getTextNodeSize(label, fontSize, textPadX = TEXT_NODE_DEFAULTS.textPadX, textPadY = TEXT_NODE_DEFAULTS.textPadY, equationMode = false) {
  const safeLabel = (label ?? '').trim() || 'Text';
  const displayText = getNodeDisplayText({ equationMode }, safeLabel);
  const lines = displayText.split('\n');
  const fontFamily = equationMode ? EQUATION_FONT_FAMILY : 'Inter, system-ui, sans-serif';
  const widestLine = lines.reduce((widest, line) => Math.max(widest, measureLineWidth(line, fontSize, fontFamily)), 0);
  const lineHeight = equationMode ? 1.6 : 1.45;
  return {
    width: Math.max(44, Math.ceil(widestLine + textPadX * 2)),
    height: Math.max(26, Math.ceil(lines.length * fontSize * lineHeight + textPadY * 2)),
  };
}

function normalizeNode(node, updates = {}) {
  const nextNode = {
    ...node,
    ...updates,
    textMorphs: normalizeTextMorphList(updates.textMorphs ?? node.textMorphs ?? []),
    failureKeyframes: normalizeNodeFailureKeyframes(updates.failureKeyframes ?? node.failureKeyframes ?? []),
    transformTarget: normalizeTransformTarget(
      updates.transformTarget ?? node.transformTarget,
      {
        label: updates.label ?? node.label ?? '',
        width: updates.width ?? node.width ?? 150,
        height: updates.height ?? node.height ?? 52,
        fill: updates.fill ?? node.fill ?? pageColors.blueNodeFill,
        stroke: updates.stroke ?? node.stroke ?? pageColors.blueNodeStroke,
        textColor: updates.textColor ?? node.textColor ?? pageColors.white,
        strokeWidth: updates.strokeWidth ?? node.strokeWidth ?? 2,
        shape: updates.shape ?? node.shape ?? 'rounded',
        cornerRadius: updates.cornerRadius ?? node.cornerRadius ?? 8,
        showSubBadge: (updates.type ?? node.type) === 'subdiagram'
          ? (updates.showSubBadge ?? node.showSubBadge ?? true)
          : false,
      }
    ),
  };
  if (updates.failing === true) nextNode.offline = false;
  if (updates.offline === true) nextNode.failing = false;
  if (nextNode.type === 'mirror') {
    return {
      ...nextNode,
      sourceNodeIds: [...(nextNode.sourceNodeIds ?? [])],
      sourceLinkIds: [...(nextNode.sourceLinkIds ?? [])],
      mirrorNodeOverrides: { ...(nextNode.mirrorNodeOverrides ?? {}) },
      mirrorLinkOverrides: { ...(nextNode.mirrorLinkOverrides ?? {}) },
    };
  }
  if (nextNode.type !== 'text') return nextNode;

  const hasExplicitSize = Object.prototype.hasOwnProperty.call(updates, 'width') || Object.prototype.hasOwnProperty.call(updates, 'height');
  if (hasExplicitSize) return nextNode;

  return {
    ...nextNode,
    ...getTextNodeSize(nextNode.label, nextNode.fontSize, nextNode.textPadX, nextNode.textPadY, nextNode.equationMode),
  };
}

// Resolve a node's final animated appearance — the state shown on the very last
// frame of its animation — so "strip" can bake it as the node's static base.
// Mirrors the runtime rules: the latest text morph defines the form (any property
// it leaves unset falls back to the node's own default, never an earlier morph).
function resolveFinalMorphForm(node) {
  const form = {
    label: node.label,
    fill: node.fill,
    stroke: node.stroke,
    textColor: node.textColor,
    strokeWidth: node.strokeWidth,
    cornerRadius: node.cornerRadius,
    shape: node.shape,
  };
  const morphs = normalizeTextMorphList(node.textMorphs ?? []);
  if (morphs.length) {
    const last = morphs[morphs.length - 1]; // normalized list is sorted by startTime
    if (last.text != null) form.label = last.text;
    if (last.fill != null) form.fill = last.fill;
    if (last.stroke != null) form.stroke = last.stroke;
    if (last.textColor != null) form.textColor = last.textColor;
    if (last.strokeWidth != null) form.strokeWidth = last.strokeWidth;
    if (last.cornerRadius != null) form.cornerRadius = last.cornerRadius;
  } else if (node.morphText) {
    form.label = node.morphText;
  }
  return form;
}

// Build the updates that bake a node into its end-of-animation state and remove
// every animation keyframe/timing field, so the node renders statically from the
// first frame. A transform (which plays after morphs) wins over the morph form.
function resolveStrippedNodeUpdates(node, nodeMap) {
  let form = resolveFinalMorphForm(node);
  const transformMode = node.transformMode ?? (node.transformTargetNodeId ? 'existing' : 'none');
  if (transformMode === 'custom' && node.transformTarget) {
    const tt = node.transformTarget;
    form = {
      label: tt.label ?? form.label,
      fill: tt.fill ?? form.fill,
      stroke: tt.stroke ?? form.stroke,
      textColor: tt.textColor ?? form.textColor,
      strokeWidth: tt.strokeWidth ?? form.strokeWidth,
      cornerRadius: tt.cornerRadius ?? form.cornerRadius,
      shape: tt.shape ?? form.shape,
    };
  } else if (transformMode === 'existing' && node.transformTargetNodeId) {
    const target = nodeMap[node.transformTargetNodeId];
    if (target && target.id !== node.id && target.type !== 'mirror') {
      form = resolveFinalMorphForm(target);
    }
  }

  const updates = {
    label: form.label,
    fill: form.fill,
    stroke: form.stroke,
    textColor: form.textColor,
    strokeWidth: form.strokeWidth,
    cornerRadius: form.cornerRadius,
    shape: form.shape,
    // Drop all animation keyframes / timing so the baked state is the first frame.
    textMorphs: [],
    failureKeyframes: [],
    morphText: '',
    transformMode: 'none',
    transformTargetNodeId: null,
    transformStartTime: null,
    animStartTime: 0,
    animDuration: null,
    triggerAfterLinkId: null,
    triggerMode: 'overlap',
    triggerDelay: 0,
  };

  // Monitors display `initialValue` rather than `label`; bake the final text there.
  if (node.type === 'monitor') {
    updates.initialValue = form.label;
  }

  // Graph nodes time their points; make them appear immediately and statically.
  if (node.type === 'graph') {
    updates.graphChainPlayback = false;
    updates.graphPoints = (node.graphPoints ?? []).map(point => ({
      ...point,
      startTime: 0,
      duration: 0.0001,
    }));
  }

  return updates;
}

// Strip a connecting link's animation: draw it immediately, no token keyframes.
function resolveStrippedLinkUpdates() {
  return {
    animStartTime: 0,
    animDuration: null,
    manualTokenTextKeyframes: [],
    bindToTokenHop: false,
  };
}

function collectDescendantLinkIds(linkIds, links) {
  const queue = [...linkIds];
  const seen = new Set(queue);

  while (queue.length) {
    const currentId = queue.shift();
    for (const link of links) {
      if (seen.has(link.id)) continue;
      if (link.fromJunctionLinkId === currentId || link.toJunctionLinkId === currentId) {
        seen.add(link.id);
        queue.push(link.id);
      }
    }
  }

  return seen;
}

function collectJunctionChildLinkIds(refs, links) {
  const directLinkIds = new Set();
  for (const link of links) {
    const refKey = `${link.fromJunctionLinkId ?? ''}::${link.fromJunctionJointId ?? ''}`;
    if (refs.has(refKey)) {
      directLinkIds.add(link.id);
    }
  }
  return collectDescendantLinkIds(directLinkIds, links);
}

function snapshot(state) {
  return {
    nodes: state.nodes.map(n => ({
      ...n,
      anchors: [...(n.anchors ?? [])],
      textMorphs: normalizeTextMorphList(n.textMorphs ?? []),
      transformTarget: { ...(n.transformTarget ?? {}) },
      sourceNodeIds: [...(n.sourceNodeIds ?? [])],
      sourceLinkIds: [...(n.sourceLinkIds ?? [])],
      mirrorNodeOverrides: { ...(n.mirrorNodeOverrides ?? {}) },
      mirrorLinkOverrides: { ...(n.mirrorLinkOverrides ?? {}) },
    })),
    links: state.links.map(l => ({ ...l, joints: [...(l.joints ?? [])] })),
  };
}

const useStore = create((set, get) => ({
  nodes: [],
  links: [],
  nextLinkDefaults: { ...LINK_DEFAULTS },

  // Manual slide breaks (seconds) for presentation export and timeline markers.
  // Segments are [0 → first], [first → second], etc.; the last break is
  // the final export end, so no trailing slide is created after it.
  // Empty list → auto-determine segments from keyframes.
  slideBreaks: [],

  // Capture frame representing the render viewport in canvas coordinates
  // Defaults to Google Slides/PPT size (1920x1080) at origin; draggable overlay in canvas
  captureFrame: { x: 0, y: 0, width: PPTX_EXPORT_SIZE.width, height: PPTX_EXPORT_SIZE.height, visible: true },

  selectedId: null,
  selectedJointId: null,
  selectedIds: [],
  clipboard: null,
  // Ephemeral alignment "ghost": a non-document overlay of a copied selection. Never
  // saved or exported; lives only in the viewport. { nodes, links, offsetX, offsetY }.
  ghost: null,
  linkingFrom: null,
  contextMenu: null,
  pendingMorphEdit: null, // { nodeId, morphId } — consumed by DiagramCanvas to open inline editor
  setPendingMorphEdit: (nodeId, morphId) => set({ pendingMorphEdit: nodeId && morphId ? { nodeId, morphId } : null }),
  colorClipboard: null, // hex string — shared across all ColorInput instances
  setColorClipboard: (color) => set({ colorClipboard: color }),

  isExporting: false,
  exportProgress: 0,
  exportStatus: '',
  // Alignment & snapping preferences (see DEFAULT_ALIGNMENT_SETTINGS).
  alignment: loadAlignmentSettings(),
  // Ephemeral guide lines drawn while a drag is snapped.
  alignmentGuides: [],

  // Token appearance options (always-on; variables drive tokens automatically).
  simulateOptions: {
    tokenShape: 'circle', // circle | square | diamond
    tokenSize: 7,         // radius in px for circle; half-size for square/diamond
    tokenFill: '#ffffff',
    tokenStroke: pageColors.blueLink,
    tokenText: '',
    tokenTextColor: pageColors.blueLink,
    tokenTextSize: 10,
  },

  activeProject: null,
  expandedSubdiagramId: null,

  setActiveProject: (meta) => set({ activeProject: meta }),
  setExpandedSubdiagramId: (id) => set({ expandedSubdiagramId: id }),

  renameActiveProject: (name) =>
    set(s => s.activeProject ? { activeProject: { ...s.activeProject, name } } : {}),

  // Extended loader that accepts optional slideBreaks without breaking callers
  // Keep signature-compatible; allow passing { nodes, links, slideBreaks }.
  loadProjectData: ({ nodes, links, slideBreaks = [], captureFrame = null }) =>
    set({
      nodes: nodes.map(node => normalizeNode(node)),
      links: links.map(link => normalizeLink(link)),
      past: [],
      future: [],
      selectedId: null,
      selectedJointId: null,
      selectedIds: [],
      nextLinkDefaults: { ...LINK_DEFAULTS },
      slideBreaks: Array.isArray(slideBreaks)
        ? [...new Set(slideBreaks
            .map(v => (Number.isFinite(v) ? Math.max(0, Math.round(v * 100) / 100) : null))
            .filter(v => v != null)
          )].sort((a, b) => a - b)
        : [],
      captureFrame: captureFrame && Number.isFinite(captureFrame.width) && Number.isFinite(captureFrame.height)
        ? {
            x: Number(captureFrame.x) || 0,
            y: Number(captureFrame.y) || 0,
            width: Math.max(1, Number(captureFrame.width) || PPTX_EXPORT_SIZE.width),
            height: Math.max(1, Number(captureFrame.height) || PPTX_EXPORT_SIZE.height),
            visible: captureFrame.visible !== false,
          }
        : { x: 0, y: 0, width: PPTX_EXPORT_SIZE.width, height: PPTX_EXPORT_SIZE.height, visible: true },
    }),

  past: [],
  future: [],

  _pushHistory: () => {
    const state = get();
    const snap = snapshot(state);
    _lastHistoryPush = { key: '__manual__', at: Date.now() };
    set(s => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), snap],
      future: [],
    }));
  },

  // Push a history snapshot unless one with the same key (or an explicit push,
  // e.g. a panel that snapshots before a drag) landed within the coalesce
  // window. Repeated calls inside a burst keep extending the window, so a long
  // slider drag stays a single undo step.
  _pushHistoryCoalesced: (key) => {
    const now = Date.now();
    const { key: lastKey, at } = _lastHistoryPush;
    if (now - at < COALESCE_WINDOW_MS && (lastKey === key || lastKey === '__manual__')) {
      _lastHistoryPush = { key: lastKey, at: now };
      return;
    }
    get()._pushHistory();
    _lastHistoryPush = { key, at: now };
  },

  undo: () => {
    const { past, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    const curr = snapshot(get());
    set({
      past: past.slice(0, -1),
      future: [curr, ...future.slice(0, MAX_HISTORY - 1)],
      nodes: prev.nodes,
      links: prev.links,
      selectedId: null,
      selectedJointId: null,
      selectedIds: [],
    });
  },

  redo: () => {
    const { past, future } = get();
    if (!future.length) return;
    const next = future[0];
    const curr = snapshot(get());
    set({
      past: [...past.slice(-(MAX_HISTORY - 1)), curr],
      future: future.slice(1),
      nodes: next.nodes,
      links: next.links,
      selectedId: null,
      selectedJointId: null,
      selectedIds: [],
    });
  },

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  addToSelection: (id) => set(state => ({
    selectedIds: (() => {
      const base = new Set(state.selectedIds);
      if (state.selectedId) base.add(state.selectedId);
      base.add(id);
      return [...base];
    })(),
    selectedId: id,
    selectedJointId: null,
  })),

  selectAll: () => set(state => ({
    selectedIds: [...state.nodes.map(n => n.id), ...state.links.map(l => l.id)],
    selectedId: state.nodes[0]?.id ?? state.links[0]?.id ?? null,
    selectedJointId: null,
  })),

  copySelected: () => {
    const { nodes, links, selectedId, selectedIds } = get();
    const all = new Set([...selectedIds, selectedId].filter(Boolean));
    if (!all.size) return;
    const clipNodes = nodes.filter(n => all.has(n.id));
    const clipLinks = links.filter(l =>
      all.has(l.id) ||
      (all.has(l.fromId) && all.has(l.toId))
    );
    const payload = { nodes: clipNodes, links: clipLinks };
    set({ clipboard: payload });
    // Best effort: store cross-tab and system clipboard for pasting in another tab
    const cross = { type: 'ECHO-VIS-CLIP', version: 1, nodes: clipNodes, links: clipLinks, ts: Date.now() };
    try {
      localStorage.setItem(CROSS_TAB_CLIPBOARD_KEY, JSON.stringify(cross));
    } catch (e) {
      // Quota exceeded — rely on navigator.clipboard only
    }
    // Also persist in IndexedDB for large selections across tabs/windows
    try { idbWriteClipboard(JSON.stringify(cross)); } catch (_) {}
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(JSON.stringify(cross)).catch(() => {});
      }
    } catch (_) {}
  },

  // ── Ghost alignment overlay (Ctrl+B) ──────────────────────────────────────
  // Copy the current selection to a cross-tab clipboard (localStorage), so a ghost
  // of it can be pasted in this or any other open tab.
  copyGhostSelection: () => {
    const { nodes, links, selectedId, selectedIds } = get();
    const all = new Set([...selectedIds, selectedId].filter(Boolean));
    if (!all.size) return false;
    const ghostNodes = nodes.filter(n => all.has(n.id));
    const ghostLinks = links.filter(l =>
      all.has(l.id) || (all.has(l.fromId) && all.has(l.toId))
    );
    if (!ghostNodes.length && !ghostLinks.length) return false;
    try {
      localStorage.setItem(GHOST_CLIPBOARD_KEY, JSON.stringify({
        nodes: ghostNodes, links: ghostLinks, ts: Date.now(),
      }));
    } catch (e) { /* storage may be unavailable */ }
    return true;
  },

  // Paste a ghost (alignment reference) from the cross-tab clipboard, centred on the
  // given viewport point. The ghost is never added to nodes/links — it is overlay-only.
  pasteGhostFromClipboard: (targetPoint = null) => {
    let data = null;
    try {
      const raw = localStorage.getItem(GHOST_CLIPBOARD_KEY);
      data = raw ? JSON.parse(raw) : null;
    } catch (e) { data = null; }
    if (!data || (!data.nodes?.length && !data.links?.length)) return false;
    const gnodes = data.nodes ?? [];
    let offsetX = 0;
    let offsetY = 0;
    if (targetPoint && gnodes.length) {
      const minX = Math.min(...gnodes.map(n => n.x));
      const minY = Math.min(...gnodes.map(n => n.y));
      const maxX = Math.max(...gnodes.map(n => n.x + (n.width ?? 0)));
      const maxY = Math.max(...gnodes.map(n => n.y + (n.height ?? 0)));
      offsetX = targetPoint.x - (minX + maxX) / 2;
      offsetY = targetPoint.y - (minY + maxY) / 2;
    }
    set({ ghost: { nodes: gnodes, links: data.links ?? [], offsetX, offsetY } });
    return true;
  },

  moveGhost: (dx, dy) => set(state => (state.ghost
    ? { ghost: { ...state.ghost, offsetX: state.ghost.offsetX + dx, offsetY: state.ghost.offsetY + dy } }
    : {})),

  clearGhost: () => set(state => (state.ghost ? { ghost: null } : {})),

  pasteClipboard: async (targetPoint = null) => {
    let { clipboard } = get();
    // Fallback to cross-tab clipboard if local clipboard is empty
    if (!clipboard || (!clipboard.nodes?.length && !clipboard.links?.length)) {
      // Try IndexedDB (large payloads), then localStorage, then navigator.clipboard
      try {
        const dataStr = await idbReadClipboard();
        if (dataStr) {
          try {
            const data = JSON.parse(dataStr);
            if (data && data.type === 'ECHO-VIS-CLIP' && Array.isArray(data.nodes) && Array.isArray(data.links)) {
              clipboard = { nodes: data.nodes, links: data.links };
            }
          } catch (_) {}
        }
      } catch (_) {}
      try {
        if (!clipboard || (!clipboard.nodes?.length && !clipboard.links?.length)) {
          const raw = localStorage.getItem(CROSS_TAB_CLIPBOARD_KEY);
          if (raw) {
            const data = JSON.parse(raw);
            if (data && data.type === 'ECHO-VIS-CLIP' && Array.isArray(data.nodes) && Array.isArray(data.links)) {
              clipboard = { nodes: data.nodes, links: data.links };
            }
          }
        }
      } catch (_) {}
      if (!clipboard || (!clipboard.nodes?.length && !clipboard.links?.length)) {
        try {
          if (navigator?.clipboard?.readText) {
            // Note: async read — we can't await here inside a sync store action; schedule a follow-up
            const statePaste = get().pasteClipboard;
            navigator.clipboard.readText().then(text => {
              try {
                const data = JSON.parse(text);
                if (data && data.type === 'ECHO-VIS-CLIP' && Array.isArray(data.nodes) && Array.isArray(data.links)) {
                  set({ clipboard: { nodes: data.nodes, links: data.links } });
                  statePaste(targetPoint);
                }
              } catch (_) {}
            }).catch(() => {});
            return;
          }
        } catch (_) {}
      }
      if (!clipboard || (!clipboard.nodes?.length && !clipboard.links?.length)) return;
    }
    get()._pushHistory();
    const bounds = clipboard.nodes.length
      ? {
          minX: Math.min(...clipboard.nodes.map(n => n.x)),
          minY: Math.min(...clipboard.nodes.map(n => n.y)),
          maxX: Math.max(...clipboard.nodes.map(n => n.x + n.width)),
          maxY: Math.max(...clipboard.nodes.map(n => n.y + n.height)),
        }
      : null;
    const offset = targetPoint && bounds
      ? {
          x: targetPoint.x - (bounds.minX + bounds.maxX) / 2,
          y: targetPoint.y - (bounds.minY + bounds.maxY) / 2,
        }
      : { x: 40, y: 40 };
    // Assign every node's new id up front so cross-references between pasted
    // nodes (mirror sourceNodeIds/overrides) remap correctly regardless of the
    // order nodes appear in the clipboard.
    const idMap = {};
    for (const n of clipboard.nodes) idMap[n.id] = uuid();
    const jointIdMap = {};
    const newNodes = clipboard.nodes.map(n => {
      const id = idMap[n.id];
      return {
        ...n,
        id,
        x: n.x + offset.x,
        y: n.y + offset.y,
        anchors: (n.anchors ?? []).map(anchor => {
          const nextId = uuid();
          idMap[anchor.id] = nextId;
          return { ...anchor, id: nextId };
        }),
        textMorphs: normalizeTextMorphList(n.textMorphs ?? []).map(morph => ({
          ...morph,
          id: uuid(),
        })),
        failureKeyframes: normalizeNodeFailureKeyframes(n.failureKeyframes ?? []).map(keyframe => ({
          ...keyframe,
          id: uuid(),
        })),
        sourceNodeIds: (n.sourceNodeIds ?? []).map(sourceId => idMap[sourceId] ?? sourceId),
        sourceLinkIds: [...(n.sourceLinkIds ?? [])],
        mirrorNodeOverrides: Object.fromEntries(
          Object.entries(n.mirrorNodeOverrides ?? {}).map(([sourceId, value]) => [idMap[sourceId] ?? sourceId, { ...value }])
        ),
        mirrorLinkOverrides: { ...(n.mirrorLinkOverrides ?? {}) },
        animStartTime: null,
        animDuration: null,
      };
    });
    const linkIdMap = {};
    for (const link of clipboard.links) {
      linkIdMap[link.id] = uuid();
    }
    for (const link of clipboard.links) {
      for (const joint of link.joints ?? []) {
        jointIdMap[joint.id] = uuid();
      }
    }
    const newLinks = clipboard.links
      .filter(l => idMap[l.fromId] && idMap[l.toId])
      .map(l => ({
        ...l,
        id: linkIdMap[l.id],
        fromId: idMap[l.fromId],
        toId: idMap[l.toId],
        fromJunctionLinkId: l.fromJunctionLinkId ? linkIdMap[l.fromJunctionLinkId] ?? null : null,
        fromJunctionJointId: l.fromJunctionJointId ? jointIdMap[l.fromJunctionJointId] ?? null : null,
        toJunctionLinkId: l.toJunctionLinkId ? linkIdMap[l.toJunctionLinkId] ?? null : null,
        toJunctionJointId: l.toJunctionJointId ? jointIdMap[l.toJunctionJointId] ?? null : null,
        fromAnchorId: l.fromAnchorId ? idMap[l.fromAnchorId] ?? null : null,
        toAnchorId: l.toAnchorId ? idMap[l.toAnchorId] ?? null : null,
        animStartTime: null,
        animDuration: null,
        joints: (l.joints ?? []).map(j => ({
          ...j,
          id: jointIdMap[j.id],
          x: j.x + offset.x,
          y: j.y + offset.y,
        })),
      }));
    for (const node of newNodes) {
      if (!isMirrorNode(node)) continue;
      node.sourceLinkIds = (node.sourceLinkIds ?? []).map(sourceId => linkIdMap[sourceId] ?? sourceId);
      node.mirrorLinkOverrides = Object.fromEntries(
        Object.entries(node.mirrorLinkOverrides ?? {}).map(([sourceId, value]) => [linkIdMap[sourceId] ?? sourceId, { ...value }])
      );
    }
    const newIds = [...newNodes.map(n => n.id), ...newLinks.map(l => l.id)];
    set(state => ({
      nodes: [...state.nodes, ...newNodes],
      links: [...state.links, ...newLinks],
      selectedIds: newIds,
      selectedId: newNodes[0]?.id ?? newLinks[0]?.id ?? null,
      selectedJointId: null,
    }));
  },

  addNode: (canvasX, canvasY, overrides = {}) => {
    get()._pushHistory();
    const id = uuid();
    const shape = overrides.shape ?? 'rounded';
    const preset = NODE_SHAPE_PRESETS[shape] ?? NODE_SHAPE_PRESETS.rounded;
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const node = normalizeNode({
      id,
      ...NODE_DEFAULTS,
      ...preset,
      ...overrides,
      animStartTime: cursor,
      label: overrides.label ?? `Node ${get().nodes.filter(node => node.type !== 'text').length + 1}`,
    });
    set(state => ({
      nodes: [...state.nodes, {
        ...node,
        x: canvasX - node.width / 2,
        y: canvasY - node.height / 2,
      }],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addTextNode: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const textNode = {
      id,
      ...TEXT_NODE_DEFAULTS,
      label: `Text ${get().nodes.filter(node => node.type === 'text').length + 1}`,
      fontSize: 20,
      textColor: pageColors.white,
      textAnimMode: 'fade',
      anchors: [],
      animStartTime: cursor,
      animDuration: null,
      triggerAfterLinkId: null,
      triggerMode: 'overlap',
      triggerDelay: 0,
    };
    const sizedNode = normalizeNode(textNode);
    const node = {
      ...sizedNode,
      x: canvasX - sizedNode.width / 2,
      y: canvasY - sizedNode.height / 2,
    };
    set(state => ({
      nodes: [...state.nodes, node],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addVariableNode: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const node = normalizeNode({ id, ...VARIABLE_NODE_DEFAULTS, animStartTime: cursor });
    set(state => ({
      nodes: [...state.nodes, { ...node, x: canvasX - node.width / 2, y: canvasY - node.height / 2 }],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addMonitorNode: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const node = {
      id,
      ...MONITOR_NODE_DEFAULTS,
      animStartTime: cursor,
      monitorWatches: [],
    };
    set(state => ({
      nodes: [...state.nodes, { ...node, x: canvasX - node.width / 2, y: canvasY - node.height / 2 }],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addGraphNode: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const node = normalizeNode({ id, ...GRAPH_NODE_DEFAULTS, animStartTime: cursor });
    set(state => ({
      nodes: [...state.nodes, { ...node, x: canvasX - node.width / 2, y: canvasY - node.height / 2 }],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  setMonitorVariable: (monitorId, variableNodeId) => {
    if (!monitorId) return;
    get()._pushHistory();
    set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== monitorId) return node;
        const manualLinkId = getManualTokenLinkId(variableNodeId);
        const manualLink = manualLinkId
          ? state.links.find(link => link.id === manualLinkId && link.manualTokenEnabled)
          : null;
        const destinationNodeId = manualLink
          ? (manualLink.manualTokenInvert ? manualLink.fromId : manualLink.toId)
          : null;
        // Manual tokens work immediately: selecting one watches the node where
        // the token finishes. Users can still replace or add watches afterward.
        const monitorWatches = destinationNodeId
          ? [{ id: uuid(), nodeId: destinationNodeId, template: '{value}' }]
          : [];
        return { ...node, variableNodeId: variableNodeId || null, monitorWatches };
      }),
    }));
  },

  addMonitorWatch: (monitorId, watchedNodeId) => {
    if (!monitorId || !watchedNodeId) return;
    get()._pushHistory();
    set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== monitorId) return node;
        const watches = [...(node.monitorWatches ?? [])];
        if (watches.some(w => w.nodeId === watchedNodeId)) return node;
        watches.push({ id: uuid(), nodeId: watchedNodeId, template: '{value}' });
        return { ...node, monitorWatches: watches };
      }),
    }));
  },

  updateMonitorWatch: (monitorId, watchId, updates) => {
    get()._pushHistoryCoalesced('updateMonitorWatch');
    set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== monitorId) return node;
        return {
          ...node,
          monitorWatches: (node.monitorWatches ?? []).map(w =>
            w.id === watchId ? { ...w, ...updates } : w
          ),
        };
      }),
    }));
  },

  removeMonitorWatch: (monitorId, watchId) => {
    get()._pushHistory();
    set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== monitorId) return node;
        return {
          ...node,
          monitorWatches: (node.monitorWatches ?? []).filter(w => w.id !== watchId),
        };
      }),
    }));
  },

  addMirrorNode: (canvasX, canvasY, sourceSelectionIds = []) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const mirrorNode = normalizeNode({
      id,
      ...MIRROR_NODE_DEFAULTS,
      animStartTime: cursor,
      ...getMirrorSelectionPayload(sourceSelectionIds, get().nodes, get().links, id),
    });
    const sourceNodes = get().nodes.filter(node => mirrorNode.sourceNodeIds.includes(node.id) && !isMirrorNode(node));
    const sourceLinks = get().links.filter(link => mirrorNode.sourceLinkIds.includes(link.id));
    const { mirrorNodeOverrides, mirrorLinkOverrides } = snapshotMirrorOverrides(sourceNodes, sourceLinks);
    mirrorNode.mirrorNodeOverrides = mirrorNodeOverrides;
    mirrorNode.mirrorLinkOverrides = mirrorLinkOverrides;
    const sourceWidth = sourceNodes.length
      ? Math.max(...sourceNodes.map(node => node.x + node.width)) - Math.min(...sourceNodes.map(node => node.x))
      : MIRROR_NODE_DEFAULTS.width - 36;
    const sourceHeight = sourceNodes.length
      ? Math.max(...sourceNodes.map(node => node.y + node.height)) - Math.min(...sourceNodes.map(node => node.y))
      : MIRROR_NODE_DEFAULTS.height - 36;
    mirrorNode.width = Math.max(180, sourceWidth + 36);
    mirrorNode.height = Math.max(120, sourceHeight + 36);
    mirrorNode.x = canvasX - mirrorNode.width / 2;
    mirrorNode.y = canvasY - mirrorNode.height / 2;
    set(state => ({
      nodes: [...state.nodes, mirrorNode],
      contextMenu: null,
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  updateNode: (id, updates) => {
    get()._pushHistoryCoalesced('updateNode');
    set(state => ({
      nodes: state.nodes.map(node => (node.id === id ? normalizeNode(node, updates) : node)),
    }));
  },

  // Bake the selected nodes (and any link fully inside the selection) into their
  // end-of-animation state and remove all animation keyframes, so the diagram's
  // last frame becomes its first frame — a static base to build a new diagram on.
  stripAnimation: (ids = []) => {
    const state = get();
    const idSet = new Set((ids ?? []).filter(Boolean));
    if (!idSet.size) return;
    get()._pushHistory();
    const nodeMap = Object.fromEntries(state.nodes.map(node => [node.id, node]));
    const nextNodes = state.nodes.map(node => (
      idSet.has(node.id) && node.type !== 'mirror'
        ? normalizeNode(node, resolveStrippedNodeUpdates(node, nodeMap))
        : node
    ));
    const nextLinks = state.links.map(link => (
      (idSet.has(link.id) || (idSet.has(link.fromId) && idSet.has(link.toId)))
        ? { ...link, ...resolveStrippedLinkUpdates() }
        : link
    ));
    set({ nodes: nextNodes, links: nextLinks, contextMenu: null });
  },

  captureMirrorSelection: (mirrorId, selectionIds = []) => {
    const state = get();
    const payload = getMirrorSelectionPayload(selectionIds, state.nodes, state.links, mirrorId);
    const currentMirror = state.nodes.find(n => n.id === mirrorId);
    const existingNodeOverrides = currentMirror?.mirrorNodeOverrides ?? {};
    const existingLinkOverrides = currentMirror?.mirrorLinkOverrides ?? {};
    const newSourceNodes = state.nodes.filter(n => payload.sourceNodeIds.includes(n.id) && !isMirrorNode(n));
    const newSourceLinks = state.links.filter(l => payload.sourceLinkIds.includes(l.id));
    const { mirrorNodeOverrides, mirrorLinkOverrides } = snapshotMirrorOverrides(
      newSourceNodes, newSourceLinks, existingNodeOverrides, existingLinkOverrides
    );
    set({
      nodes: state.nodes.map(node => (node.id === mirrorId
        ? normalizeNode(node, { ...payload, mirrorNodeOverrides, mirrorLinkOverrides })
        : node)),
    });
  },

  updateMirrorNodeOverride: (mirrorId, sourceNodeId, updates) => {
    get()._pushHistoryCoalesced('updateMirrorOverride');
    return set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== mirrorId) return node;
        const current = node.mirrorNodeOverrides?.[sourceNodeId] ?? {};
        const next = { ...current, ...updates };
        return normalizeNode(node, {
          mirrorNodeOverrides: {
            ...(node.mirrorNodeOverrides ?? {}),
            [sourceNodeId]: next,
          },
        });
      }),
    }));
  },

  updateMirrorLinkOverride: (mirrorId, sourceLinkId, updates) => {
    get()._pushHistoryCoalesced('updateMirrorOverride');
    return set(state => ({
      nodes: state.nodes.map(node => {
        if (node.id !== mirrorId) return node;
        const current = node.mirrorLinkOverrides?.[sourceLinkId] ?? {};
        const next = { ...current, ...updates };
        return normalizeNode(node, {
          mirrorLinkOverrides: {
            ...(node.mirrorLinkOverrides ?? {}),
            [sourceLinkId]: next,
          },
        });
      }),
    }));
  },

  addSubdiagramNode: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const node = {
      id,
      ...SUBDIAGRAM_DEFAULTS,
      animStartTime: cursor,
      x: canvasX - SUBDIAGRAM_DEFAULTS.width / 2,
      y: canvasY - SUBDIAGRAM_DEFAULTS.height / 2,
    };
    set(state => ({
      nodes: [...state.nodes, node],
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addArea: (canvasX, canvasY) => {
    get()._pushHistory();
    const id = uuid();
    const cursor = Math.max(0, Math.round((getTimelineCursor() || 0) * 100) / 100);
    const area = {
      id,
      ...AREA_DEFAULTS,
      animStartTime: cursor,
      x: canvasX - AREA_DEFAULTS.width / 2,
      y: canvasY - AREA_DEFAULTS.height / 2,
    };
    set(state => ({
      nodes: [...state.nodes, area],
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  addNodeAnchor: (nodeId, anchor) => {
    get()._pushHistory();
    set(state => ({
      nodes: state.nodes.map(node => (
        node.id !== nodeId
          ? node
          : { ...node, anchors: [...(node.anchors ?? []), anchor] }
      )),
      selectedId: nodeId,
      selectedJointId: null,
    }));
  },

  updateNodeAnchor: (nodeId, anchorId, updates) => {
    get()._pushHistoryCoalesced('updateNodeAnchor');
    return set(state => ({
      nodes: state.nodes.map(node => (
        node.id !== nodeId
          ? node
          : {
              ...node,
              anchors: (node.anchors ?? []).map(anchor => (
                anchor.id === anchorId ? { ...anchor, ...updates } : anchor
              )),
            }
      )),
    }));
  },

  removeNode: (id) => {
    get()._pushHistory();
    const descendantLinkIds = collectDescendantLinkIds(
      new Set(get().links
        .filter(link => link.fromId === id || link.toId === id)
        .map(link => link.id)),
      get().links
    );
    set(state => {
      const removedNodeIds = new Set([id]);
      const keptLinks = [];
      const removedLinkIds = new Set();
      for (const link of state.links) {
        if (link.fromId === id || link.toId === id || descendantLinkIds.has(link.id)) {
          removedLinkIds.add(link.id);
        } else {
          keptLinks.push(link);
        }
      }
      return {
        nodes: cleanDanglingRefs(
          state.nodes.filter(node => node.id !== id),
          removedNodeIds,
          removedLinkIds
        ),
        links: keptLinks,
        selectedId: state.selectedId === id ? null : state.selectedId,
        selectedJointId: state.selectedId === id ? null : state.selectedJointId,
        selectedIds: state.selectedIds.filter(sid => sid !== id),
      };
    });
  },

  addLink: (fromId, toId, overrides = {}) => {
    if (fromId === toId && !overrides.toJunctionLinkId) return null;
    get()._pushHistory();
    const id = uuid();
    set(state => ({
      links: [...state.links, {
        id,
        fromId,
        toId,
        ...LINK_DEFAULTS,
        ...state.nextLinkDefaults,
        ...overrides,
        joints: [...(state.nextLinkDefaults.joints ?? [])],
      }],
      selectedId: id,
      selectedJointId: null,
      selectedIds: [],
    }));
    return id;
  },

  updateLink: (id, updates) => {
    get()._pushHistoryCoalesced('updateLink');
    set(state => ({
      links: state.links.map(link => (link.id === id ? { ...link, ...updates } : link)),
    }));
  },

  reverseLink: (id) => {
    get()._pushHistory();
    set(state => ({
      links: state.links.map(link => link.id !== id ? link : {
        ...link,
        fromId: link.toId,
        toId: link.fromId,
        fromAnchorSide: link.toAnchorSide,
        toAnchorSide: link.fromAnchorSide,
        fromAnchorLockedCenter: link.toAnchorLockedCenter,
        toAnchorLockedCenter: link.fromAnchorLockedCenter,
        fromAlongPos: link.toAlongPos,
        toAlongPos: link.fromAlongPos,
        fromAnchorId: link.toAnchorId,
        toAnchorId: link.fromAnchorId,
        fromJunctionLinkId: link.toJunctionLinkId,
        fromJunctionJointId: link.toJunctionJointId,
        toJunctionLinkId: link.fromJunctionLinkId,
        toJunctionJointId: link.fromJunctionJointId,
      }),
    }));
  },

  removeLink: (id) => {
    get()._pushHistory();
    const descendantLinkIds = collectDescendantLinkIds(new Set([id]), get().links);
    set(state => ({
      nodes: cleanDanglingRefs(state.nodes, new Set(), descendantLinkIds),
      links: state.links.filter(link => !descendantLinkIds.has(link.id)),
      selectedId: descendantLinkIds.has(state.selectedId) ? null : state.selectedId,
      selectedJointId: descendantLinkIds.has(state.selectedId) ? null : state.selectedJointId,
      selectedIds: state.selectedIds.filter(sid => !descendantLinkIds.has(sid)),
    }));
  },

  addLinkJoint: (linkId, joint, insertIndex, options = {}) => {
    get()._pushHistory();
    set(state => ({
      links: state.links.map(link => {
        if (link.id !== linkId) return link;
        const joints = [...(link.joints ?? [])];
        joints.splice(insertIndex, 0, joint);
        return { ...link, joints };
      }),
      selectedId: linkId,
      selectedJointId: options.selectJoint === false ? state.selectedJointId : joint.id,
      contextMenu: null,
    }));
  },

  updateLinkJoint: (linkId, jointId, updates) => {
    get()._pushHistoryCoalesced('updateLinkJoint');
    return set(state => ({
      links: state.links.map(link => (
        link.id !== linkId
          ? link
          : {
              ...link,
              joints: (link.joints ?? []).map(joint => (
                joint.id === jointId ? { ...joint, ...updates } : joint
              )),
            }
      )),
    }));
  },

  // Square up a single joint to a right angle with its neighbouring route
  // points (the "Make 90°" action). Operates in render space, then stores the
  // result back without the link's parallel lane offset.
  orthogonalizeJoint: (linkId, jointId) => {
    const state = get();
    const link = state.links.find(item => item.id === linkId);
    if (!link) return;
    const fromNode = state.nodes.find(node => node.id === link.fromId);
    const toNode = state.nodes.find(node => node.id === link.toId);
    if (!fromNode || !toNode) return;

    const render = buildLinkRenderData(link, fromNode, toNode, state.links, state.nodes);
    const route = [
      render.startPoint,
      ...render.jointRenderPoints.map(point => ({ x: point.x, y: point.y, id: point.id })),
      render.endPoint,
    ];
    const idx = route.findIndex(point => point.id === jointId);
    if (idx <= 0 || idx >= route.length - 1) return;

    const offset = getLinkParallelOffset(link, fromNode, toNode, state.links);
    const snapped = orthogonalizeJointPoint(route[idx], [route[idx - 1], route[idx + 1]]);
    get().updateLinkJoint(linkId, jointId, {
      x: snapped.x - offset.x,
      y: snapped.y - offset.y,
    });
  },

  // Align the given nodes along an edge or center. mode ∈
  // left|hcenter|right|top|vcenter|bottom.
  alignNodes: (ids, mode) => {
    const idSet = new Set((ids ?? []).filter(Boolean));
    if (idSet.size < 2) return;
    get()._pushHistory();
    set(state => {
      const targets = state.nodes.filter(node => idSet.has(node.id));
      if (targets.length < 2) return {};
      const lefts = targets.map(n => n.x);
      const rights = targets.map(n => n.x + n.width);
      const tops = targets.map(n => n.y);
      const bottoms = targets.map(n => n.y + n.height);
      const minLeft = Math.min(...lefts);
      const maxRight = Math.max(...rights);
      const minTop = Math.min(...tops);
      const maxBottom = Math.max(...bottoms);
      const centerX = (minLeft + maxRight) / 2;
      const centerY = (minTop + maxBottom) / 2;

      const place = (node) => {
        switch (mode) {
          case 'left': return { x: minLeft };
          case 'right': return { x: maxRight - node.width };
          case 'hcenter': return { x: centerX - node.width / 2 };
          case 'top': return { y: minTop };
          case 'bottom': return { y: maxBottom - node.height };
          case 'vcenter': return { y: centerY - node.height / 2 };
          default: return {};
        }
      };

      return {
        nodes: state.nodes.map(node => (
          idSet.has(node.id) ? { ...node, ...place(node) } : node
        )),
      };
    });
  },

  // Evenly distribute the given nodes so the gaps between them are equal.
  // axis ∈ horizontal|vertical.
  distributeNodes: (ids, axis) => {
    const idSet = new Set((ids ?? []).filter(Boolean));
    if (idSet.size < 3) return;
    get()._pushHistory();
    set(state => {
      const targets = state.nodes.filter(node => idSet.has(node.id));
      if (targets.length < 3) return {};
      const sizeKey = axis === 'vertical' ? 'height' : 'width';
      const posKey = axis === 'vertical' ? 'y' : 'x';
      const sorted = [...targets].sort((a, b) => a[posKey] - b[posKey]);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = (last[posKey] + last[sizeKey]) - first[posKey];
      const totalSize = sorted.reduce((sum, node) => sum + node[sizeKey], 0);
      const gap = (span - totalSize) / (sorted.length - 1);

      const positions = {};
      let cursor = first[posKey];
      for (const node of sorted) {
        positions[node.id] = cursor;
        cursor += node[sizeKey] + gap;
      }

      return {
        nodes: state.nodes.map(node => (
          positions[node.id] != null ? { ...node, [posKey]: positions[node.id] } : node
        )),
      };
    });
  },

  removeLinkJoint: (linkId, jointId) => {
    get()._pushHistory();
    const childLinkIds = collectJunctionChildLinkIds(new Set([`${linkId}::${jointId}`]), get().links);
    set(state => ({
      links: state.links.map(link => (
        link.id !== linkId
          ? link
          : {
              ...link,
              joints: (link.joints ?? []).filter(joint => joint.id !== jointId),
            }
      )).filter(link => !childLinkIds.has(link.id)),
      selectedJointId: state.selectedJointId === jointId ? null : state.selectedJointId,
    }));
  },

  setSelection: (id, ids = []) => set({
    selectedId: id,
    selectedJointId: null,
    selectedIds: ids,
  }),
  setSelected: (id) => set({ selectedId: id, selectedJointId: null, selectedIds: [] }),
  setSelectedJoint: (jointId) => set({ selectedJointId: jointId }),

  setLinkingFrom: (nodeId) => set({ linkingFrom: nodeId }),
  setContextMenu: (menu) => set({ contextMenu: menu }),

  setAlignment: (updates) => set(state => {
    const alignment = { ...state.alignment, ...(updates ?? {}) };
    try { localStorage.setItem(ALIGNMENT_SETTINGS_KEY, JSON.stringify(alignment)); } catch { /* quota/SSR */ }
    return { alignment };
  }),
  setAlignmentGuides: (guides) => set({ alignmentGuides: guides }),

  // Move the current selection by (dx, dy) — arrow-key nudging. Joints of
  // links whose ends are both selected (or that are selected themselves)
  // travel with the nodes, mirroring group-drag behaviour.
  nudgeSelected: (dx, dy) => {
    const state = get();
    const ids = new Set([...(state.selectedIds ?? []), state.selectedId].filter(Boolean));
    if (!ids.size) return false;
    const nodeIds = new Set(state.nodes.filter(n => ids.has(n.id)).map(n => n.id));
    if (!nodeIds.size) return false;
    const now = Date.now();
    if (now - lastNudgeAt > 900) get()._pushHistory();
    lastNudgeAt = now;
    set(s => ({
      nodes: s.nodes.map(n => (nodeIds.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
      links: s.links.map(link => {
        const moveJoints = ids.has(link.id) || (nodeIds.has(link.fromId) && nodeIds.has(link.toId));
        if (!moveJoints || !(link.joints?.length)) return link;
        return { ...link, joints: link.joints.map(j => ({ ...j, x: j.x + dx, y: j.y + dy })) };
      }),
    }));
    return true;
  },
  setSimulateOptions: (updates) => set(state => ({ simulateOptions: { ...state.simulateOptions, ...(updates ?? {}) } })),
  updateNextLinkDefaults: (updates) =>
    set(state => ({
      nextLinkDefaults: { ...state.nextLinkDefaults, ...updates },
    })),

  setExporting: (value) => set({ isExporting: value }),
  setExportProgress: (value) => set({ exportProgress: value }),
  setExportStatus: (value) => set({ exportStatus: value }),

  // Slide break editing
  setSlideBreaks: (times = []) => set({
    slideBreaks: Array.isArray(times)
      ? [...new Set(times
          .map(v => (Number.isFinite(v) ? Math.max(0, Math.round(v * 100) / 100) : null))
          .filter(v => v != null)
        )].sort((a, b) => a - b)
      : [],
  }),
  addSlideBreakAt: (t) => set(state => {
    const sec = Number.isFinite(t) ? Math.max(0, Math.round(t * 100) / 100) : null;
    if (sec == null) return {};
    const next = new Set(state.slideBreaks ?? []);
    next.add(sec);
    return { slideBreaks: [...next].sort((a, b) => a - b) };
  }),
  removeSlideBreakAtTime: (t, epsilon = 0.05) => set(state => {
    if (!Array.isArray(state.slideBreaks) || !state.slideBreaks.length) return {};
    const target = Number(t);
    const filtered = state.slideBreaks.filter(v => Math.abs(v - target) > epsilon);
    if (filtered.length === state.slideBreaks.length) return {};
    return { slideBreaks: filtered };
  }),
  moveSlideBreak: (fromTime, toTime, epsilon = 0.05) => set(state => {
    if (!Array.isArray(state.slideBreaks) || !state.slideBreaks.length) return {};
    const from = Number(fromTime);
    const to = Number(toTime);
    if (!Number.isFinite(to) || to < 0) return {};
    const rounded = Math.max(0, Math.round(to * 100) / 100);
    const without = state.slideBreaks.filter(v => Math.abs(v - from) > epsilon);
    const next = new Set(without);
    next.add(rounded);
    return { slideBreaks: [...next].sort((a, b) => a - b) };
  }),
  clearSlideBreaks: () => set({ slideBreaks: [] }),

  // Capture frame actions
  setCaptureFrame: (updates) => set(state => ({
    captureFrame: {
      ...state.captureFrame,
      ...(updates || {}),
      width: Math.max(1, Number((updates || {}).width ?? state.captureFrame.width)),
      height: Math.max(1, Number((updates || {}).height ?? state.captureFrame.height)),
    },
  })),
  setCaptureFrameVisible: (visible) => set(state => ({ captureFrame: { ...state.captureFrame, visible: !!visible } })),

  deleteSelected: () => {
    const { selectedId, selectedJointId, selectedIds, nodes, links } = get();

    if (selectedId && !selectedIds.length && selectedJointId) {
      const lnk = links.find(l => l.id === selectedId);
      if (lnk) { get().removeLinkJoint(lnk.id, selectedJointId); return; }
    }

    const toDelete = new Set([...selectedIds, selectedId].filter(Boolean));
    if (!toDelete.size) return;

    const directLinkIds = new Set(links
      .filter(link =>
        toDelete.has(link.id) ||
        toDelete.has(link.fromId) ||
        toDelete.has(link.toId)
      )
      .map(link => link.id));
    const descendantLinkIds = collectDescendantLinkIds(directLinkIds, links);

    get()._pushHistory();
    set(state => {
      const keptLinks = [];
      const removedLinkIds = new Set();
      for (const l of state.links) {
        if (toDelete.has(l.id) || toDelete.has(l.fromId) || toDelete.has(l.toId) || descendantLinkIds.has(l.id)) {
          removedLinkIds.add(l.id);
        } else {
          keptLinks.push(l);
        }
      }
      const removedNodeIds = new Set(state.nodes.filter(n => toDelete.has(n.id)).map(n => n.id));
      return {
        nodes: cleanDanglingRefs(
          state.nodes.filter(n => !toDelete.has(n.id)),
          removedNodeIds,
          removedLinkIds
        ),
        links: keptLinks,
        selectedId: null,
        selectedJointId: null,
        selectedIds: [],
      };
    });
  },
}));

  export default useStore;
