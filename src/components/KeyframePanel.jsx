import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toColorInputValue } from '../colorValue';
import { v4 as uuid } from 'uuid';
import { pageColors, withAlpha } from '../colorThemes';
import useStore from '../store/useStore';
import { AnimationEngine, isBlueprintItem } from '../animation/AnimationEngine';
import { buildLinkRenderData, getLinkJointProgress } from '../links/linkGeometry';
import { isMirrorNode } from '../mirror/mirrorData';
import { getNextTextMorphStart, getNodeTextMorphs, getTextMorphById, normalizeTextMorphList } from '../text/textMorphs';
import { computeVariableWebs } from '../variables/flow';
import { setTimelineCursor } from '../timelineCursor';
import TriggerMenu from './TriggerMenu';
import {
  computeManualTokenTimingByLinkId,
  getManualTokenTextAtTime,
  isOwnTokenEvent,
  normalizeManualTokenTextKeyframes,
} from '../animation/manualTokenTiming';
import { normalizeNodeFailureKeyframes } from '../animation/nodeFailureTiming';
import { DEFAULT_SCROLL_STEP_DURATION, normalizeScrollSteps } from '../animation/scrollStepTiming';

const LEFT_W     = 240;
const BASE_ROW_H = 36;
const BASE_SEC_H = 22;
const MIN_ROW_H  = 16;
const MAX_ROW_H  = 72;
// Row heights follow the vertical zoom (Ctrl + wheel). Like PX_PER_SEC, the panel sets
// these on every render and the helpers in this module read them at use time.
let ROW_H        = BASE_ROW_H;
let SEC_H        = BASE_SEC_H;
// Inset of a block inside its row (6px at the default height).
let BLOCK_PAD    = 6;
function setRowScale(rowH) {
  ROW_H = rowH;
  SEC_H = Math.max(10, Math.round(BASE_SEC_H * rowH / BASE_ROW_H));
  BLOCK_PAD = Math.max(1, Math.round(6 * rowH / BASE_ROW_H));
}
const RULER_H    = 26;
const PANEL_MIN_H = 210;
// Keep in sync with the .tl-panel height transition in index.css.
const PANEL_COLLAPSE_MS = 180;
const PANEL_DEFAULT_H = 320;
const BASE_PX_PER_SEC = 90;
const MIN_PX_PER_SEC  = 12;
const MAX_PX_PER_SEC  = 900;
// Current horizontal scale (pixels per second). It's the timeline zoom level: the panel
// sets it on every render, and every helper in this module reads it at use time.
let PX_PER_SEC = BASE_PX_PER_SEC;
// Wheel scrolling feels sluggish at the browser's default step, so speed it up.
const WHEEL_SCROLL_SPEED = 1.3;
// How strongly Alt/Ctrl + wheel zooms (per pixel of wheel delta).
const WHEEL_ZOOM_RATE = 0.0014;
const MIN_DUR    = 0.1;
const HANDLE_W   = 9;

const NODE_HUE      = { solid: pageColors.purpleAccent, bright: pageColors.purpleAccent };
const LINK_HUE      = { solid: pageColors.blueMain, bright: pageColors.blueLink };
const MORPH_HUE     = { solid: pageColors.white, bright: pageColors.white };
const TRANSFORM_HUE = { solid: pageColors.warningBright, bright: pageColors.warningBright };
const TOKEN_HUE     = { solid: pageColors.tokenMain, bright: pageColors.tokenBright };
const FAILURE_HUE   = { solid: pageColors.dangerMain, bright: pageColors.dangerBright };
const SCROLL_HUE    = { solid: pageColors.purpleAccent, bright: pageColors.purpleAccent };

const r2    = v => Math.round(v * 100) / 100;
const trunc = (s, n = 13) => (s ?? '?').length > n ? (s ?? '?').slice(0, n - 1) + '…' : (s ?? '?');

function inverseEaseOut(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - clamped, 1 / 3);
}

function fmtTime(s) {
  const m   = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${sec}` : `${sec}s`;
}

function linkLabel(link, nodes) {
  const from = nodes.find(n => n.id === link.fromId);
  const to   = nodes.find(n => n.id === link.toId);
  return `${trunc(from?.label, 22)} → ${trunc(to?.label, 22)}`;
}

function computeAutoTimes(nodes, links) {
  if (!nodes.length && !links.length) return { nodes: {}, links: {} };
  const tl = new AnimationEngine(nodes, links).getTimeline();
  const result = { nodes: {}, links: {} };
  for (const ev of tl) {
    result[ev.type + 's'][ev.id] = {
      start: ev.start,
      duration: ev.duration,
      displayDuration: ev.displayDuration ?? ev.duration,
      popupStart: ev.popupStart ?? null,
      popupEnd: ev.popupEnd ?? null,
      transformStart: ev.transformStart ?? null,
      transformEnd: ev.transformEnd ?? null,
    };
  }
  return result;
}

// Items started by a trigger (an event or, for nodes, a link) get their start from the
// engine; any animStartTime they carry is ignored by playback, so it must not be shown.
function isTriggeredItem(item, kind) {
  return !!item?.triggerEventId || (kind === 'node' && !!item?.triggerAfterLinkId);
}

// Where an item really starts: the engine's time for triggered items, otherwise its
// own start time (falling back to the auto sequence).
function getItemStart(item, kind, pool) {
  if (isTriggeredItem(item, kind)) return pool[item.id]?.start ?? item?.animStartTime ?? 0;
  return item?.animStartTime ?? pool[item?.id]?.start ?? 0;
}

function getSyncedJunctionKey(link, linkMap) {
  if (link?.syncGroupKey) return link.syncGroupKey;
  if (!link?.fromJunctionLinkId || !link?.fromJunctionJointId) return null;
  const parentLink = linkMap[link.fromJunctionLinkId];
  const joint = parentLink?.joints?.find(item => item.id === link.fromJunctionJointId);
  return joint?.syncBranches ? `${link.fromJunctionLinkId}::${link.fromJunctionJointId}` : null;
}

function Ruler({ total, endTime, isCustomEnd, slideBreaks = [], onRemoveBreak, onMoveBreak, onMoveEnd, onResetEnd }) {
  const rulerRef = useRef(null);
  const ticks = [];
  const step = total > 15 ? 2 : total > 8 ? 1 : 0.5;
  for (let t = 0; t <= total + 0.01; t = r2(t + step)) {
    const major = Number.isInteger(t) || step >= 1;
    ticks.push(
      <div key={t} style={{ position: 'absolute', left: t * PX_PER_SEC - 1, top: 0, pointerEvents: 'none' }}>
        {major && (
          <span style={{ color: pageColors.rulerText, fontSize: 10, position: 'absolute', top: 4, left: 3, whiteSpace: 'nowrap' }}>
            {t % 1 === 0 ? `${t}s` : `${t.toFixed(1)}`}
          </span>
        )}
        <div style={{ position: 'absolute', bottom: 0, width: 1, height: major ? 8 : 4, background: major ? pageColors.rulerMajorTick : pageColors.rulerMinorTick }} />
      </div>
    );
  }
  // End marker — playback always runs up to here. Drag it to set a custom end.
  const endPx = endTime * PX_PER_SEC;
  const startEndDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    const rect = rulerRef.current?.getBoundingClientRect();
    const baseLeft = rect ? rect.left : 0;
    const onMove = (me) => {
      const scrollHost = rulerRef.current?.parentElement?.parentElement;
      const scrollLeft = scrollHost && typeof scrollHost.scrollLeft === 'number' ? scrollHost.scrollLeft : 0;
      const t = (me.clientX - baseLeft + scrollLeft) / PX_PER_SEC;
      onMoveEnd?.(Math.max(MIN_DUR, r2(t)));
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const startDrag = (initialTime, e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    let currentFrom = initialTime;
    const rect = rulerRef.current?.getBoundingClientRect();
    const baseLeft = rect ? rect.left : 0;
    const onMove = (me) => {
      const scrollHost = rulerRef.current?.parentElement?.parentElement;
      const scrollLeft = scrollHost && typeof scrollHost.scrollLeft === 'number' ? scrollHost.scrollLeft : 0;
      const relX = Math.max(0, me.clientX - baseLeft + scrollLeft);
      const t = Math.max(0, relX / PX_PER_SEC);
      if (onMoveBreak) {
        const target = r2(t);
        if (Math.abs(target - currentFrom) >= 0.001) {
          onMoveBreak(currentFrom, target);
          currentFrom = target;
        }
      }
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div ref={rulerRef} style={{ height: RULER_H, background: 'var(--panel-bg)', borderBottom: '1px solid var(--border-strong)', position: 'relative', flexShrink: 0 }}>
      {ticks}
      {/* Manual slide break markers */}
      {slideBreaks.map((t, i) => {
        const x = t * PX_PER_SEC;
        return (
          <div
            key={`sb-${i}-${t}`}
            style={{ position: 'absolute', left: x - 1, top: 0, bottom: 0, width: 2, background: withAlpha(pageColors.purpleAccent, 0.9), cursor: 'ew-resize' }}
            onMouseDown={(e) => startDrag(t, e)}
          >
            <div
              title={`Slide break @ ${t.toFixed(2)}s (right-click to remove)`}
              onContextMenu={e => { e.preventDefault(); onRemoveBreak?.(t); }}
              style={{
                position: 'absolute', top: 2, left: -6,
                background: pageColors.purpleAccent,
                color: pageColors.white,
                fontSize: 9,
                padding: '0px 4px',
                borderRadius: 3,
                cursor: 'ew-resize',
                userSelect: 'none',
                boxShadow: `0 0 6px ${withAlpha(pageColors.purpleAccent, 0.55)}`,
              }}
              onMouseDown={(e) => startDrag(t, e)}
            >
              S{i + 1}
            </div>
          </div>
        );
      })}
      <div
        onMouseDown={startEndDrag}
        onDoubleClick={e => { e.stopPropagation(); onResetEnd?.(); }}
        title={`End @ ${endTime.toFixed(2)}s — drag to move${isCustomEnd ? ', double-click to reset to auto' : ''}`}
        style={{
          position: 'absolute', left: endPx - 4, top: 0, bottom: 0, width: 9,
          cursor: 'ew-resize', zIndex: 2,
        }}
      >
        <div style={{
          position: 'absolute', left: 4, top: 0, bottom: 0, width: 1,
          background: withAlpha(pageColors.purpleAccent, isCustomEnd ? 0.9 : 0.5),
        }} />
        <span style={{
          position: 'absolute', left: 6, top: 3,
          fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
          padding: '1px 4px', borderRadius: 3,
          color: isCustomEnd ? pageColors.white : withAlpha(pageColors.purpleAccent, 0.8),
          background: isCustomEnd ? pageColors.purpleAccent : withAlpha(pageColors.purpleAccent, 0.12),
          whiteSpace: 'nowrap', userSelect: 'none',
        }}>
          END
        </span>
      </div>
    </div>
  );
}

function SectionRow({ label, color }) {
  return (
    <div style={{
      height: SEC_H, display: 'flex', alignItems: 'center',
      padding: '0 10px', flexShrink: 0,
      background: 'var(--panel-bg)',
      borderBottom: `1px solid ${withAlpha(color, 0.13)}`,
    }}>
      <div style={{ width: 3, height: 10, borderRadius: 2, background: color, marginRight: 7, flexShrink: 0 }} />
      <span style={{ color, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
        {label}
      </span>
    </div>
  );
}

function KeyframePanel({ playback }) {
  const {
    nodes,
    links,
    updateNode,
    updateLink,
    _pushHistory,
    removeNode,
    selectedId,
    selectedIds,
    setSelection,
    setSelected,
    addToSelection,
    setPendingMorphEdit,
    slideBreaks,
    addSlideBreakAt,
    clearSlideBreaks,
    removeSlideBreakAtTime,
    moveSlideBreak,
    timelineEnd,
    setTimelineEnd,
  } = useStore();
  const { isPlaying, currentTime, currentTimeRef, totalDuration, contentDuration, endTime, play, pause, stop, seek, commitTime, frameCallbackRef } = playback;
  // Drawn length of the timeline: the end marker, but never shorter than the content,
  // so blocks past a user-set end stay visible and draggable.
  const layoutDur = Math.max(
    endTime,
    contentDuration ?? totalDuration,
    slideBreaks?.length ? Math.max(...slideBreaks) : 0,
    4
  );

  useEffect(() => {
    // Register high-frequency update callback to bypass React throttle
    frameCallbackRef.current = (t) => {
      if (!playheadRef.current) return;
      const tW = layoutDur * PX_PER_SEC + 160;
      const px = Math.min(t * PX_PER_SEC, tW - 2);
      playheadRef.current.style.left = `${px}px`;
      const label = playheadRef.current.querySelector('[data-time-label]');
      if (label) label.textContent = `${t.toFixed(2)}s`;
      setTimelineCursor(t);
    };
    return () => {
      if (frameCallbackRef.current) frameCallbackRef.current = null;
    };
  }, [layoutDur, frameCallbackRef]);

  // Collapsing animates the panel height (see .tl-panel). `heightCollapsed` drives the
  // height right away; `collapsed` (what the contents follow) lags behind on the way
  // down, so the rows stay in place while the panel slides shut instead of vanishing
  // first. Expanding shows the contents at once and slides the panel open.
  const [collapsed,       setContentCollapsed] = useState(false);
  const [heightCollapsed, setHeightCollapsed]  = useState(false);
  const heightCollapsedRef = useRef(false);
  const collapseTimerRef = useRef(null);
  const setCollapsed = useCallback((next) => {
    const value = typeof next === 'function' ? next(heightCollapsedRef.current) : next;
    heightCollapsedRef.current = value;
    clearTimeout(collapseTimerRef.current);
    setHeightCollapsed(value);
    if (value) collapseTimerRef.current = setTimeout(() => setContentCollapsed(true), PANEL_COLLAPSE_MS);
    else setContentCollapsed(false);
  }, []);
  useEffect(() => () => clearTimeout(collapseTimerRef.current), []);
  // Blueprint mode has nothing playing, so the timeline folds away; leaving it restores
  // whatever the timeline was before.
  const blueprintMode = useStore(state => state.editorMode === 'blueprint');
  const collapsedBeforeBlueprintRef = useRef(null);
  useEffect(() => {
    if (blueprintMode) {
      collapsedBeforeBlueprintRef.current = heightCollapsedRef.current;
      setCollapsed(true);
    } else if (collapsedBeforeBlueprintRef.current != null) {
      setCollapsed(collapsedBeforeBlueprintRef.current);
      collapsedBeforeBlueprintRef.current = null;
    }
  }, [blueprintMode, setCollapsed]);
  const [pxPerSec,      setPxPerSec]      = useState(BASE_PX_PER_SEC);
  const [rowH,          setRowH]          = useState(BASE_ROW_H);
  PX_PER_SEC = pxPerSec;
  setRowScale(rowH);
  const [panelHeight,   setPanelHeight]   = useState(PANEL_DEFAULT_H);
  const [selectedItem,  setSelectedItem]  = useState(null);

  const blockDragRef  = useRef(null);
  // True while a bar drag actually moved; suppresses the trailing click so
  // adjusting timing never changes the selection (plain clicks still select).
  const didBlockDragRef = useRef(false);
  const headDragRef   = useRef(false);
  const timelineRef   = useRef(null);
  const leftBodyRef   = useRef(null);
  const rightBodyRef  = useRef(null);
  const resizeRef     = useRef(null);
  const panelRef      = useRef(null);
  const playheadRef   = useRef(null);  // Direct DOM ref for zero-re-render scrubbing
  const bodyAreaRef   = useRef(null);  // Both timeline columns; owns wheel scroll/zoom
  const zoomAnchorRef = useRef(null);  // { time, offsetX } kept under the cursor while zooming
  const renderedPxRef = useRef(pxPerSec);
  const rowAnchorRef  = useRef(null);  // { rows, offsetY } kept under the cursor while squeezing rows
  const renderedRowHRef = useRef(rowH);

  // After a vertical zoom renders, keep the row that was under the cursor in place.
  useLayoutEffect(() => {
    renderedRowHRef.current = rowH;
    const anchor = rowAnchorRef.current;
    const body = rightBodyRef.current;
    rowAnchorRef.current = null;
    if (!anchor || !body) return;
    body.scrollTop = Math.max(0, anchor.rows * rowH - anchor.offsetY);
    if (leftBodyRef.current) leftBodyRef.current.scrollTop = body.scrollTop;
  }, [rowH]);

  // After a zoom renders, scroll so the time that was under the cursor stays there.
  useLayoutEffect(() => {
    renderedPxRef.current = pxPerSec;
    const anchor = zoomAnchorRef.current;
    const el = timelineRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !el) return;
    el.scrollLeft = Math.max(0, anchor.time * pxPerSec - anchor.offsetX);
  }, [pxPerSec]);

  // Wheel: scroll rows (snappier than the default), Shift/trackpad scrolls time,
  // Ctrl (or Cmd) + wheel zooms the time scale around the cursor, and
  // Alt + wheel squeezes/expands the rows vertically to fit more on screen.
  useEffect(() => {
    const area = bodyAreaRef.current;
    if (!area) return undefined;
    const onWheel = (e) => {
      const unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? area.clientHeight : 1;
      const timeline = timelineRef.current;
      if (e.altKey) {
        e.preventDefault();
        const body = rightBodyRef.current;
        if (!body) return;
        const rect = body.getBoundingClientRect();
        const offsetY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        // Scroll position measured in rows, so it survives the height change.
        if (!rowAnchorRef.current) {
          rowAnchorRef.current = { rows: (body.scrollTop + offsetY) / renderedRowHRef.current, offsetY };
        }
        const delta = (e.deltaY || e.deltaX) * unit;
        setRowH(prev => Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, prev * Math.exp(-delta * WHEEL_ZOOM_RATE))));
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (!timeline) return;
        const rect = timeline.getBoundingClientRect();
        const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        // Anchor to the scale currently on screen; several wheel ticks can land before a render.
        if (!zoomAnchorRef.current) {
          zoomAnchorRef.current = { time: (timeline.scrollLeft + offsetX) / renderedPxRef.current, offsetX };
        }
        const delta = (e.deltaY || e.deltaX) * unit;
        setPxPerSec(prev => Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, prev * Math.exp(-delta * WHEEL_ZOOM_RATE))));
        return;
      }
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      e.preventDefault();
      if (dy && rightBodyRef.current) rightBodyRef.current.scrollTop += dy * WHEEL_SCROLL_SPEED;
      if (dx && timeline) timeline.scrollLeft += dx * WHEEL_SCROLL_SPEED;
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, [collapsed]);
  const syncingScrollRef = useRef(false);

  const timelineNodes = useMemo(() => nodes.filter(node => !isMirrorNode(node)), [nodes]);
  const autoTimes = useMemo(() => computeAutoTimes(timelineNodes, links), [links, timelineNodes]);
  const animationTimeline = useMemo(
    () => new AnimationEngine(timelineNodes, links).getTimeline(),
    [timelineNodes, links]
  );
  const variableWebs = useMemo(() => {
    return computeVariableWebs(timelineNodes, links, { timeline: animationTimeline });
  }, [timelineNodes, links, animationTimeline]);
  const manualTokenTimingByLinkId = useMemo(
    () => computeManualTokenTimingByLinkId(links, animationTimeline),
    [links, animationTimeline]
  );
  const webByVariableId = useMemo(() => {
    const m = {};
    for (const w of variableWebs) m[w.sourceNodeId] = w;
    return m;
  }, [variableWebs]);
  const linkMap = useMemo(() => Object.fromEntries(links.map(link => [link.id, link])), [links]);
  const nodeMap = useMemo(() => Object.fromEntries(nodes.map(node => [node.id, node])), [nodes]);
  const linkLengthById = useMemo(() => Object.fromEntries(
    links.map(link => {
      const fromNode = nodeMap[link.fromId];
      const toNode = nodeMap[link.toId];
      if (!fromNode || !toNode) return [link.id, 0];
      return [link.id, buildLinkRenderData(link, fromNode, toNode, links, nodes).length ?? 0];
    })
  ), [linkMap, links, nodeMap, nodes]);
  const syncedJunctionKeyByLinkId = useMemo(() => Object.fromEntries(
    links.map(link => [link.id, getSyncedJunctionKey(link, linkMap)])
  ), [linkMap, links]);
  const syncedLinkIdsByKey = useMemo(() => {
    const groups = {};
    for (const link of links) {
      const key = syncedJunctionKeyByLinkId[link.id];
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(link.id);
    }
    return groups;
  }, [links, syncedJunctionKeyByLinkId]);
  const boundLinkIdsByKey = useMemo(() => {
    const groups = {};
    for (const link of links) {
      for (const joint of link.joints ?? []) {
        if (!joint?.syncBranches) continue;
        const key = `${link.id}::${joint.id}`;
        const childIds = links
          .filter(item => item.fromJunctionLinkId === link.id && item.fromJunctionJointId === joint.id)
          .map(item => item.id);
        if (!childIds.length) continue;
        groups[key] = [link.id, ...childIds];
      }
    }
    return groups;
  }, [links]);
  const boundKeyByLinkId = useMemo(() => {
    const entries = [];
    for (const [key, linkIds] of Object.entries(boundLinkIdsByKey)) {
      for (const linkId of linkIds) {
        entries.push([linkId, key]);
      }
    }
    return Object.fromEntries(entries);
  }, [boundLinkIdsByKey]);
  const boundGroupStartByKey = useMemo(() => {
    const result = {};
    for (const [key, linkIds] of Object.entries(boundLinkIdsByKey)) {
      const [parentId, jointId] = key.split('::');
      const parentLink = linkMap[parentId];
      if (!parentLink || linkIds.length <= 1) continue;
      const parentStart = getItemStart(parentLink, 'link', autoTimes.links);
      const parentDuration = parentLink.animDuration ?? autoTimes.links[parentId]?.duration ?? 0.65;
      const jointProgress = getLinkJointProgress(parentId, jointId, links, nodes);
      result[key] = jointProgress == null
        ? parentStart
        : parentStart + parentDuration * inverseEaseOut(jointProgress);
    }
    return result;
  }, [autoTimes.links, boundLinkIdsByKey, linkMap, links, nodes]);
  const syncedGroupStartByKey = useMemo(() => {
    const result = {};
    for (const [key, linkIds] of Object.entries(syncedLinkIdsByKey)) {
      result[key] = Math.min(...linkIds.map(linkId => {
        const link = linkMap[linkId];
        return link ? getItemStart(link, 'link', autoTimes.links) : 0;
      }));
    }
    return result;
  }, [autoTimes.links, linkMap, syncedLinkIdsByKey]);
  const selectionOrder = useMemo(() => ([
    ...timelineNodes.map(node => ({ kind: 'node', id: node.id, key: `node:${node.id}` })),
    ...links.map(link => ({ kind: 'link', id: link.id, key: `link:${link.id}` })),
  ]), [links, timelineNodes]);
  const selectionIndexByKey = useMemo(
    () => Object.fromEntries(selectionOrder.map((item, index) => [item.key, index])),
    [selectionOrder]
  );

  useEffect(() => {
    for (const [key, linkIds] of Object.entries(boundLinkIdsByKey)) {
      const [parentId] = key.split('::');
      const branchStart = boundGroupStartByKey[key];
      if (branchStart == null) continue;
      for (const linkId of linkIds) {
        if (linkId === parentId) continue;
        const link = linkMap[linkId];
        const currentStart = link?.animStartTime;
        if (currentStart == null || Math.abs(currentStart - branchStart) > 0.001) {
          updateLink(linkId, { animStartTime: branchStart, syncGroupKey: key });
        }
      }
    }
  }, [boundGroupStartByKey, boundLinkIdsByKey, linkMap, updateLink]);

  const effectiveTiming = useCallback((item, kind) => {
    const pool       = kind === 'node' ? autoTimes.nodes : autoTimes.links;
    const defaultDur = kind === 'node' ? 0.5 : 0.65;
    const syncKey = kind === 'link' ? syncedJunctionKeyByLinkId[item.id] : null;
    const sharedStart = syncKey ? syncedGroupStartByKey[syncKey] : null;
    const boundKey = kind === 'link' ? boundKeyByLinkId[item.id] : null;
    const branchSharedStart = boundKey && !item.fromJunctionLinkId
      ? null
      : boundKey
        ? boundGroupStartByKey[boundKey]
        : null;
    const visualStart = branchSharedStart ?? sharedStart ?? getItemStart(item, kind, pool);
    const baseDuration = item.animDuration ?? pool[item.id]?.duration ?? defaultDur;
    return {
      start: visualStart,
      duration: baseDuration,
      displayDuration: pool[item.id]?.displayDuration ?? baseDuration,
      isAuto:   item.animStartTime == null,
    };
  }, [autoTimes, boundGroupStartByKey, boundKeyByLinkId, syncedGroupStartByKey, syncedJunctionKeyByLinkId]);
  const previewBlockedRanges = useMemo(() => (
    timelineNodes
      .map(node => {
        const timing = autoTimes.nodes[node.id];
        if (timing?.popupStart == null || timing?.popupEnd == null || timing.popupEnd <= timing.popupStart) return null;
        return {
          ownerId: node.id,
          start: timing.popupStart,
          end: timing.popupEnd,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.ownerId.localeCompare(b.ownerId))
  ), [autoTimes.nodes, timelineNodes]);

  const clampMoveStartAgainstPreviewRanges = useCallback((nextStart, duration, excludeIds, direction, dragState = null) => {
    const excluded = new Set(excludeIds ?? []);
    let clampedStart = Math.max(0, nextStart);
    const ranges = previewBlockedRanges.filter(range => !excluded.has(range.ownerId));
    const activeCrossing = dragState?.previewCrossing ?? null;
    const setActiveCrossing = (nextCrossing) => {
      if (dragState) dragState.previewCrossing = nextCrossing;
    };
    if (direction < 0) {
      for (let i = ranges.length - 1; i >= 0; i -= 1) {
        const range = ranges[i];
        const farEdge = Math.max(0, range.start - duration);
        const nearEdge = range.end;
        const isActiveRange = activeCrossing?.ownerId === range.ownerId && activeCrossing?.side === 'left';
        if (isActiveRange && activeCrossing?.crossed) {
          if (clampedStart > nearEdge) {
            setActiveCrossing(null);
            continue;
          }
          if (clampedStart > farEdge) return farEdge;
          setActiveCrossing(null);
          return clampedStart;
        }
        if (clampedStart < nearEdge && clampedStart > farEdge) {
          if (!isActiveRange) {
            setActiveCrossing({ ownerId: range.ownerId, side: 'left', crossed: false });
          }
          clampedStart = nearEdge;
          return clampedStart;
        }
        if (isActiveRange && clampedStart <= farEdge) {
          setActiveCrossing({ ownerId: range.ownerId, side: 'left', crossed: true });
          return farEdge;
        }
      }
      setActiveCrossing(null);
      return clampedStart;
    }
    for (const range of ranges) {
      const nearEdge = Math.max(0, range.start - duration);
      const farEdge = range.end;
      const isActiveRange = activeCrossing?.ownerId === range.ownerId && activeCrossing?.side === 'right';
      if (isActiveRange && activeCrossing?.crossed) {
        if (clampedStart < nearEdge) {
          setActiveCrossing(null);
          continue;
        }
        if (clampedStart < farEdge) return farEdge;
        setActiveCrossing(null);
        return clampedStart;
      }
      if (clampedStart >= nearEdge && clampedStart < farEdge) {
        if (!isActiveRange) {
          setActiveCrossing({ ownerId: range.ownerId, side: 'right', crossed: false });
        }
        clampedStart = nearEdge;
        return clampedStart;
      }
      if (isActiveRange && clampedStart >= farEdge) {
        setActiveCrossing({ ownerId: range.ownerId, side: 'right', crossed: true });
        return farEdge;
      }
    }
    setActiveCrossing(null);
    return clampedStart;
  }, [previewBlockedRanges]);

  const clampResizeDurationAgainstPreviewRanges = useCallback((start, nextDuration, excludeIds) => {
    const excluded = new Set(excludeIds ?? []);
    const ranges = previewBlockedRanges.filter(range => !excluded.has(range.ownerId));
    let end = Math.max(start + MIN_DUR, start + nextDuration);
    for (const range of ranges) {
      if (range.start <= start) continue;
      if (end > range.start) {
        end = Math.min(end, range.start);
      }
    }
    return r2(Math.max(MIN_DUR, end - start));
  }, [previewBlockedRanges]);

  const setNodeTextMorphs = useCallback((nodeId, nextMorphs) => {
    updateNode(nodeId, {
      textMorphs: normalizeTextMorphList(nextMorphs),
      morphText: '',
      morphMode: 'fade',
      morphStartDelay: null,
      morphStartTime: null,
      morphDuration: null,
    });
  }, [updateNode]);

  const updateTextMorph = useCallback((nodeId, morphId, updates, pushHistory = true) => {
    const node = nodeMap[nodeId];
    if (!node) return;
    if (pushHistory) _pushHistory();
    const timing = effectiveTiming(node, 'node');
    const morphs = getNodeTextMorphs(node, timing).map(morph => (
      morph.id === morphId ? { ...morph, ...updates } : morph
    ));
    setNodeTextMorphs(nodeId, morphs);
  }, [_pushHistory, effectiveTiming, nodeMap, setNodeTextMorphs]);

  const addTextMorph = useCallback((nodeId, { inlineEdit = true } = {}) => {
    const node = nodeMap[nodeId];
    if (!node) return null;
    _pushHistory();
    const timing = effectiveTiming(node, 'node');
    const morphs = getNodeTextMorphs(node, timing);
    const newMorph = {
      id: uuid(),
      text: '',
      mode: 'fade',
      startTime: r2(getNextTextMorphStart(node, timing)),
      duration: r2(Math.max(0.4, timing.duration)),
    };
    setNodeTextMorphs(nodeId, [...morphs, newMorph]);
    setSelected(nodeId);
    setSelectedItem({ kind: 'text-morph', id: nodeId, morphId: newMorph.id });
    if (inlineEdit) setPendingMorphEdit(nodeId, newMorph.id);
    return newMorph.id;
  }, [_pushHistory, effectiveTiming, nodeMap, setNodeTextMorphs, setSelected, setPendingMorphEdit]);

  const startTransformBlockDrag = useCallback((e, item, dragType) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    _pushHistory();
    const tAutoStart = autoTimes.nodes[item.id]?.transformStart ?? null;
    const tStart = item.transformStartTime ?? tAutoStart ?? 0;
    const tDur = item.transformDuration ?? 0.4;
    if (item.transformStartTime == null) {
      updateNode(item.id, { transformStartTime: r2(tStart) });
    }
    blockDragRef.current = {
      dragType,
      kind: 'node',
      itemId: item.id,
      morphId: null,
      startX: e.clientX,
      initStart: tStart,
      initDur: tDur,
      initTransformStart: tStart,
      initTransformDur: tDur,
      linkGroup: null,
      multiGroup: null,
      previewCrossing: null,
    };
  }, [_pushHistory, autoTimes.nodes, updateNode]);

  const removeTextMorph = useCallback((nodeId, morphId) => {
    const node = nodeMap[nodeId];
    if (!node) return;
    _pushHistory();
    const timing = effectiveTiming(node, 'node');
    const morphs = getNodeTextMorphs(node, timing).filter(morph => morph.id !== morphId);
    setNodeTextMorphs(nodeId, morphs);
    setSelected(nodeId);
    setSelectedItem({ kind: 'node', id: nodeId });
  }, [_pushHistory, effectiveTiming, nodeMap, setNodeTextMorphs, setSelected]);

  const setNodeFailureKeyframes = useCallback((nodeId, keyframes) => {
    updateNode(nodeId, {
      failing: false,
      offline: false,
      failureKeyframes: normalizeNodeFailureKeyframes(keyframes),
    });
  }, [updateNode]);

  // Links fail the same way as nodes: one timed failure that replaces the other failure modes.
  const setLinkFailureKeyframes = useCallback((linkId, keyframes) => {
    updateLink(linkId, {
      failing: false,
      failAtEnds: false,
      failOnTokenEnd: false,
      failureKeyframes: normalizeNodeFailureKeyframes(keyframes),
    });
  }, [updateLink]);

  const updateScrollStep = useCallback((nodeId, stepId, updates, pushHistory = true) => {
    const node = nodeMap[nodeId];
    if (!node) return;
    if (pushHistory) _pushHistory();
    updateNode(nodeId, {
      scrollSteps: normalizeScrollSteps(node.scrollSteps).map(step => (
        step.id === stepId ? { ...step, ...updates } : step
      )),
    });
  }, [_pushHistory, nodeMap, updateNode]);

  const removeScrollStep = useCallback((nodeId, stepId) => {
    const node = nodeMap[nodeId];
    if (!node) return;
    _pushHistory();
    updateNode(nodeId, {
      scrollSteps: normalizeScrollSteps(node.scrollSteps).filter(step => step.id !== stepId),
    });
    setSelected(nodeId);
    setSelectedItem({ kind: 'node', id: nodeId });
  }, [_pushHistory, nodeMap, updateNode, setSelected]);

  const setManualTokenTextKeyframes = useCallback((linkId, keyframes) => {
    updateLink(linkId, {
      manualTokenTextKeyframes: normalizeManualTokenTextKeyframes(keyframes),
    });
  }, [updateLink]);

  const updateManualTokenTextKeyframe = useCallback((linkId, keyframeId, updates, pushHistory = true) => {
    const link = linkMap[linkId];
    if (!link) return;
    if (pushHistory) _pushHistory();
    const keyframes = normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes).map(keyframe => (
      keyframe.id === keyframeId ? { ...keyframe, ...updates } : keyframe
    ));
    setManualTokenTextKeyframes(linkId, keyframes);
  }, [_pushHistory, linkMap, setManualTokenTextKeyframes]);

  const addManualTokenTextKeyframe = useCallback((linkId) => {
    const link = linkMap[linkId];
    if (!link?.manualTokenEnabled) return;
    _pushHistory();
    const timing = manualTokenTimingByLinkId[linkId];
    const playheadTime = currentTimeRef?.current ?? currentTime;
    const time = timing
      ? r2(Math.max(timing.start, Math.min(timing.start + timing.duration, playheadTime)))
      : r2(Math.max(0, playheadTime));
    const keyframe = {
      id: uuid(),
      time,
      text: getManualTokenTextAtTime(link, time),
    };
    setManualTokenTextKeyframes(linkId, [
      ...normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes),
      keyframe,
    ]);
    setSelected(linkId);
    setSelectedItem({ kind: 'manual-token-text', id: linkId, keyframeId: keyframe.id });
  }, [_pushHistory, currentTime, currentTimeRef, linkMap, manualTokenTimingByLinkId, setManualTokenTextKeyframes, setSelected]);

  const removeManualTokenTextKeyframe = useCallback((linkId, keyframeId) => {
    const link = linkMap[linkId];
    if (!link) return;
    _pushHistory();
    setManualTokenTextKeyframes(
      linkId,
      normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes)
        .filter(keyframe => keyframe.id !== keyframeId)
    );
    setSelected(linkId);
    setSelectedItem({ kind: 'link', id: linkId });
  }, [_pushHistory, linkMap, setManualTokenTextKeyframes, setSelected]);

  const selKind = selectedItem?.kind;
  const selBaseKind = (
    selKind === 'text-morph'
    || selKind === 'graph-point'
    || selKind === 'graph-domain'
    || selKind === 'graph-calc'
    || selKind === 'node-failure'
    || selKind === 'scroll-step'
    || selKind === 'variable-token'
  )
    ? 'node'
    : selKind === 'manual-token-text' || selKind === 'link-failure' || selKind === 'manual-token'
      ? 'link'
      : selKind;
  const selData = !selectedItem ? null : selBaseKind === 'node'
    ? nodes.find(n => n.id === selectedItem.id) ?? null
    : links.find(e => e.id === selectedItem.id) ?? null;
  const selTiming = selData ? effectiveTiming(selData, selBaseKind) : null;
  const selMorph = selKind === 'text-morph' && selData && selTiming
    ? getTextMorphById(selData, selectedItem.morphId, selTiming)
    : null;
  const selManualTokenTextKeyframe = selKind === 'manual-token-text' && selData
    ? normalizeManualTokenTextKeyframes(selData.manualTokenTextKeyframes)
        .find(keyframe => keyframe.id === selectedItem.keyframeId) ?? null
    : null;
  const selGraphPoint = selKind === 'graph-point' && selData
    ? (selData.graphPoints ?? []).find(p => p.id === selectedItem.pointId) ?? null
    : null;
  const selNodeFailure = (selKind === 'node-failure' || selKind === 'link-failure') && selData
    ? normalizeNodeFailureKeyframes(selData.failureKeyframes)
        .find(keyframe => keyframe.id === selectedItem.failureId) ?? null
    : null;
  const selScrollStep = selKind === 'scroll-step' && selData
    ? normalizeScrollSteps(selData.scrollSteps)
        .find(step => step.id === selectedItem.stepId) ?? null
    : null;
  const selWeb = selKind === 'variable-token' && selData ? webByVariableId[selData.id] : null;
  const selLabel  = selKind === 'text-morph'
    ? `${selData?.label ?? '?'} morph`
    : selKind === 'manual-token-text'
      ? `${selData ? linkLabel(selData, nodes) : '?'} text key`
    : selKind === 'variable-token'
      ? `${selData?.variableLabel || selData?.label || '?'} token`
    : selKind === 'node-failure'
      ? `${selData?.label ?? '?'} failure`
    : selKind === 'link-failure'
      ? `${selData ? linkLabel(selData, nodes) : '?'} failure`
    : selKind === 'manual-token'
      ? `${selData ? linkLabel(selData, nodes) : '?'} token`
    : selKind === 'scroll-step'
      ? `${selData?.label ?? '?'} step`
    : selBaseKind === 'node'
      ? (selData?.label ?? '?')
    : selData ? linkLabel(selData, nodes) : null;
  const selectedBoundKey = selBaseKind === 'link' ? boundKeyByLinkId[selectedItem?.id] : null;
  const selectedBoundLinkIds = selectedBoundKey ? boundLinkIdsByKey[selectedBoundKey] ?? [] : [];
  const buildBoundDurationUpdates = useCallback((sourceLinkId, nextDuration) => {
    const key = boundKeyByLinkId[sourceLinkId];
    const normalizedDuration = nextDuration == null ? null : r2(Math.max(MIN_DUR, nextDuration));
    if (!key) {
      return {
        [sourceLinkId]: { animDuration: normalizedDuration },
      };
    }

    const [parentId, jointId] = key.split('::');
    const memberIds = boundLinkIdsByKey[key] ?? [sourceLinkId];

    if (sourceLinkId === parentId) {
      const updates = {
        [parentId]: { animDuration: normalizedDuration },
      };
      const parentLength = linkLengthById[parentId] ?? 0;
      const junctionProgress = getLinkJointProgress(parentId, jointId, links, nodes);
      const junctionTimeFraction = junctionProgress == null ? 0 : inverseEaseOut(junctionProgress);
      const remainingParentDistance = parentLength > 0 && junctionProgress != null
        ? Math.max(0, parentLength * (1 - junctionProgress))
        : 0;
      const remainingParentDuration = normalizedDuration != null
        ? Math.max(MIN_DUR, normalizedDuration * (1 - junctionTimeFraction))
        : null;
      const postJunctionSpeed = normalizedDuration != null && remainingParentDistance > 0
        ? remainingParentDistance / Math.max(remainingParentDuration, MIN_DUR)
        : null;

      for (const memberId of memberIds) {
        if (memberId === parentId) continue;
        const member = linkMap[memberId];
        updates[memberId] = {
          animDuration: postJunctionSpeed == null
            ? normalizedDuration
            : r2(Math.max(MIN_DUR, (linkLengthById[memberId] ?? 0) / postJunctionSpeed)),
          ...(member?.fromJunctionLinkId && member?.fromJunctionJointId ? { animStartTime: null } : {}),
        };
      }
      return updates;
    }

    const sourceLength = linkLengthById[sourceLinkId] ?? 0;
    if (normalizedDuration == null || sourceLength <= 0) {
      return Object.fromEntries(memberIds.map(memberId => [memberId, {
        animDuration: normalizedDuration,
        ...(linkMap[memberId]?.fromJunctionLinkId && linkMap[memberId]?.fromJunctionJointId ? { animStartTime: null } : {}),
      }]));
    }
    const durationPerUnit = normalizedDuration / sourceLength;
    return Object.fromEntries(memberIds.map(memberId => {
      const memberLength = linkLengthById[memberId] ?? 0;
      return [memberId, {
        animDuration: memberLength > 0
          ? r2(Math.max(MIN_DUR, memberLength * durationPerUnit))
          : normalizedDuration,
        ...(linkMap[memberId]?.fromJunctionLinkId && linkMap[memberId]?.fromJunctionJointId ? { animStartTime: null } : {}),
      }];
    }));
  }, [boundKeyByLinkId, boundLinkIdsByKey, effectiveTiming, linkLengthById, linkMap, links, nodes]);
  const updateLinkStartGroup = useCallback((linkId, nextStart) => {
    const key = syncedJunctionKeyByLinkId[linkId];
    if (!key) {
      updateLink(linkId, {
        animStartTime: nextStart == null ? null : r2(Math.max(0, nextStart)),
      });
      return;
    }
    for (const siblingId of syncedLinkIdsByKey[key] ?? [linkId]) {
      updateLink(siblingId, {
        animStartTime: nextStart == null ? null : r2(Math.max(0, nextStart)),
      });
    }
  }, [syncedJunctionKeyByLinkId, syncedLinkIdsByKey, updateLink]);
  const updateLinkDurationGroup = useCallback((linkId, nextDuration) => {
    const updatesById = buildBoundDurationUpdates(linkId, nextDuration);
    for (const [memberId, updates] of Object.entries(updatesById)) {
      updateLink(memberId, updates);
    }
  }, [buildBoundDurationUpdates, updateLink]);
  const freezeIndependentTimelineItems = useCallback((excludeKind = null, excludeId = null) => {
    // Triggered items follow their trigger and blueprint items stay off the timeline,
    // so neither gets a fixed start time.
    for (const node of nodes) {
      if (isTriggeredItem(node, 'node') || isBlueprintItem(node, 'node')) continue;
      if (excludeKind === 'node' && excludeId === node.id) continue;
      const timing = effectiveTiming(node, 'node');
      const updates = {};
      if (node.animStartTime == null) updates.animStartTime = timing.start;
      if (node.animDuration == null) updates.animDuration = timing.duration;
      if (Object.keys(updates).length) updateNode(node.id, updates);
    }

    for (const link of links) {
      if (link.fromJunctionLinkId || syncedJunctionKeyByLinkId[link.id] || boundKeyByLinkId[link.id]) continue;
      if (isTriggeredItem(link, 'link') || isBlueprintItem(link, 'link')) continue;
      if (excludeKind === 'link' && excludeId === link.id) continue;
      const timing = effectiveTiming(link, 'link');
      const updates = {};
      if (link.animStartTime == null) updates.animStartTime = timing.start;
      if (link.animDuration == null) updates.animDuration = timing.duration;
      if (Object.keys(updates).length) updateLink(link.id, updates);
    }
  }, [boundKeyByLinkId, effectiveTiming, links, nodes, syncedJunctionKeyByLinkId, updateLink, updateNode]);
  const doUpdate  = (updates) => selBaseKind === 'node'
    ? (
        (() => {
          _pushHistory();
          if (Object.prototype.hasOwnProperty.call(updates, 'animStartTime') || Object.prototype.hasOwnProperty.call(updates, 'animDuration')) {
            freezeIndependentTimelineItems('node', selectedItem.id);
          }
          updateNode(selectedItem.id, updates);
        })()
      )
    : (
        (() => {
          _pushHistory();
          if (Object.prototype.hasOwnProperty.call(updates, 'animStartTime') || Object.prototype.hasOwnProperty.call(updates, 'animDuration')) {
            freezeIndependentTimelineItems('link', selectedItem.id);
          }
          const rest = { ...updates };
          if (Object.prototype.hasOwnProperty.call(updates, 'animStartTime')) {
            updateLinkStartGroup(selectedItem.id, updates.animStartTime);
            delete rest.animStartTime;
          }
          if (Object.prototype.hasOwnProperty.call(updates, 'animDuration')) {
            updateLinkDurationGroup(selectedItem.id, updates.animDuration);
            delete rest.animDuration;
          }
          if (Object.keys(rest).length) {
            updateLink(selectedItem.id, rest);
            return;
          }
          if (Object.prototype.hasOwnProperty.call(updates, 'animStartTime') || Object.prototype.hasOwnProperty.call(updates, 'animDuration')) return;
          updateLink(selectedItem.id, updates);
        })()
      );

  useEffect(() => {
    if (!selectedItem) return;
    if (selectedItem.kind === 'link' || selectedItem.kind === 'manual-token-text' || selectedItem.kind === 'link-failure' || selectedItem.kind === 'manual-token') {
      const link = links.find(item => item.id === selectedItem.id);
      if (!link) {
        setSelectedItem(null);
      } else if (selectedItem.kind === 'manual-token' && !link.manualTokenEnabled) {
        setSelectedItem({ kind: 'link', id: selectedItem.id });
      } else if (
        selectedItem.kind === 'link-failure'
        && !normalizeNodeFailureKeyframes(link.failureKeyframes)
          .some(keyframe => keyframe.id === selectedItem.failureId)
      ) {
        setSelectedItem({ kind: 'link', id: selectedItem.id });
      } else if (
        selectedItem.kind === 'manual-token-text'
        && !normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes)
          .some(keyframe => keyframe.id === selectedItem.keyframeId)
      ) {
        setSelectedItem({ kind: 'link', id: selectedItem.id });
      }
      return;
    }
    const node = nodes.find(item => item.id === selectedItem.id);
    if (!node) {
      setSelectedItem(null);
      return;
    }
    if (selectedItem.kind === 'text-morph') {
      const timing = effectiveTiming(node, 'node');
      if (!getTextMorphById(node, selectedItem.morphId, timing)) {
        setSelectedItem({ kind: 'node', id: selectedItem.id });
      }
    }
    if (
      selectedItem.kind === 'node-failure'
      && !normalizeNodeFailureKeyframes(node.failureKeyframes)
        .some(keyframe => keyframe.id === selectedItem.failureId)
    ) {
      setSelectedItem({ kind: 'node', id: selectedItem.id });
    }
    if (
      selectedItem.kind === 'scroll-step'
      && !normalizeScrollSteps(node.scrollSteps).some(step => step.id === selectedItem.stepId)
    ) {
      setSelectedItem({ kind: 'node', id: selectedItem.id });
    }
    if (selectedItem.kind === 'variable-token' && node.type !== 'variable') {
      setSelectedItem({ kind: 'node', id: selectedItem.id });
    }
    if (
      (selectedItem.kind === 'graph-domain' || selectedItem.kind === 'graph-calc')
      && !(node.graphDomains ?? []).some(dom => dom.id === selectedItem.domainId
        && (selectedItem.kind === 'graph-domain' || dom.calc))
    ) {
      setSelectedItem({ kind: 'node', id: selectedItem.id });
    }
  }, [effectiveTiming, links, nodes, selectedItem]);

  useEffect(() => {
    if (!selectedItem && timelineNodes.length > 0) setSelectedItem({ kind: 'node', id: timelineNodes[0].id });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineNodes.length]);

  useEffect(() => {
    if (!selectedId) return;
    // Timeline drags update the node/link stores on every pointer move. Do not
    // turn those updates into selection changes or scroll corrections.
    if (blockDragRef.current) return;
    const isNode = !!nodes.find(n => n.id === selectedId);
    const isLink = !isNode && !!links.find(l => l.id === selectedId);
    if (!isNode && !isLink) return;
    if (isNode && isMirrorNode(nodes.find(node => node.id === selectedId))) {
      setSelectedItem(null);
      return;
    }
    const selectedParentKind = selectedItem?.kind === 'manual-token-text' || selectedItem?.kind === 'link-failure' || selectedItem?.kind === 'manual-token'
      ? 'link'
      : selectedItem?.kind === 'text-morph'
        || selectedItem?.kind === 'graph-point'
        || selectedItem?.kind === 'node-failure'
        || selectedItem?.kind === 'scroll-step'
        || selectedItem?.kind === 'variable-token'
        ? 'node'
        : selectedItem?.kind;
    if (
      selectedItem?.id === selectedId
      && ((selectedParentKind === 'node' && isNode) || (selectedParentKind === 'link' && isLink))
    ) return;
    const kind = isNode ? 'node' : 'link';
    setSelectedItem({ kind, id: selectedId });

    requestAnimationFrame(() => {
      if (blockDragRef.current) return;
      const el = leftBodyRef.current;
      if (!el) return;
      const row = el.querySelector(`[data-row-id="${kind}-${selectedId}"]`);
      if (!row) return;

      // Keep scrolling local to the timeline. Element.scrollIntoView can also
      // move the panel or page, which made timeline edits jump upward.
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      const viewportTop = el.scrollTop;
      const viewportBottom = viewportTop + el.clientHeight;
      let nextScrollTop = viewportTop;
      if (rowTop < viewportTop) nextScrollTop = rowTop;
      else if (rowBottom > viewportBottom) nextScrollTop = rowBottom - el.clientHeight;

      if (nextScrollTop !== viewportTop) {
        el.scrollTop = nextScrollTop;
        if (rightBodyRef.current) rightBodyRef.current.scrollTop = nextScrollTop;
      }
    });
  }, [links, nodes, selectedId, selectedItem]); // eslint-disable-line react-hooks/exhaustive-deps

  const seekFromClientX = useCallback((clientX) => {
    const el = timelineRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left + el.scrollLeft;
    // The scrubbable range is the full drawn ruler (content + breathing room),
    // not just the playback duration — otherwise the playhead sticks at the end
    // of the content while the cursor keeps moving.
    const tW = layoutDur * PX_PER_SEC + 40;
    const maxT = (tW - 2) / PX_PER_SEC;
    const t = Math.max(0, Math.min(relX / PX_PER_SEC, maxT));

    // Update the playhead DOM position immediately without a React re-render.
    // The throttled `seek` call will eventually sync React state, but the visual
    // feedback needs to be instant so the scrubber doesn't feel laggy.
    if (playheadRef.current) {
      playheadRef.current.style.left = (t * PX_PER_SEC) + 'px';
      const label = playheadRef.current.querySelector('[data-time-label]');
      if (label) label.textContent = t.toFixed(2) + 's';
    }

    seek(t, maxT);
    setTimelineCursor(t);
  }, [seek, layoutDur]);

  useEffect(() => {
    // ── Edge auto-scroll ──────────────────────────────────────────────────────
    // Runs as a RAF loop so scrolling continues even when the cursor is held still.
    const cursorXRef = { current: 0 };
    let autoScrollRAF = null;

    const runAutoScroll = () => {
      if (!blockDragRef.current) { autoScrollRAF = null; return; }
      const tl = timelineRef.current;
      if (!tl) { autoScrollRAF = null; return; }
      const rect = tl.getBoundingClientRect();
      const cx = cursorXRef.current;
      const ZONE = 72;        // px from edge where scroll kicks in
      const MAX_SPEED = 14;   // px per frame at full intensity
      let delta = 0;
      if (cx > rect.right - ZONE)  delta =  MAX_SPEED * Math.min(1, (cx - (rect.right - ZONE))  / ZONE);
      if (cx < rect.left  + ZONE)  delta = -MAX_SPEED * Math.min(1, ((rect.left + ZONE) - cx)   / ZONE);
      if (Math.abs(delta) > 0.3) tl.scrollLeft += delta;
      autoScrollRAF = requestAnimationFrame(runAutoScroll);
    };
    // ─────────────────────────────────────────────────────────────────────────

    const onMove = (e) => {
      const d = blockDragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.startX) > 3) didBlockDragRef.current = true;
      cursorXRef.current = e.clientX;
      if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(runAutoScroll);
      const dtSec  = (e.clientX - d.startX) / PX_PER_SEC;
      if (d.dragType === 'transform-move' || d.dragType === 'transform-resize') {
        const nextStart = d.dragType === 'transform-move'
          ? r2(Math.max(0, d.initTransformStart + dtSec))
          : d.initTransformStart;
        const nextDuration = d.dragType === 'transform-resize'
          ? r2(Math.max(0.1, d.initTransformDur + dtSec))
          : d.initTransformDur;
        updateNode(d.itemId, { transformStartTime: nextStart, transformDuration: nextDuration });
        return;
      }
      if ((d.dragType === 'morph-move' || d.dragType === 'morph-resize') && d.morphId) {
        const node = nodeMap[d.itemId];
        if (!node) return;
        const timing = effectiveTiming(node, 'node');
        const morphs = getNodeTextMorphs(node, timing).map(morph => {
          if (morph.id !== d.morphId) return morph;
          return d.dragType === 'morph-move'
            ? { ...morph, startTime: r2(Math.max(0, d.initMorphStart + dtSec)), duration: d.initMorphDur }
            : { ...morph, startTime: d.initMorphStart, duration: r2(Math.max(0.1, d.initMorphDur + dtSec)) };
        });
        setNodeTextMorphs(d.itemId, morphs);
        return;
      }
      if (d.kind === 'manual-token') {
        if (d.dragType === 'manual-token-move') {
          // Never start before 0s.
          const delay = Math.max(-d.anchorTime, d.initDelay + dtSec);
          updateLink(d.itemId, { manualTokenDelay: r2(delay) });
        } else {
          updateLink(d.itemId, { manualTokenDuration: r2(Math.max(0.05, d.initDur + dtSec)) });
        }
        return;
      }
      if (d.kind === 'manual-token-text' && d.keyframeId) {
        const link = linkMap[d.itemId];
        if (!link) return;
        const nextTime = r2(Math.max(0, d.initKeyframeTime + dtSec));
        const keyframes = normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes).map(keyframe => (
          keyframe.id === d.keyframeId ? { ...keyframe, time: nextTime } : keyframe
        ));
        setManualTokenTextKeyframes(d.itemId, keyframes);
        return;
      }
      if (d.multiGroup?.length) {
        const groupMinStart = Math.min(...d.multiGroup.map(groupItem => groupItem.initStart));
        const groupMaxEnd = Math.max(...d.multiGroup.map(groupItem => groupItem.initStart + groupItem.initDur));
        const clampedGroupStart = clampMoveStartAgainstPreviewRanges(
          groupMinStart + dtSec,
          groupMaxEnd - groupMinStart,
          d.multiGroup.map(groupItem => groupItem.id),
          dtSec,
          d
        );
        const groupDtSec = clampedGroupStart - groupMinStart;
        for (const groupItem of d.multiGroup) {
          if (groupItem.kind === 'node') {
            updateNode(groupItem.id, {
              animStartTime: r2(Math.max(0, groupItem.initStart + groupDtSec)),
              animDuration: groupItem.initDur,
            });
            continue;
          }
          updateLink(groupItem.id, {
            animStartTime: r2(Math.max(0, groupItem.initStart + groupDtSec)),
            animDuration: groupItem.initDur,
          });
        }
        return;
      }
      if (d.kind === 'graph-point') {
        const node = nodeMap[d.itemId];
        if (!node) return;
        const nextStart = d.dragType === 'gp-move'
          ? r2(Math.max(0, d.initStart + dtSec))
          : d.initStart;
        const nextDur = d.dragType === 'gp-resize'
          ? r2(Math.max(MIN_DUR, d.initDur + dtSec))
          : d.initDur;
        const next = (node.graphPoints ?? []).map(p => p.id === d.pointId ? { ...p, startTime: nextStart, duration: nextDur } : p);
        updateNode(d.itemId, { graphPoints: next });
        return;
      }
      if (d.kind === 'graph-domain') {
        const node = nodeMap[d.itemId];
        if (!node) return;
        const nextStart = d.dragType === 'gdomain-move'
          ? r2(Math.max(0, d.initStart + dtSec))
          : d.initStart;
        const nextDur = d.dragType === 'gdomain-resize'
          ? r2(Math.max(MIN_DUR, d.initDur + dtSec))
          : d.initDur;
        const next = (node.graphDomains ?? []).map(dom => dom.id === d.domainId
          ? { ...dom, startTime: nextStart, duration: nextDur } : dom);
        updateNode(d.itemId, { graphDomains: next });
        return;
      }
      if (d.kind === 'graph-calc') {
        const node = nodeMap[d.itemId];
        if (!node) return;
        const nextTime = d.dragType === 'gcalc-move'
          ? r2(Math.max(0, d.initStart + dtSec))
          : d.initStart;
        const nextDur = d.dragType === 'gcalc-resize'
          ? r2(Math.max(MIN_DUR, d.initDur + dtSec))
          : d.initDur;
        const next = (node.graphDomains ?? []).map(dom => dom.id === d.domainId && dom.calc
          ? { ...dom, calc: { ...dom.calc, time: nextTime, duration: nextDur } } : dom);
        updateNode(d.itemId, { graphDomains: next });
        return;
      }
      if (d.kind === 'node-failure' || d.kind === 'link-failure') {
        const owner = d.kind === 'link-failure' ? linkMap[d.itemId] : nodeMap[d.itemId];
        if (!owner) return;
        const nextStart = d.dragType === 'node-failure-move'
          ? r2(Math.max(0, d.initStart + dtSec))
          : d.initStart;
        const nextDur = d.dragType === 'node-failure-resize'
          ? r2(Math.max(MIN_DUR, d.initDur + dtSec))
          : d.initDur;
        const setKeyframes = d.kind === 'link-failure' ? setLinkFailureKeyframes : setNodeFailureKeyframes;
        setKeyframes(
          d.itemId,
          normalizeNodeFailureKeyframes(owner.failureKeyframes).map(keyframe => (
            keyframe.id === d.failureId
              ? { ...keyframe, startTime: nextStart, duration: nextDur }
              : keyframe
          ))
        );
        return;
      }
      if (d.kind === 'scroll-step') {
        const node = nodeMap[d.itemId];
        if (!node) return;
        const nextTime = d.dragType === 'scroll-step-move'
          ? r2(Math.max(0, d.initStart + dtSec))
          : d.initStart;
        const nextDur = d.dragType === 'scroll-step-resize'
          ? r2(Math.max(MIN_DUR, d.initDur + dtSec))
          : d.initDur;
        updateNode(d.itemId, {
          scrollSteps: normalizeScrollSteps(node.scrollSteps).map(step => (
            step.id === d.stepId ? { ...step, time: nextTime, duration: nextDur } : step
          )),
        });
        return;
      }
      if (d.kind === 'node') {
        const clampedStart = d.dragType === 'move'
          ? clampMoveStartAgainstPreviewRanges(
              d.initStart + dtSec,
              d.initDur,
              [d.itemId],
              dtSec,
              d
            )
          : d.initStart;
        const update = d.dragType === 'move'
          ? { animStartTime: r2(clampedStart), animDuration: d.initDur }
          : { animDuration: clampResizeDurationAgainstPreviewRanges(d.initStart, d.initDur + dtSec, [d.itemId]) };
        updateNode(d.itemId, update);
        return;
      }

      if (d.linkGroup?.length) {
        const groupMinStart = Math.min(...d.linkGroup.map(groupItem => groupItem.initStart));
        const groupMaxEnd = Math.max(...d.linkGroup.map(groupItem => groupItem.initStart + groupItem.initDur));
        const clampedGroupStart = clampMoveStartAgainstPreviewRanges(
          groupMinStart + dtSec,
          groupMaxEnd - groupMinStart,
          d.linkGroup.map(groupItem => groupItem.id),
          dtSec,
          d
        );
        const groupDtSec = clampedGroupStart - groupMinStart;
        const resizedDuration = clampResizeDurationAgainstPreviewRanges(d.initStart, d.initDur + dtSec, d.linkGroup.map(groupItem => groupItem.id));
        if (d.dragType === 'resize') {
          const updatesById = buildBoundDurationUpdates(d.itemId, resizedDuration);
          for (const [memberId, updates] of Object.entries(updatesById)) {
            updateLink(memberId, updates);
          }
          return;
        }
        for (const groupItem of d.linkGroup) {
          updateLink(groupItem.id, {
            animStartTime: r2(Math.max(0, groupItem.initStart + groupDtSec)),
            animDuration: groupItem.initDur,
          });
        }
        return;
      }

      const clampedStart = d.dragType === 'move'
        ? clampMoveStartAgainstPreviewRanges(
            d.initStart + dtSec,
            d.initDur,
            [d.itemId],
            dtSec,
            d
          )
        : d.initStart;
      const update = d.dragType === 'move'
        ? { animStartTime: r2(clampedStart), animDuration: d.initDur }
        : { animDuration: clampResizeDurationAgainstPreviewRanges(d.initStart, d.initDur + dtSec, [d.itemId]) };
      updateLink(d.itemId, update);
    };
    const onUp = () => {
      blockDragRef.current = null;
      if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
      document.body.style.userSelect = '';
      // Clear after the click event (which fires right after mouseup) has been suppressed.
      if (didBlockDragRef.current) setTimeout(() => { didBlockDragRef.current = false; }, 0);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
    };
  }, [buildBoundDurationUpdates, clampMoveStartAgainstPreviewRanges, clampResizeDurationAgainstPreviewRanges, effectiveTiming, linkMap, nodeMap, setManualTokenTextKeyframes, setLinkFailureKeyframes, setNodeFailureKeyframes, setNodeTextMorphs, updateNode, updateLink]);

  useEffect(() => {
    const onMove = (e) => { if (headDragRef.current) seekFromClientX(e.clientX); };
    const onUp   = ()  => {
      if (!headDragRef.current) return;
      headDragRef.current = false;
      document.body.style.userSelect = '';
      // Commit the exact final scrub time to React state so a later re-render
      // (e.g. moving a node) doesn't snap the playhead back to a throttled value.
      commitTime();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, [seekFromClientX, commitTime]);

  useEffect(() => {
    const clampHeight = () => {
      const maxHeight = Math.floor(window.innerHeight * 0.76);
      setPanelHeight(h => Math.max(PANEL_MIN_H, Math.min(h, maxHeight)));
    };

    clampHeight();
    window.addEventListener('resize', clampHeight);
    return () => window.removeEventListener('resize', clampHeight);
  }, []);

  const syncScroll = useCallback((source, target) => {
    if (!target || syncingScrollRef.current) return;
    syncingScrollRef.current = true;
    target.scrollTop = source.scrollTop;
    requestAnimationFrame(() => { syncingScrollRef.current = false; });
  }, []);

  const handleLeftScroll = useCallback((e) => {
    syncScroll(e.currentTarget, rightBodyRef.current);
  }, [syncScroll]);

  const handleRightScroll = useCallback((e) => {
    syncScroll(e.currentTarget, leftBodyRef.current);
  }, [syncScroll]);

  const handleTimelineSelect = useCallback((e, kind, id, options = {}) => {
    e.stopPropagation();
    if (didBlockDragRef.current) return;
    const nextItem = options.manualTokenTextKeyframeId
      ? { kind: 'manual-token-text', id, keyframeId: options.manualTokenTextKeyframeId }
      : options.manualToken
      ? { kind: 'manual-token', id }
      : options.morphId
      ? { kind: 'text-morph', id, morphId: options.morphId }
      : options.pointId
        ? { kind: 'graph-point', id, pointId: options.pointId }
        : options.domainId
          ? { kind: 'graph-domain', id, domainId: options.domainId }
        : options.domainCalcId
          ? { kind: 'graph-calc', id, domainId: options.domainCalcId }
        : options.failureId
          ? { kind: kind === 'link' ? 'link-failure' : 'node-failure', id, failureId: options.failureId }
        : options.stepId
          ? { kind: 'scroll-step', id, stepId: options.stepId }
        : { kind, id };
    setSelectedItem(nextItem);
    if (e.shiftKey) {
      const anchorKind = selectedItem?.kind === 'link-failure' || selectedItem?.kind === 'manual-token'
        ? 'link'
        : selectedItem?.kind === 'text-morph'
          || selectedItem?.kind === 'graph-point'
          || selectedItem?.kind === 'node-failure'
          ? 'node'
          : selectedItem?.kind ?? kind;
      const anchorId = selectedItem?.id ?? selectedId ?? id;
      const startIndex = selectionIndexByKey[`${anchorKind}:${anchorId}`];
      const endIndex = selectionIndexByKey[`${kind}:${id}`];
      if (startIndex == null || endIndex == null) {
        setSelection(id, [id]);
        return;
      }
      const [fromIndex, toIndex] = startIndex <= endIndex
        ? [startIndex, endIndex]
        : [endIndex, startIndex];
      const rangeIds = selectionOrder.slice(fromIndex, toIndex + 1).map(item => item.id);
      setSelection(id, rangeIds);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      addToSelection(id);
      return;
    }
    setSelected(id);
  }, [addToSelection, selectedId, selectedItem, selectionIndexByKey, selectionOrder, setSelected, setSelection]);

  const startBlockDrag = useCallback((e, item, kind, dragType, options = {}) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    _pushHistory();
    freezeIndependentTimelineItems(kind, item.id);
    const { start, duration } = effectiveTiming(item, kind);
    const morphTiming = kind === 'node' && options.morphId
      ? getTextMorphById(item, options.morphId, { start, duration })
      : null;
    // Special case: dragging a node that is triggered by a link should move that controlling link (and its bound/synced siblings)
    if (kind === 'node' && dragType === 'move' && item.triggerAfterLinkId) {
      const controllingLinkId = item.triggerAfterLinkId;
      // Freeze other items so re-renders don't snap while dragging a link-derived node
      freezeIndependentTimelineItems('link', controllingLinkId);
      const controllingLink = links.find(l => l.id === controllingLinkId);
      const { start: linkStart, duration: linkDur } = effectiveTiming(controllingLink ?? { id: controllingLinkId }, 'link');
      // Ensure explicit timing exists on the controlling link/group before drag so updates are stable
      if (controllingLink) {
        const preset = {};
        if (controllingLink.animStartTime == null) preset.animStartTime = linkStart;
        if (controllingLink.animDuration == null)  preset.animDuration  = linkDur;
        if (Object.keys(preset).length) updateLinkStartGroup(controllingLink.id, preset.animStartTime ?? controllingLink.animStartTime);
        if (Object.keys(preset).length && Object.prototype.hasOwnProperty.call(preset, 'animDuration')) updateLinkDurationGroup(controllingLink.id, preset.animDuration ?? controllingLink.animDuration);
      }
      // Build link group (synced or bound siblings) like link drags do
      const syncKey = syncedJunctionKeyByLinkId[controllingLinkId];
      const boundKey = boundKeyByLinkId[controllingLinkId];
      const groupLinkIds = boundKey
        ? (boundLinkIdsByKey[boundKey] ?? [])
        : (syncKey ? (syncedLinkIdsByKey[syncKey] ?? []) : []);
      const linkGroup = groupLinkIds.length
        ? groupLinkIds.map(linkId => {
            const sibling = links.find(link => link.id === linkId);
            const siblingTiming = sibling ? effectiveTiming(sibling, 'link') : { start: 0, duration: 0.65 };
            if (sibling) {
              const siblingUpdates = {};
              if (sibling.animStartTime == null) siblingUpdates.animStartTime = siblingTiming.start;
              if (sibling.animDuration == null) siblingUpdates.animDuration = siblingTiming.duration;
              if (Object.keys(siblingUpdates).length) updateLink(sibling.id, siblingUpdates);
            }
            return { id: linkId, initStart: siblingTiming.start, initDur: siblingTiming.duration };
          })
        : null;
      blockDragRef.current = {
        dragType,
        kind: 'link',
        itemId: controllingLinkId,
        morphId: null,
        startX: e.clientX,
        initStart: linkStart,
        initDur: linkDur,
        initMorphStart: null,
        initMorphDur: null,
        linkGroup,
        multiGroup: null,
        previewCrossing: null,
      };
      return;
    }

    if (kind === 'node') {
      const nextUpdates = {};
      if ((dragType === 'move' || dragType === 'morph-move' || dragType === 'morph-resize') && item.animStartTime == null) nextUpdates.animStartTime = start;
      if (item.animDuration == null) nextUpdates.animDuration = duration;
      if (Object.keys(nextUpdates).length) updateNode(item.id, nextUpdates);
    } else {
      const nextUpdates = {};
      if (dragType === 'move' && item.animStartTime == null) nextUpdates.animStartTime = start;
      if (item.animDuration == null) nextUpdates.animDuration = duration;
      if (Object.keys(nextUpdates).length) {
        if (Object.prototype.hasOwnProperty.call(nextUpdates, 'animStartTime')) {
          updateLinkStartGroup(item.id, nextUpdates.animStartTime);
        }
        if (Object.prototype.hasOwnProperty.call(nextUpdates, 'animDuration')) {
          updateLinkDurationGroup(item.id, nextUpdates.animDuration);
        }
      }
    }
    const explicitSelectionIds = new Set(selectedIds);
    if (!explicitSelectionIds.size && selectedId) explicitSelectionIds.add(selectedId);
    const hasExplicitGroup = dragType === 'move' && explicitSelectionIds.has(item.id) && explicitSelectionIds.size > 1;

    let multiGroup = null;
    if (hasExplicitGroup) {
      multiGroup = [...explicitSelectionIds]
        .map(selectedItemId => {
          const selectedNode = nodes.find(node => node.id === selectedItemId);
          if (selectedNode) {
            const selectedTiming = effectiveTiming(selectedNode, 'node');
            if (selectedNode.animStartTime == null) {
              updateNode(selectedNode.id, { animStartTime: selectedTiming.start, animDuration: selectedTiming.duration });
            } else if (selectedNode.animDuration == null) {
              updateNode(selectedNode.id, { animDuration: selectedTiming.duration });
            }
            return { id: selectedItemId, kind: 'node', initStart: selectedTiming.start, initDur: selectedTiming.duration };
          }

          const selectedLink = links.find(link => link.id === selectedItemId);
          if (!selectedLink) return null;
          const selectedTiming = effectiveTiming(selectedLink, 'link');
          const selectedUpdates = {};
          if (selectedLink.animStartTime == null) selectedUpdates.animStartTime = selectedTiming.start;
          if (selectedLink.animDuration == null) selectedUpdates.animDuration = selectedTiming.duration;
          if (Object.keys(selectedUpdates).length) updateLink(selectedLink.id, selectedUpdates);
          return { id: selectedItemId, kind: 'link', initStart: selectedTiming.start, initDur: selectedTiming.duration };
        })
        .filter(Boolean);
    }

    const syncKey = kind === 'link' ? syncedJunctionKeyByLinkId[item.id] : null;
    const boundKey = kind === 'link' ? boundKeyByLinkId[item.id] : null;
    const groupLinkIds = hasExplicitGroup
      ? []
      : dragType === 'move'
        ? (boundKey ? boundLinkIdsByKey[boundKey] ?? [] : syncKey ? syncedLinkIdsByKey[syncKey] ?? [] : [])
        : (boundKey ? boundLinkIdsByKey[boundKey] ?? [] : []);
    const linkGroup = groupLinkIds.length
      ? groupLinkIds.map(linkId => {
          const sibling = links.find(link => link.id === linkId);
          const siblingTiming = sibling ? effectiveTiming(sibling, 'link') : { start: 0, duration: 0.65 };
          if (sibling) {
            const siblingUpdates = {};
            if (dragType === 'move' && sibling.animStartTime == null) siblingUpdates.animStartTime = siblingTiming.start;
            if (sibling.animDuration == null) siblingUpdates.animDuration = siblingTiming.duration;
            if (Object.keys(siblingUpdates).length) updateLink(sibling.id, siblingUpdates);
          }
          return { id: linkId, initStart: siblingTiming.start, initDur: siblingTiming.duration };
        })
      : null;
    blockDragRef.current = {
      dragType,
      kind,
      itemId: item.id,
      morphId: options.morphId ?? null,
      startX: e.clientX,
      initStart: start,
      initDur: duration,
      initMorphStart: morphTiming?.startTime ?? null,
      initMorphDur: morphTiming?.duration ?? null,
      linkGroup,
      multiGroup,
      previewCrossing: null,
    };
  }, [_pushHistory, boundKeyByLinkId, boundLinkIdsByKey, effectiveTiming, freezeIndependentTimelineItems, links, nodes, selectedId, selectedIds, syncedJunctionKeyByLinkId, syncedLinkIdsByKey, updateLinkStartGroup, updateLinkDurationGroup, updateNode, updateLink]);

  // Token block: moving shifts manualTokenDelay (start = anchor + delay), resizing sets
  // manualTokenDuration. Both are the same fields the properties panel edits.
  const startManualTokenDrag = useCallback((e, link, track, dragType) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    _pushHistory();
    const initDelay = Number.isFinite(link.manualTokenDelay) ? link.manualTokenDelay : 0;
    blockDragRef.current = {
      dragType,
      kind: 'manual-token',
      itemId: link.id,
      startX: e.clientX,
      initDelay,
      anchorTime: track.start - initDelay,
      initDur: track.duration,
    };
  }, [_pushHistory]);

  const startManualTokenTextKeyframeDrag = useCallback((e, link, keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    _pushHistory();
    blockDragRef.current = {
      dragType: 'manual-token-text-move',
      kind: 'manual-token-text',
      itemId: link.id,
      keyframeId: keyframe.id,
      startX: e.clientX,
      initKeyframeTime: keyframe.time,
    };
  }, [_pushHistory]);

  const handleTimelineMouseDown = useCallback((e) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    headDragRef.current = true;
    seekFromClientX(e.clientX);
  }, [seekFromClientX]);

  const handleResizeMouseDown = useCallback((e) => {
    if (collapsed) return;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';

    const startY = e.clientY;
    const startHeight = panelHeight;
    // Follow the pointer directly while resizing; the collapse animation would lag it.
    panelRef.current?.classList.add('tl-panel--resizing');

    const onMove = (moveEvent) => {
      const maxHeight = Math.floor(window.innerHeight * 0.76);
      const next = Math.max(PANEL_MIN_H, Math.min(startHeight - (moveEvent.clientY - startY), maxHeight));
      if (panelRef.current) {
        panelRef.current.style.height = `${next}px`;
        panelRef.current.style.minHeight = `${next}px`;
      }
      resizeRef.current = next;
    };

    const onUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      panelRef.current?.classList.remove('tl-panel--resizing');
      if (resizeRef.current != null) setPanelHeight(resizeRef.current);
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [collapsed, panelHeight]);

  const isCustomEnd = timelineEnd != null;
  // Extra 160 px of "breathing room" past the last block so dragging near the edge feels open.
  const timelineW   = layoutDur * PX_PER_SEC + 160;

  // Keep the row lists aligned.
  const rows = [
    ...(timelineNodes.length > 0 ? [{ type: 'section', label: 'NODES', color: NODE_HUE.solid }] : []),
    ...timelineNodes.flatMap(n => {
      const timing = effectiveTiming(n, 'node');
      const morphs = getNodeTextMorphs(n, timing);
      const web = n.type === 'variable' ? webByVariableId[n.id] : null;
      const tokenRow = web && web.tokenPath.length > 0
        ? [{ type: 'token', item: n, web }]
        : [];
      const pointRows = (n.type === 'graph' ? (n.graphPoints ?? []).map(pt => ({ type: 'gpoint', item: n, point: pt })) : []);
      const domainRows = (n.type === 'graph' ? (n.graphDomains ?? []).flatMap(dom => {
        const rows = [{ type: 'gdomain', item: n, domain: dom }];
        if (dom.calc) rows.push({ type: 'gcalc', item: n, domain: dom });
        return rows;
      }) : []);
      const failureRows = normalizeNodeFailureKeyframes(n.failureKeyframes)
        .map(failure => ({ type: 'node-failure', item: n, failure }));
      const scrollStepRows = (n.type === 'area' && n.scrollEnabled && n.scrollMode === 'stepped')
        ? normalizeScrollSteps(n.scrollSteps).map(step => ({ type: 'scroll-step', item: n, step }))
        : [];
      return [
        { type: 'node', item: n },
        ...failureRows,
        ...scrollStepRows,
        ...morphs.map(morph => ({ type: 'morph', item: n, morph })),
        ...pointRows,
        ...domainRows,
        ...tokenRow,
      ];
    }),
    ...(links.length > 0 ? [{ type: 'section', label: 'LINKS', color: LINK_HUE.solid }] : []),
    ...links.flatMap(e => [
      { type: 'link', item: e },
      ...(e.manualTokenEnabled && manualTokenTimingByLinkId[e.id]
        ? [{ type: 'manual-token', item: e, track: manualTokenTimingByLinkId[e.id] }]
        : []),
      ...normalizeNodeFailureKeyframes(e.failureKeyframes)
        .map(failure => ({ type: 'node-failure', item: e, failure, ownerKind: 'link' })),
    ]),
  ];

  const isEmpty = timelineNodes.length === 0 && links.length === 0;
  const showSelEditor = !collapsed && !!selData && !!selTiming;

  // Trigger for the selected failure: shown where the node/link Trigger normally sits.
  const failureTrigger = (selKind === 'node-failure' || selKind === 'link-failure') && selNodeFailure ? (
    <TriggerMenu
      node={selNodeFailure}
      ownerKind="failure"
      onSelect={event => {
        // The failure starts when the chosen event finishes (kept in sync by
        // useTriggeredKeyframeSync); the node/link itself doesn't move.
        _pushHistory();
        const setKeyframes = selKind === 'link-failure' ? setLinkFailureKeyframes : setNodeFailureKeyframes;
        setKeyframes(
          selData.id,
          normalizeNodeFailureKeyframes(selData.failureKeyframes).map(keyframe => {
            if (keyframe.id !== selNodeFailure.id) return keyframe;
            if (!event) {
              const { triggerEventId, ...rest } = keyframe;
              return rest;
            }
            return { ...keyframe, triggerEventId: event.id, startTime: r2(Math.max(0, event.end)) };
          })
        );
      }}
    />
  ) : null;

  const [morphMenu, setMorphMenu] = useState(null); // { nodeId, left, bottom, maxHeight, expandedId }
  const toggleMorphMenu = (nodeId, buttonEl) => {
    if (morphMenu) { setMorphMenu(null); return; }
    const rect = buttonEl.getBoundingClientRect();
    const width = 300;
    setMorphMenu({
      nodeId,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      // The timeline sits at the bottom of the window, so open upwards.
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.max(160, rect.top - 16),
      expandedId: selKind === 'text-morph' ? selectedItem?.morphId ?? null : null,
    });
  };
  const morphMenuNode = morphMenu ? nodes.find(n => n.id === morphMenu.nodeId) ?? null : null;
  // Close when the selection moves to another item or the panel collapses.
  useEffect(() => {
    if (!morphMenu) return;
    if (collapsed || !morphMenuNode || selBaseKind !== 'node' || selectedItem?.id !== morphMenu.nodeId) {
      setMorphMenu(null);
    }
  }, [collapsed, morphMenu, morphMenuNode, selBaseKind, selectedItem]);
  // Remount on selection change so the editor replays its entrance animation.
  const selEditorKey = selectedItem ? JSON.stringify(selectedItem) : 'none';
  const selChipColor = selKind === 'node-failure' || selKind === 'link-failure' ? FAILURE_HUE.bright
    : selKind === 'scroll-step' ? SCROLL_HUE.bright
    : selKind === 'text-morph' ? MORPH_HUE.bright
    : selKind === 'variable-token' || selKind === 'manual-token-text' || selKind === 'manual-token' ? TOKEN_HUE.bright
    : selBaseKind === 'node' ? NODE_HUE.bright
    : LINK_HUE.bright;

  return (
    <div ref={panelRef} className="tl-panel" style={{
      height: heightCollapsed ? 42 : panelHeight,
      minHeight: heightCollapsed ? 42 : panelHeight,
      background: 'linear-gradient(180deg, var(--panel-bg), var(--panel-bg-2))',
      borderTop: '1px solid var(--border-strong)',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      overflow: 'hidden', userSelect: 'none',
      position: 'relative',
    }}>
      {!collapsed && (
        <div
          onMouseDown={handleResizeMouseDown}
          style={{
            height: 8,
            flexShrink: 0,
            cursor: 'ns-resize',
            background: `linear-gradient(180deg, ${pageColors.timelineHeaderGlow}, ${pageColors.transparent})`,
            borderBottom: `1px solid ${pageColors.timelineHeaderBorder}`,
          }}
        />
      )}

      {morphMenu && morphMenuNode && (
        <MorphsMenu
          menu={morphMenu}
          morphs={getNodeTextMorphs(morphMenuNode, effectiveTiming(morphMenuNode, 'node'))
            .slice().sort((a, b) => a.startTime - b.startTime)}
          node={morphMenuNode}
          selectedMorphId={selKind === 'text-morph' ? selectedItem?.morphId : null}
          onClose={() => setMorphMenu(null)}
          onToggle={morphId => {
            setMorphMenu(m => m && ({ ...m, expandedId: m.expandedId === morphId ? null : morphId }));
            setSelectedItem({ kind: 'text-morph', id: morphMenuNode.id, morphId });
          }}
          onAdd={() => {
            const id = addTextMorph(morphMenuNode.id, { inlineEdit: false });
            if (id) setMorphMenu(m => m && ({ ...m, expandedId: id, focusId: id }));
          }}
          onUpdate={(morphId, patch) => updateTextMorph(morphMenuNode.id, morphId, patch)}
          onRemove={morphId => removeTextMorph(morphMenuNode.id, morphId)}
        />
      )}

      <div className={`tl-bar${collapsed ? '' : ' tl-bar--open'}`}>
        <div className="tl-title">
          <span className="tl-title__name">Timeline</span>
        </div>

        <PlayBtn active={isPlaying} disabled={blueprintMode} onClick={() => isPlaying ? pause() : play()} />
        <StopBtn onClick={stop} />

        <div className="tl-transport">
          <div className="tl-time">
            <span className="tl-time__text">
              {isPlaying && <span className="tl-time__dot" />}
              <span className={`tl-time__now${isPlaying ? ' tl-time__now--live' : ''}`}>{fmtTime(currentTime)}</span>
              <span>/</span>
              <span>{fmtTime(endTime)}</span>
            </span>
            <div className="tl-time__track">
              <div className="tl-time__fill" style={{ width: `${endTime > 0 ? Math.min(100, (currentTime / endTime) * 100) : 0}%` }} />
            </div>
          </div>
        </div>

        {!collapsed && (
          <>
            <span className="tl-label" title="Playback always runs until the end. Drag END on the ruler to move it.">End</span>
            <NumberField
              value={r2(endTime)}
              step={0.1}
              min={MIN_DUR}
              unit="s"
              onChange={v => { if (Number.isFinite(v) && v > 0) setTimelineEnd(v); }}
            />
          </>
        )}

        {/* Slide controls — before the selection editor so clicking things never shifts them */}
        {!collapsed && (
          <>
            <div className="tl-seg">
              <span className="tl-seg__label" title="Number of manual slide breaks">
                Slides <span className="tl-seg__count">{slideBreaks.length}</span>
              </span>
              <button
                className="tl-seg__btn"
                onClick={() => addSlideBreakAt(r2(currentTime))}
                title="Add slide break at playhead time. The last break ends the final slide."
              >
                + Add
              </button>
              <button
                className="tl-seg__btn"
                onClick={clearSlideBreaks}
                disabled={!slideBreaks.length}
                title="Remove all slide breaks"
              >
                Clear
              </button>
            </div>
          </>
        )}

        {showSelEditor && (
          <div className="tl-ctx" key={selEditorKey}>
            <span className="tl-chip" style={{ color: selChipColor }} title={selLabel}>
              <span className="tl-chip__dot" />
              <span className="tl-chip__text">{selLabel}</span>
            </span>

            {(selKind === 'node' || selKind === 'text-morph' || selKind === 'node-failure') && (() => {
              const isTextNode = selData?.type === 'text';
              return (
                <>
                  {selKind === 'node-failure' ? failureTrigger : (
                  <TriggerMenu
                    node={selData}
                    onSelect={event => {
                      // Link draws keep using the link trigger; any other event uses triggerEventId.
                      if (!event) doUpdate({ triggerAfterLinkId: null, triggerEventId: null });
                      else if (event.kind === 'link') doUpdate({ triggerAfterLinkId: event.ownerId, triggerEventId: null, animStartTime: null });
                      else doUpdate({ triggerEventId: event.id, triggerAfterLinkId: null, animStartTime: null });
                    }}
                  />
                  )}
                  <VSep />
                  <button
                    data-morph-menu-toggle
                    onClick={e => toggleMorphMenu(selData.id, e.currentTarget)}
                    className={`tl-btn tl-btn--accent${morphMenu ? ' tl-btn--pressed' : ''}`}
                    title="Show, edit and add text morphs"
                  >
                    Morphs <span className="tl-btn__count">{getNodeTextMorphs(selData, selTiming).length}</span> ▴
                  </button>
                </>
              );
            })()}

            {selKind === 'graph-point' && selGraphPoint && (
              <>
                <FieldLabel>Point</FieldLabel>
                <span style={{ color: pageColors.purpleAccent, fontSize: 11, minWidth: 80 }}>
                  ({(selGraphPoint.x ?? 0).toFixed(2)}, {(selGraphPoint.y ?? 0).toFixed(2)})
                </span>
                <VSep />
                <FieldLabel>Duration</FieldLabel>
                <NumberField value={Number.isFinite(selGraphPoint.duration) ? selGraphPoint.duration : 0.35} step={0.05} min={0.05} onChange={v => {
                  const gp = (selData.graphPoints ?? []).map(p => p.id === selGraphPoint.id ? { ...p, duration: r2(Math.max(0.05, v)) } : p);
                  _pushHistory();
                  updateNode(selData.id, { graphPoints: gp });
                }} unit="s" />
              </>
            )}

            {selKind === 'scroll-step' && selScrollStep && (
              <>
                <FieldLabel>Scroll step</FieldLabel>
                <span style={{ color: SCROLL_HUE.bright, fontSize: 11, fontWeight: 700 }}>one tile</span>
                <VSep />
                <FieldLabel>At</FieldLabel>
                <NumberField
                  value={selScrollStep.time}
                  step={0.05}
                  min={0}
                  onChange={value => updateScrollStep(selData.id, selScrollStep.id, { time: r2(Math.max(0, value)) })} unit="s" />
                <FieldLabel>Shift</FieldLabel>
                <NumberField
                  value={selScrollStep.duration}
                  step={0.05}
                  min={MIN_DUR}
                  onChange={value => updateScrollStep(selData.id, selScrollStep.id, { duration: r2(Math.max(MIN_DUR, value)) })} unit="s" />
                <button
                  onClick={() => removeScrollStep(selData.id, selScrollStep.id)}
                  className="tl-btn tl-btn--accent"
                >
                  Remove
                </button>
              </>
            )}

            {selBaseKind === 'link' && selKind !== 'manual-token-text' && selData && (
              <>
                {selKind === 'link-failure' ? failureTrigger : selKind === 'manual-token' ? (
                  // A token's trigger is its own: once set, the token no longer follows its link's draw.
                  <TriggerMenu
                    node={{ triggerEventId: selData.manualTokenTriggerEventId ?? null }}
                    ownerKind="token"
                    onSelect={event => {
                      if (event && isOwnTokenEvent(selData.id, event.id)) return;
                      doUpdate({ manualTokenTriggerEventId: event ? event.id : null });
                    }}
                  />
                ) : (
                  <TriggerMenu
                    node={selData}
                    ownerKind="link"
                    onSelect={event => doUpdate(event
                      ? { triggerEventId: event.id, animStartTime: null }
                      : { triggerEventId: null })}
                  />
                )}
                <VSep />
              </>
            )}

            {selBaseKind === 'link' && selKind !== 'manual-token-text' && selectedBoundKey && (
              <>
                <FieldLabel>Bound</FieldLabel>
                <span style={{ color: pageColors.blueLink, fontSize: 11, fontWeight: 600, minWidth: 30 }}>
                  ×{selectedBoundLinkIds.length}
                </span>
              </>
            )}

            {(selKind === 'link' || selKind === 'manual-token') && selData?.manualTokenEnabled && (
              <>
                <FieldLabel>Text keys</FieldLabel>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, minWidth: 22 }}>
                  {normalizeManualTokenTextKeyframes(selData.manualTokenTextKeyframes).length}
                </span>
                <button
                  onClick={() => addManualTokenTextKeyframe(selData.id)}
                  className="tl-btn tl-btn--accent"
                >
                  Add text key
                </button>
                <VSep />
              </>
            )}

            {selKind === 'manual-token-text' && selManualTokenTextKeyframe && (
              <>
                <FieldLabel>Text</FieldLabel>
                <InlineTextField
                  value={selManualTokenTextKeyframe.text}
                  onChange={value => updateManualTokenTextKeyframe(
                    selData.id,
                    selManualTokenTextKeyframe.id,
                    { text: value }
                  )}
                  width={150}
                />
                <FieldLabel>Time</FieldLabel>
                <NumberField
                  value={selManualTokenTextKeyframe.time}
                  step={0.05}
                  min={0}
                  onChange={value => updateManualTokenTextKeyframe(
                    selData.id,
                    selManualTokenTextKeyframe.id,
                    { time: r2(Math.max(0, value)) }
                  )} unit="s" />
                <button
                  onClick={() => removeManualTokenTextKeyframe(selData.id, selManualTokenTextKeyframe.id)}
                  className="tl-btn tl-btn--danger"
                >
                  Remove
                </button>
              </>
            )}

            {(selKind === 'node' || selKind === 'text-morph' || selKind === 'node-failure' || selKind === 'link' || selKind === 'link-failure' || selKind === 'manual-token') && (
              <>
                <FieldLabel>Duration</FieldLabel>
                <NumberField value={selTiming.duration} step={0.05} min={MIN_DUR} onChange={v => doUpdate({ animDuration: r2(Math.max(MIN_DUR, v)) })} unit="s" />
              </>
            )}

            {(selKind === 'node-failure' || selKind === 'link-failure') && selNodeFailure && (
              <>
                <VSep />
                <span className="tl-value" style={{ color: FAILURE_HUE.bright }}>Failure</span>
              </>
            )}

            {selKind === 'variable-token' && selData && selWeb && !selectedItem?.hopLinkId && (
              <>
                <FieldLabel>Default hop</FieldLabel>
                <NumberField
                  value={selWeb.hopDuration}
                  step={0.05}
                  min={0.05}
                  onChange={v => updateNode(selData.id, { tokenHopDuration: r2(Math.max(0.05, v)) })} unit="s" />
                <FieldLabel>Start +</FieldLabel>
                <NumberField
                  value={selWeb.startOffset}
                  step={0.05}
                  min={0}
                  onChange={v => updateNode(selData.id, { tokenStartOffset: r2(Math.max(0, v)) })} unit="s" />
                <FieldLabel>Hops</FieldLabel>
                <span style={{ color: TOKEN_HUE.bright, fontSize: 11, fontWeight: 600, minWidth: 20 }}>
                  {selWeb.tokenPath.length}
                </span>
                <VSep />
                <FieldLabel>Total</FieldLabel>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, minWidth: 50 }}>
                  {(selWeb.chainEnd - selWeb.chainOrigin).toFixed(2)}s
                </span>
              </>
            )}

            {selKind === 'variable-token' && selData && selWeb && selectedItem?.hopLinkId && (() => {
              const hopLinkId = selectedItem.hopLinkId;
              const hopIndex = selWeb.tokenPath.indexOf(hopLinkId);
              const timing = selWeb.tokenTiming[hopLinkId];
              const link = links.find(l => l.id === hopLinkId);
              const fromNode = link ? nodes.find(n => n.id === link.fromId) : null;
              const toNode = link ? nodes.find(n => n.id === link.toId) : null;
              if (!timing || hopIndex < 0) return null;
              return (
                <>
                  <FieldLabel>Hop {hopIndex + 1}</FieldLabel>
                  <span style={{ color: TOKEN_HUE.bright, fontSize: 11, fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {trunc(fromNode?.label, 12)} → {trunc(toNode?.label, 12)}
                  </span>
                  <VSep />
                  {!timing.skipped && (
                    <>
                      <FieldLabel>Duration</FieldLabel>
                      <NumberField
                        value={timing.duration}
                        step={0.05}
                        min={0.05}
                        onChange={v => {
                          const link = links.find(l => l.id === hopLinkId);
                          if (!link) return;
                          const cur = { ...(link.tokenHopOverrides ?? {}) };
                          const base = { ...(cur[selData.id] ?? {}) };
                          base.duration = r2(Math.max(0.05, v));
                          cur[selData.id] = base;
                          updateLink(hopLinkId, { tokenHopOverrides: cur });
                        }} unit="s" />
                      <FieldLabel>Delay</FieldLabel>
                      <NumberField
                        value={timing.delay ?? 0}
                        step={0.05}
                        min={-10}
                        onChange={v => {
                          const link = links.find(l => l.id === hopLinkId);
                          if (!link) return;
                          const cur = { ...(link.tokenHopOverrides ?? {}) };
                          const base = { ...(cur[selData.id] ?? {}) };
                          base.delay = r2(v);
                          cur[selData.id] = base;
                          updateLink(hopLinkId, { tokenHopOverrides: cur });
                        }} unit="s" />
                      {timing.hasOverride && (
                        <button
                          onClick={() => {
                            const link = links.find(l => l.id === hopLinkId);
                            if (!link) return;
                            const cur = { ...(link.tokenHopOverrides ?? {}) };
                            const base = { ...(cur[selData.id] ?? {}) };
                            delete base.duration;
                            if (Object.keys(base).length) cur[selData.id] = base; else delete cur[selData.id];
                            updateLink(hopLinkId, { tokenHopOverrides: cur });
                          }}
                          className="tl-btn tl-btn--muted"
                        >
                          Reset duration
                        </button>
                      )}
                      {timing.hasDelay && (
                        <button
                          onClick={() => {
                            const link = links.find(l => l.id === hopLinkId);
                            if (!link) return;
                            const cur = { ...(link.tokenHopOverrides ?? {}) };
                            const base = { ...(cur[selData.id] ?? {}) };
                            delete base.delay;
                            if (Object.keys(base).length) cur[selData.id] = base; else delete cur[selData.id];
                            updateLink(hopLinkId, { tokenHopOverrides: cur });
                          }}
                          className="tl-btn tl-btn--muted"
                        >
                          Reset delay
                        </button>
                      )}
                    </>
                  )}
                  {timing.skipped && (
                    <span style={{ color: 'var(--text-dim)', fontSize: 11, fontStyle: 'italic' }}>
                      Removed — token skips this link
                    </span>
                  )}
                  <button
                    onClick={() => {
                      const link = links.find(l => l.id === hopLinkId);
                      if (!link) return;
                      const cur = { ...(link.tokenHopOverrides ?? {}) };
                      const base = { ...(cur[selData.id] ?? {}) };
                      base.skip = !timing.skipped;
                      cur[selData.id] = base;
                      updateLink(hopLinkId, { tokenHopOverrides: cur });
                    }}
                    className={timing.skipped ? 'tl-btn' : 'tl-btn tl-btn--danger'}
                  >
                    {timing.skipped ? 'Restore hop' : 'Remove hop'}
                  </button>
                </>
              );
            })()}
          </div>
        )}

        {!showSelEditor && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
            {!collapsed && isEmpty && (
              <span className="tl-hint">Add a node to the canvas to start the timeline.</span>
            )}
          </div>
        )}

        <button
          className={`tl-collapse${heightCollapsed ? ' tl-collapse--closed' : ''}`}
          onClick={() => setCollapsed(c => !c)}
          title={heightCollapsed ? 'Expand timeline' : 'Collapse timeline'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div ref={bodyAreaRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <div style={{ width: LEFT_W, flexShrink: 0, borderRight: '1px solid var(--border-strong)', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ height: RULER_H, background: 'var(--panel-bg)', borderBottom: '1px solid var(--border-strong)', flexShrink: 0 }} />
            <div
              ref={leftBodyRef}
              onScroll={handleLeftScroll}
              style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
            >
              {rows.map((row, i) => {
                if (row.type === 'section') {
                  return <SectionRow key={`sec-${i}`} label={row.label} color={row.color} />;
                }
                if (row.type === 'node-failure') {
                  const { item: node, failure } = row;
                  const ownerKind = row.ownerKind ?? 'node';
                  const failKind = ownerKind === 'link' ? 'link-failure' : 'node-failure';
                  const failures = normalizeNodeFailureKeyframes(node.failureKeyframes);
                  const failureIndex = failures.findIndex(keyframe => keyframe.id === failure.id);
                  const isFailureSel = selectedItem?.kind === failKind
                    && selectedItem?.id === node.id
                    && selectedItem?.failureId === failure.id;
                  return (
                    <div
                      key={`failure-left-${node.id}-${failure.id}`}
                      onClick={(e) => handleTimelineSelect(e, ownerKind, node.id, { failureId: failure.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isFailureSel ? FAILURE_HUE.bright : pageColors.transparent}`,
                        background: isFailureSel ? withAlpha(FAILURE_HUE.solid, 0.08) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ color: FAILURE_HUE.bright, fontSize: 12, fontWeight: 800, lineHeight: 1 }}>×</span>
                      <span style={{ color: isFailureSel ? FAILURE_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        failure {failureIndex + 1}
                      </span>
                      <span style={{ color: FAILURE_HUE.bright, opacity: 0.65, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>FAIL</span>
                    </div>
                  );
                }
                if (row.type === 'scroll-step') {
                  const { item: node, step } = row;
                  const steps = normalizeScrollSteps(node.scrollSteps);
                  const stepIndex = steps.findIndex(s => s.id === step.id);
                  const isStepSel = selectedItem?.kind === 'scroll-step'
                    && selectedItem?.id === node.id
                    && selectedItem?.stepId === step.id;
                  return (
                    <div
                      key={`scroll-step-left-${node.id}-${step.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'node', node.id, { stepId: step.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isStepSel ? SCROLL_HUE.bright : pageColors.transparent}`,
                        background: isStepSel ? withAlpha(SCROLL_HUE.solid, 0.08) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ color: SCROLL_HUE.bright, fontSize: 12, fontWeight: 800, lineHeight: 1 }}>⇥</span>
                      <span style={{ color: isStepSel ? SCROLL_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        step {stepIndex + 1}
                      </span>
                      <span style={{ color: SCROLL_HUE.bright, opacity: 0.65, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>STEP</span>
                    </div>
                  );
                }
                if (row.type === 'manual-token') {
                  const { item: tokenLink, track } = row;
                  const isTokenSel = selectedItem?.kind === 'manual-token' && selectedItem?.id === tokenLink.id;
                  const startText = (track.baseText ?? '').trim();
                  return (
                    <div
                      key={`manual-token-left-${tokenLink.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'link', tokenLink.id, { manualToken: true })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isTokenSel ? TOKEN_HUE.bright : pageColors.transparent}`,
                        background: isTokenSel ? withAlpha(TOKEN_HUE.solid, 0.08) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: TOKEN_HUE.solid, opacity: 0.8 }} />
                      <span style={{ color: isTokenSel ? TOKEN_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: startText ? 'normal' : 'italic' }}>
                        {startText || 'token'}
                      </span>
                      <span style={{ color: TOKEN_HUE.bright, opacity: 0.65, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>TOKEN</span>
                    </div>
                  );
                }
                if (row.type === 'morph') {
                  const { item: morphNode, morph } = row;
                  const isMorphSel = selectedItem?.kind === 'text-morph' && selectedItem?.id === morphNode.id && selectedItem?.morphId === morph.id;
                  return (
                    <div
                      key={`morph-${morphNode.id}-${morph.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'node', morphNode.id, { morphId: morph.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isMorphSel ? MORPH_HUE.solid : pageColors.transparent}`,
                        background: isMorphSel ? withAlpha(MORPH_HUE.solid, 0.06) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: MORPH_HUE.solid, opacity: 0.55 }} />
                      <span style={{ color: isMorphSel ? MORPH_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {morph.text || '(blank)'}
                      </span>
                      <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>MORPH</span>
                    </div>
                  );
                }
                if (row.type === 'gpoint') {
                  const { item: gpNode, point } = row;
                  const isSel = selectedItem?.kind === 'graph-point' && selectedItem?.id === gpNode.id && selectedItem?.pointId === point.id;
                  return (
                    <div
                      key={`gp-left-${gpNode.id}-${point.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'node', gpNode.id, { pointId: point.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isSel ? NODE_HUE.solid : pageColors.transparent}`,
                        background: isSel ? withAlpha(NODE_HUE.solid, 0.06) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: NODE_HUE.solid, opacity: 0.7 }} />
                      <span style={{ color: isSel ? NODE_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        point ({(point.x ?? 0).toFixed(2)}, {(point.y ?? 0).toFixed(2)})
                      </span>
                      <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>POINT</span>
                    </div>
                  );
                }
                if (row.type === 'gpoint') {
                  const { item: gpNode, point } = row;
                  const isSel = selectedItem?.kind === 'graph-point' && selectedItem?.id === gpNode.id && selectedItem?.pointId === point.id;
                  return (
                    <div
                      key={`gp-left-${gpNode.id}-${point.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'node', gpNode.id, { pointId: point.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isSel ? NODE_HUE.solid : pageColors.transparent}`,
                        background: isSel ? withAlpha(NODE_HUE.solid, 0.06) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: NODE_HUE.solid, opacity: 0.7 }} />
                      <span style={{ color: isSel ? NODE_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        point ({(point.x ?? 0).toFixed(2)}, {(point.y ?? 0).toFixed(2)})
                      </span>
                      <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>POINT</span>
                    </div>
                  );
                }
                if (row.type === 'gdomain' || row.type === 'gcalc') {
                  const { item: gdNode, domain } = row;
                  const isCalc = row.type === 'gcalc';
                  const selKindWant = isCalc ? 'graph-calc' : 'graph-domain';
                  const isSel = selectedItem?.kind === selKindWant
                    && selectedItem?.id === gdNode.id && selectedItem?.domainId === domain.id;
                  return (
                    <div
                      key={`${row.type}-left-${gdNode.id}-${domain.id}`}
                      onClick={(e) => handleTimelineSelect(e, 'node', gdNode.id, isCalc ? { domainCalcId: domain.id } : { domainId: domain.id })}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isSel ? NODE_HUE.solid : pageColors.transparent}`,
                        background: isSel ? withAlpha(NODE_HUE.solid, 0.06) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 5, height: 5, borderRadius: isCalc ? 1 : '50%', flexShrink: 0, background: domain.color ?? NODE_HUE.solid, opacity: 0.85 }} />
                      <span style={{ color: isSel ? NODE_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {isCalc
                          ? `calculate · ${Math.round(domain.calc?.count ?? 0)} dots`
                          : `domain: ${domain.label || '(unnamed)'}`}
                      </span>
                      <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>{isCalc ? 'CALC' : 'DOMAIN'}</span>
                    </div>
                  );
                }
                if (row.type === 'token') {
                  const { item: varNode, web } = row;
                  const isTokenSel = selectedItem?.kind === 'variable-token' && selectedItem?.id === varNode.id;
                  return (
                    <div
                      key={`token-${varNode.id}`}
                      onClick={(e) => { e.stopPropagation(); setSelectedItem({ kind: 'variable-token', id: varNode.id }); }}
                      style={{
                        height: ROW_H, display: 'flex', alignItems: 'center',
                        padding: '0 10px 0 22px', gap: 7, cursor: 'pointer',
                        borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                        borderLeft: `2px solid ${isTokenSel ? TOKEN_HUE.solid : pageColors.transparent}`,
                        background: isTokenSel ? withAlpha(TOKEN_HUE.solid, 0.06) : pageColors.transparent,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: TOKEN_HUE.solid, opacity: 0.75 }} />
                      <span style={{ color: isTokenSel ? TOKEN_HUE.bright : pageColors.timelineTextMuted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        token · {web.tokenPath.length} hop{web.tokenPath.length === 1 ? '' : 's'}
                      </span>
                      <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em', flexShrink: 0 }}>TOKEN</span>
                    </div>
                  );
                }
                const { item, type: kind } = row;
                const { isAuto } = effectiveTiming(item, kind);
                const hue   = kind === 'node' ? NODE_HUE : LINK_HUE;
                const isSel = selectedItem?.id === item.id && (
                  selectedItem?.kind === kind ||
                  (kind === 'node' && selectedItem?.kind === 'text-morph') ||
                  (kind === 'node' && selectedItem?.kind === 'node-failure') ||
                  (kind === 'link' && selectedItem?.kind === 'link-failure') ||
                  (kind === 'link' && selectedItem?.kind === 'manual-token') ||
                  (kind === 'node' && selectedItem?.kind === 'scroll-step') ||
                  (kind === 'link' && selectedItem?.kind === 'manual-token-text')
                );
                const isInSelection = selectedIds.includes(item.id);
                const label = kind === 'node' ? trunc(item.label) : linkLabel(item, nodes);
                const isTriggered = (kind === 'node' && !!item.triggerAfterLinkId) || !!item.triggerEventId;
                const isBlueprint = isBlueprintItem(item, kind);
                const boundKey = kind === 'link' ? boundKeyByLinkId[item.id] : null;
                const isBound = !!boundKey;
                const boundCount = isBound ? (boundLinkIdsByKey[boundKey]?.length ?? 1) : 0;
                return (
                  <div
                    key={`${kind}-${item.id}`}
                    data-row-id={`${kind}-${item.id}`}
                    onClick={(e) => handleTimelineSelect(e, kind, item.id)}
                    style={{
                      height: ROW_H, display: 'flex', alignItems: 'center',
                      padding: '0 10px', gap: 7, cursor: 'pointer',
                      borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                      borderLeft: `2px solid ${isSel ? hue.solid : isInSelection ? withAlpha(hue.solid, 0.7) : pageColors.transparent}`,
                      background: isSel ? withAlpha(hue.solid, 0.06) : isInSelection ? withAlpha(hue.solid, 0.035) : pageColors.transparent,
                      flexShrink: 0,
                    }}
                  >
                    {isTriggered
                      ? <span style={{ fontSize: 11, flexShrink: 0, opacity: 0.8 }} title="Triggered by an event">⛓</span>
                      : <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: isAuto ? pageColors.rulerMinorTick : hue.solid }} />
                    }
                    <span style={{ color: isSel ? hue.bright : pageColors.timelineTextMuted, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                      {label}
                    </span>
                    {isBound && (
                      <span style={{
                        color: pageColors.blueLink,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        padding: '2px 5px',
                        borderRadius: 999,
                        background: withAlpha(pageColors.blueLink, 0.12),
                        border: `1px solid ${withAlpha(pageColors.blueLink, 0.28)}`,
                        flexShrink: 0,
                      }}>
                        SYNC ×{boundCount}
                      </span>
                    )}
                    {isBlueprint && (
                      <span
                        title="Blueprint: always visible, not on the timeline. Trigger it from an event, or drag its bar, to animate it."
                        style={{ color: pageColors.blueBright, fontSize: 9, letterSpacing: '0.05em' }}
                      >
                        BLUEPRINT
                      </span>
                    )}
                    {isAuto && !isTriggered && !isBlueprint && <span style={{ color: pageColors.rulerMinorTick, fontSize: 9, letterSpacing: '0.05em' }}>AUTO</span>}
                    {isTriggered && <span style={{ color: pageColors.blueLink, fontSize: 9, letterSpacing: '0.05em' }}>TRIGGER</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <div
            ref={timelineRef}
            onMouseDown={handleTimelineMouseDown}
            style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', position: 'relative', cursor: 'crosshair', minWidth: 0 }}
          >
            <div style={{ minWidth: timelineW, width: '100%', display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
              <Ruler
                total={layoutDur}
                endTime={endTime}
                isCustomEnd={isCustomEnd}
                slideBreaks={slideBreaks}
                onRemoveBreak={t => removeSlideBreakAtTime(t)}
                onMoveBreak={(from, to) => moveSlideBreak(from, to)}
                onMoveEnd={t => setTimelineEnd(t)}
                onResetEnd={() => setTimelineEnd(null)}
              />

              {/* Past-the-end overlay — everything after the END marker */}
              <div style={{
                position: 'absolute',
                top: RULER_H,
                left: endTime * PX_PER_SEC,
                right: 0,
                bottom: 0,
                background: withAlpha(pageColors.purpleAccent, 0.028),
                borderLeft: `1px solid ${withAlpha(pageColors.purpleAccent, 0.18)}`,
                pointerEvents: 'none',
                zIndex: 0,
              }} />

              <div
                ref={rightBodyRef}
                onScroll={handleRightScroll}
                style={{ flex: 1, overflowY: 'auto', minHeight: 0, position: 'relative', zIndex: 1 }}
              >
                {rows.map((row, i) => {
                  if (row.type === 'section') {
                    return (
                      <div key={`sec-${i}`} style={{ height: SEC_H, background: pageColors.timelineSectionBackground, borderBottom: `1px solid ${withAlpha(row.color, 0.13)}`, flexShrink: 0 }} />
                    );
                  }

                  if (row.type === 'node-failure') {
                    const { item: node, failure } = row;
                    const ownerKind = row.ownerKind ?? 'node';
                    const failKind = ownerKind === 'link' ? 'link-failure' : 'node-failure';
                    const isFailureSel = selectedItem?.kind === failKind
                      && selectedItem?.id === node.id
                      && selectedItem?.failureId === failure.id;
                    const left = failure.startTime * PX_PER_SEC;
                    const width = Math.max(failure.duration * PX_PER_SEC, HANDLE_W + 6);
                    const beginDrag = (e, dragType) => {
                      e.preventDefault();
                      e.stopPropagation();
                      document.body.style.userSelect = 'none';
                      _pushHistory();
                      blockDragRef.current = {
                        dragType,
                        kind: failKind,
                        itemId: node.id,
                        failureId: failure.id,
                        startX: e.clientX,
                        initStart: failure.startTime,
                        initDur: failure.duration,
                      };
                    };
                    return (
                      <div
                        key={`failure-${node.id}-${failure.id}`}
                        onClick={(e) => handleTimelineSelect(e, ownerKind, node.id, { failureId: failure.id })}
                        style={{
                          height: ROW_H,
                          borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                          position: 'relative',
                          flexShrink: 0,
                          background: isFailureSel ? withAlpha(FAILURE_HUE.solid, 0.055) : pageColors.transparent,
                          cursor: 'crosshair',
                        }}
                      >
                        <div
                          title={`${ownerKind === 'link' ? 'Link' : 'Node'} failure · Start ${failure.startTime.toFixed(2)}s · Duration ${failure.duration.toFixed(2)}s`}
                          onMouseDown={e => {
                            if (failure.triggerEventId) { e.stopPropagation(); return; }
                            beginDrag(e, 'node-failure-move');
                          }}
                          style={{
                            position: 'absolute', top: BLOCK_PAD, left, width, height: ROW_H - BLOCK_PAD * 2,
                            borderRadius: 5, cursor: 'grab', display: 'flex', alignItems: 'center', overflow: 'hidden',
                            background: isFailureSel ? withAlpha(FAILURE_HUE.solid, 0.5) : withAlpha(FAILURE_HUE.solid, 0.26),
                            border: `1px solid ${isFailureSel ? FAILURE_HUE.bright : withAlpha(FAILURE_HUE.bright, 0.58)}`,
                            boxShadow: isFailureSel ? `0 0 0 2px ${withAlpha(FAILURE_HUE.solid, 0.16)}` : 'none',
                          }}
                        >
                          <span style={{ color: FAILURE_HUE.bright, fontSize: 12, fontWeight: 800, paddingLeft: 6, pointerEvents: 'none' }}>{failure.triggerEventId ? '⛓' : '×'}</span>
                          {width > 48 && (
                            <span style={{ color: FAILURE_HUE.bright, fontSize: 10, paddingLeft: 5, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {failure.duration.toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => beginDrag(e, 'node-failure-resize')}
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W, cursor: 'ew-resize',
                              background: isFailureSel ? withAlpha(FAILURE_HUE.bright, 0.18) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {isFailureSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: FAILURE_HUE.bright }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (row.type === 'scroll-step') {
                    const { item: node, step } = row;
                    const steps = normalizeScrollSteps(node.scrollSteps);
                    const stepIndex = steps.findIndex(s => s.id === step.id);
                    const isStepSel = selectedItem?.kind === 'scroll-step'
                      && selectedItem?.id === node.id
                      && selectedItem?.stepId === step.id;
                    const left = step.time * PX_PER_SEC;
                    const width = Math.max(step.duration * PX_PER_SEC, HANDLE_W + 6);
                    const beginDrag = (e, dragType) => {
                      e.preventDefault();
                      e.stopPropagation();
                      document.body.style.userSelect = 'none';
                      _pushHistory();
                      blockDragRef.current = {
                        dragType,
                        kind: 'scroll-step',
                        itemId: node.id,
                        stepId: step.id,
                        startX: e.clientX,
                        initStart: step.time,
                        initDur: step.duration,
                      };
                    };
                    return (
                      <div
                        key={`scroll-step-${node.id}-${step.id}`}
                        onClick={(e) => handleTimelineSelect(e, 'node', node.id, { stepId: step.id })}
                        style={{
                          height: ROW_H,
                          borderBottom: `1px solid ${pageColors.timelineRowDivider}`,
                          position: 'relative',
                          flexShrink: 0,
                          background: isStepSel ? withAlpha(SCROLL_HUE.solid, 0.055) : pageColors.transparent,
                          cursor: 'crosshair',
                        }}
                      >
                        <div
                          title={`Scroll step ${stepIndex + 1} · At ${step.time.toFixed(2)}s · Shift ${step.duration.toFixed(2)}s`}
                          onMouseDown={e => beginDrag(e, 'scroll-step-move')}
                          style={{
                            position: 'absolute', top: BLOCK_PAD, left, width, height: ROW_H - BLOCK_PAD * 2,
                            borderRadius: 5, cursor: 'grab', display: 'flex', alignItems: 'center', overflow: 'hidden',
                            background: isStepSel ? withAlpha(SCROLL_HUE.solid, 0.5) : withAlpha(SCROLL_HUE.solid, 0.26),
                            border: `1px solid ${isStepSel ? SCROLL_HUE.bright : withAlpha(SCROLL_HUE.bright, 0.58)}`,
                            boxShadow: isStepSel ? `0 0 0 2px ${withAlpha(SCROLL_HUE.solid, 0.16)}` : 'none',
                          }}
                        >
                          <span style={{ color: SCROLL_HUE.bright, fontSize: 12, fontWeight: 800, paddingLeft: 6, pointerEvents: 'none' }}>⇥</span>
                          {width > 48 && (
                            <span style={{ color: SCROLL_HUE.bright, fontSize: 10, paddingLeft: 5, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {step.duration.toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => beginDrag(e, 'scroll-step-resize')}
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W, cursor: 'ew-resize',
                              background: isStepSel ? withAlpha(SCROLL_HUE.bright, 0.18) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {isStepSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: SCROLL_HUE.bright }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (row.type === 'token') {
                    const { item: varNode, web } = row;
                    const isTokenRowSel = selectedItem?.kind === 'variable-token' && selectedItem?.id === varNode.id;
                    const hopCount = web.tokenPath.length;

                    const DRAG_THRESHOLD_PX = 3;
                    const startHopMove = (e, linkId, baseDelay, varId) => {
                      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                      e.preventDefault();
                      e.stopPropagation();
                      document.body.style.userSelect = 'none';
                      const startX = e.clientX;
                      const onMove = (me) => {
                        const deltaPx = me.clientX - startX;
                        if (Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
                        didBlockDragRef.current = true;
                        const dx = deltaPx / PX_PER_SEC;
                        const next = r2(baseDelay + dx);
                        const link = links.find(l => l.id === linkId);
                        if (!link) return;
                        const cur = { ...(link.tokenHopOverrides ?? {}) };
                        const base = { ...(cur[varId] ?? {}) };
                        base.delay = next;
                        cur[varId] = base;
                        updateLink(linkId, { tokenHopOverrides: cur });
                      };
                      const onUp = () => {
                        document.body.style.userSelect = '';
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                      };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    };

                    const startHopResize = (e, linkId, baseDur, varId) => {
                      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                      e.preventDefault();
                      e.stopPropagation();
                      document.body.style.userSelect = 'none';
                      const startX = e.clientX;
                      const onMove = (me) => {
                        const deltaPx = me.clientX - startX;
                        if (Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
                        didBlockDragRef.current = true;
                        const dx = deltaPx / PX_PER_SEC;
                        const next = Math.max(0.05, r2(baseDur + dx));
                        const link = links.find(l => l.id === linkId);
                        if (!link) return;
                        const cur = { ...(link.tokenHopOverrides ?? {}) };
                        const base = { ...(cur[varId] ?? {}) };
                        base.duration = next;
                        cur[varId] = base;
                        updateLink(linkId, { tokenHopOverrides: cur });
                      };
                      const onUp = () => {
                        document.body.style.userSelect = '';
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                      };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    };

                    return (
                      <div
                        key={`token-${varNode.id}`}
                        onClick={() => { if (!didBlockDragRef.current) setSelectedItem({ kind: 'variable-token', id: varNode.id }); }}
                        style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isTokenRowSel ? withAlpha(TOKEN_HUE.solid, 0.04) : pageColors.transparent, cursor: 'crosshair' }}
                      >
                        {web.tokenPath.map((linkId, hopIndex) => {
                          const timing = web.tokenTiming[linkId];
                          if (!timing) return null;
                          const left = timing.start * PX_PER_SEC;
                          const width = timing.skipped
                            ? 14
                            : Math.max(timing.duration * PX_PER_SEC, HANDLE_W + 4);
                          const isHopSel = selectedItem?.kind === 'variable-token'
                            && selectedItem?.id === varNode.id
                            && selectedItem?.hopLinkId === linkId;
                          const link = links.find(l => l.id === linkId);
                          const fromNode = link ? nodes.find(n => n.id === link.fromId) : null;
                          const toNode = link ? nodes.find(n => n.id === link.toId) : null;
                          const delayWidth = (timing.delay ?? 0) * PX_PER_SEC;
                          const delayLeft = (timing.naturalStart ?? timing.start) * PX_PER_SEC;
                          return (
                            <React.Fragment key={`hop-frag-${linkId}`}>
                              {timing.hasDelay && delayWidth > 1 && (
                                <div
                                  title={`Hop ${hopIndex + 1} delay · +${timing.delay.toFixed(2)}s`}
                                  style={{
                                    position: 'absolute', top: ROW_H / 2 - 1,
                                    left: delayLeft, width: delayWidth, height: 2,
                                    background: `repeating-linear-gradient(90deg, ${withAlpha(TOKEN_HUE.solid, 0.55)} 0 4px, transparent 4px 8px)`,
                                    pointerEvents: 'none',
                                  }}
                                />
                              )}
                            <div
                              key={`hop-${linkId}`}
                              title={timing.skipped
                                ? `Hop ${hopIndex + 1} · ${fromNode?.label ?? '?'} → ${toNode?.label ?? '?'} · (removed, double-click to restore)`
                                : `Hop ${hopIndex + 1} · ${fromNode?.label ?? '?'} → ${toNode?.label ?? '?'} · ${timing.duration.toFixed(2)}s${timing.hasOverride ? ' (override)' : ' (default)'}${timing.hasDelay ? ` · +${timing.delay.toFixed(2)}s delay` : ''} · double-click to remove`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                if (didBlockDragRef.current) return;
                                setSelectedItem({ kind: 'variable-token', id: varNode.id, hopLinkId: linkId });
                              }}
                              onDoubleClick={(ev) => {
                                // Fast toggle remove/restore on double-click without extra UI
                                ev.stopPropagation();
                                const link = links.find(l => l.id === linkId);
                                if (!link) return;
                                const cur = { ...(link.tokenHopOverrides ?? {}) };
                                const base = { ...(cur[varNode.id] ?? {}) };
                                base.skip = !timing.skipped;
                                cur[varNode.id] = base;
                                updateLink(linkId, { tokenHopOverrides: cur });
                              }}
                              onMouseDown={(ev) => {
                                // Prevent outer timeline from scrubbing on hop interactions
                                ev.stopPropagation();
                                if (ev.detail >= 2) return; // don't start drag on double-click
                                if (ev.target.dataset?.role === 'hop-resize') return; // child handler will manage resize
                                if (timing.skipped) return; // allow click select without drag
                                startHopMove(ev, linkId, timing.delay ?? 0, varNode.id);
                              }}
                              style={{
                                position: 'absolute', top: BLOCK_PAD, left, width, height: ROW_H - BLOCK_PAD * 2,
                                borderRadius: 4, cursor: timing.skipped ? 'pointer' : 'grab',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                                background: timing.skipped
                                  ? withAlpha(TOKEN_HUE.solid, 0.06)
                                  : isHopSel
                                    ? withAlpha(TOKEN_HUE.solid, 0.42)
                                    : isTokenRowSel
                                      ? withAlpha(TOKEN_HUE.solid, 0.26)
                                      : withAlpha(TOKEN_HUE.solid, 0.18),
                                border: timing.skipped
                                  ? `1px dashed ${withAlpha(TOKEN_HUE.solid, 0.5)}`
                                  : `1px solid ${isHopSel ? TOKEN_HUE.solid : withAlpha(TOKEN_HUE.solid, 0.55)}`,
                                boxShadow: !timing.skipped && timing.hasOverride ? `inset 0 0 0 1px ${withAlpha(pageColors.warningBright, 0.55)}` : 'none',
                                opacity: timing.skipped ? 0.65 : 1,
                              }}
                            >
                              {timing.skipped && (
                                <span style={{ color: withAlpha(TOKEN_HUE.solid, 0.8), fontSize: 11, pointerEvents: 'none' }}>×</span>
                              )}
                              {!timing.skipped && width > 38 && (
                                <span style={{
                                  color: isHopSel ? TOKEN_HUE.bright : withAlpha(TOKEN_HUE.solid, 0.85),
                                  fontSize: 10, paddingLeft: 5, whiteSpace: 'nowrap', pointerEvents: 'none',
                                  marginRight: 'auto',
                                }}>
                                  {hopIndex + 1} · {timing.duration.toFixed(2)}s
                                </span>
                              )}
                              {!timing.skipped && (
                                <div
                                  data-role="hop-resize"
                                  onMouseDown={(ev) => { ev.stopPropagation(); startHopResize(ev, linkId, timing.duration, varNode.id); }}
                                  style={{
                                    position: 'absolute', right: 0, top: 0, bottom: 0,
                                    width: HANDLE_W, cursor: 'ew-resize',
                                    background: isHopSel ? withAlpha(TOKEN_HUE.solid, 0.35) : pageColors.transparent,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  }}
                                >
                                  {isHopSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: TOKEN_HUE.solid }} />}
                                </div>
                              )}
                            </div>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    );
                  }

                  if (row.type === 'manual-token') {
                    const { item: tokenLink, track } = row;
                    const isTokenSel = selectedItem?.kind === 'manual-token' && selectedItem?.id === tokenLink.id;
                    const tokenLeft = track.start * PX_PER_SEC;
                    const tokenWidth = Math.max(track.duration * PX_PER_SEC, HANDLE_W + 6);
                    const selectToken = e => handleTimelineSelect(e, 'link', tokenLink.id, { manualToken: true });
                    return (
                      <div
                        key={`manual-token-${tokenLink.id}`}
                        onClick={selectToken}
                        style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isTokenSel ? withAlpha(TOKEN_HUE.solid, 0.04) : pageColors.transparent, cursor: 'crosshair' }}
                      >
                        <div
                          title={`Token · Start ${track.start.toFixed(2)}s · Travel ${track.duration.toFixed(2)}s`}
                          onMouseDown={e => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) { selectToken(e); return; }
                            startManualTokenDrag(e, tokenLink, track, 'manual-token-move');
                          }}
                          style={{
                            position: 'absolute', top: BLOCK_PAD, left: tokenLeft,
                            width: tokenWidth, height: ROW_H - BLOCK_PAD * 2,
                            borderRadius: 999, cursor: 'grab',
                            display: 'flex', alignItems: 'center', overflow: 'hidden',
                            background: isTokenSel ? withAlpha(TOKEN_HUE.solid, 0.34) : withAlpha(TOKEN_HUE.solid, 0.18),
                            border: `1px solid ${isTokenSel ? TOKEN_HUE.bright : withAlpha(TOKEN_HUE.solid, 0.55)}`,
                            boxShadow: isTokenSel ? `0 0 0 2px ${withAlpha(TOKEN_HUE.solid, 0.16)}` : 'none',
                          }}
                        >
                          <div style={{ width: 8, height: 8, borderRadius: '50%', marginLeft: 6, flexShrink: 0, background: TOKEN_HUE.bright, pointerEvents: 'none' }} />
                          {tokenWidth > 48 && (
                            <span style={{ color: isTokenSel ? TOKEN_HUE.bright : withAlpha(TOKEN_HUE.solid, 0.85), fontSize: 10, paddingLeft: 5, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {track.duration.toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => {
                              if (e.shiftKey || e.ctrlKey || e.metaKey) { selectToken(e); return; }
                              startManualTokenDrag(e, tokenLink, track, 'manual-token-resize');
                            }}
                            title="Drag to change how long the token takes to travel"
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W + 2, cursor: 'ew-resize',
                              background: isTokenSel ? withAlpha(TOKEN_HUE.bright, 0.2) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {isTokenSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: TOKEN_HUE.bright }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (row.type === 'morph') {
                    const { item: morphNode, morph } = row;
                    const isMorphSel = selectedItem?.kind === 'text-morph' && selectedItem?.id === morphNode.id && selectedItem?.morphId === morph.id;
                    const morphLeft = morph.startTime * PX_PER_SEC;
                    const morphWidth = Math.max(morph.duration * PX_PER_SEC, HANDLE_W + 6);
                    return (
                      <div
                        key={`morph-${morphNode.id}-${morph.id}`}
                        onClick={(e) => handleTimelineSelect(e, 'node', morphNode.id, { morphId: morph.id })}
                        style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isMorphSel ? withAlpha(MORPH_HUE.solid, 0.04) : pageColors.transparent, cursor: 'crosshair' }}
                      >
                        <div
                          onMouseDown={e => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) { handleTimelineSelect(e, 'node', morphNode.id, { morphId: morph.id }); return; }
                            startBlockDrag(e, morphNode, 'node', 'morph-move', { morphId: morph.id });
                          }}
                          style={{
                            position: 'absolute', top: BLOCK_PAD, left: morphLeft,
                            width: morphWidth, height: ROW_H - BLOCK_PAD * 2,
                            borderRadius: 5, cursor: 'grab',
                            display: 'flex', alignItems: 'center', overflow: 'hidden',
                            background: isMorphSel ? withAlpha(MORPH_HUE.solid, 0.32) : withAlpha(MORPH_HUE.solid, 0.18),
                            border: `1px solid ${isMorphSel ? MORPH_HUE.solid : withAlpha(MORPH_HUE.solid, 0.5)}`,
                          }}
                        >
                          {morphWidth > 44 && (
                            <span style={{ color: isMorphSel ? MORPH_HUE.bright : withAlpha(MORPH_HUE.solid, 0.7), fontSize: 10, paddingLeft: 6, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {morph.duration.toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => {
                              if (e.shiftKey || e.ctrlKey || e.metaKey) { handleTimelineSelect(e, 'node', morphNode.id, { morphId: morph.id }); return; }
                              e.stopPropagation();
                              startBlockDrag(e, morphNode, 'node', 'morph-resize', { morphId: morph.id });
                            }}
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W, cursor: 'ew-resize',
                              background: isMorphSel ? withAlpha(MORPH_HUE.solid, 0.3) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            {isMorphSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: MORPH_HUE.solid }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (row.type === 'gdomain' || row.type === 'gcalc') {
                    const { item: node, domain } = row;
                    const isCalc = row.type === 'gcalc';
                    const hue = domain.color ?? NODE_HUE.solid;
                    const selKindWant = isCalc ? 'graph-calc' : 'graph-domain';
                    const isSel = selectedItem?.kind === selKindWant && selectedItem?.id === node.id && selectedItem?.domainId === domain.id;
                    const initStart = isCalc
                      ? (Number.isFinite(domain.calc?.time) ? domain.calc.time : 0)
                      : (Number.isFinite(domain.startTime) ? domain.startTime : 0);
                    const initDur = isCalc
                      ? (Number.isFinite(domain.calc?.duration) ? domain.calc.duration : 1)
                      : (Number.isFinite(domain.duration) ? domain.duration : 0.4);
                    const left = initStart * PX_PER_SEC;
                    const width = Math.max(initDur * PX_PER_SEC, HANDLE_W + 6);
                    const dragKind = isCalc ? 'graph-calc' : 'graph-domain';
                    const moveType = isCalc ? 'gcalc-move' : 'gdomain-move';
                    const resizeType = isCalc ? 'gcalc-resize' : 'gdomain-resize';
                    return (
                      <div
                        key={`${row.type}-${node.id}-${domain.id}`}
                        onClick={(e) => { e.stopPropagation(); if (!didBlockDragRef.current) setSelectedItem({ kind: selKindWant, id: node.id, domainId: domain.id }); }}
                        style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isSel ? withAlpha(hue, 0.04) : pageColors.transparent, cursor: 'crosshair' }}
                      >
                        <div
                          onMouseDown={e => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) { setSelectedItem({ kind: selKindWant, id: node.id, domainId: domain.id }); return; }
                            e.preventDefault(); e.stopPropagation();
                            document.body.style.userSelect = 'none';
                            _pushHistory();
                            freezeIndependentTimelineItems('node', node.id);
                            blockDragRef.current = {
                              dragType: moveType,
                              kind: dragKind,
                              itemId: node.id,
                              domainId: domain.id,
                              startX: e.clientX,
                              initStart,
                              initDur,
                            };
                          }}
                          style={{ position: 'absolute', top: BLOCK_PAD, left, width, height: ROW_H - BLOCK_PAD * 2, borderRadius: 5, cursor: 'grab', display: 'flex', alignItems: 'center', overflow: 'hidden', background: isSel ? withAlpha(hue, 0.34) : withAlpha(hue, 0.2), border: `${isCalc ? '1px dashed' : '1px solid'} ${isSel ? hue : withAlpha(hue, 0.55)}` }}
                        >
                          {width > 44 && (
                            <span style={{ color: isSel ? hue : withAlpha(hue, 0.85), fontSize: 10, paddingLeft: 6, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {initDur.toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => {
                              e.stopPropagation();
                              document.body.style.userSelect = 'none';
                              _pushHistory();
                              blockDragRef.current = {
                                dragType: resizeType,
                                kind: dragKind,
                                itemId: node.id,
                                domainId: domain.id,
                                startX: e.clientX,
                                initStart,
                                initDur,
                              };
                            }}
                            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: 'ew-resize', background: isSel ? withAlpha(hue, 0.3) : pageColors.transparent, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '0 5px 5px 0' }}
                          >
                            {isSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: hue }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (row.type === 'gpoint') {
                    const { item: node, point: pt } = row;
                    const isSel = selectedItem?.kind === 'graph-point' && selectedItem?.id === node.id && selectedItem?.pointId === pt.id;
                    const left = (Number.isFinite(pt.startTime) ? pt.startTime : 0) * PX_PER_SEC;
                    const width = Math.max((Number.isFinite(pt.duration) ? pt.duration : 0.35) * PX_PER_SEC, HANDLE_W + 6);
                    return (
                      <div
                        key={`gpoint-${node.id}-${pt.id}`}
                        onClick={(e) => { e.stopPropagation(); if (!didBlockDragRef.current) setSelectedItem({ kind: 'graph-point', id: node.id, pointId: pt.id }); }}
                        style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isSel ? withAlpha(NODE_HUE.solid, 0.04) : pageColors.transparent, cursor: 'crosshair' }}
                      >
                        <div
                          onMouseDown={e => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) { setSelectedItem({ kind: 'graph-point', id: node.id, pointId: pt.id }); return; }
                            e.preventDefault(); e.stopPropagation();
                            document.body.style.userSelect = 'none';
                            _pushHistory();
                            freezeIndependentTimelineItems('node', node.id);
                            const initStart = Number.isFinite(pt.startTime) ? pt.startTime : 0;
                            const initDur = Number.isFinite(pt.duration) ? pt.duration : 0.35;
                            blockDragRef.current = {
                              dragType: 'gp-move',
                              kind: 'graph-point',
                              itemId: node.id,
                              pointId: pt.id,
                              startX: e.clientX,
                              initStart,
                              initDur,
                            };
                          }}
                          style={{ position: 'absolute', top: BLOCK_PAD, left, width, height: ROW_H - BLOCK_PAD * 2, borderRadius: 5, cursor: 'grab', display: 'flex', alignItems: 'center', overflow: 'hidden', background: isSel ? withAlpha(NODE_HUE.solid, 0.32) : withAlpha(NODE_HUE.solid, 0.18), border: `1px solid ${isSel ? NODE_HUE.solid : withAlpha(NODE_HUE.solid, 0.5)}` }}
                        >
                          {width > 44 && (
                            <span style={{ color: isSel ? NODE_HUE.bright : withAlpha(NODE_HUE.solid, 0.7), fontSize: 10, paddingLeft: 6, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                              {(Number.isFinite(pt.duration) ? pt.duration : 0.35).toFixed(2)}s
                            </span>
                          )}
                          <div
                            onMouseDown={e => {
                              e.stopPropagation();
                              document.body.style.userSelect = 'none';
                              blockDragRef.current = {
                                dragType: 'gp-resize',
                                kind: 'graph-point',
                                itemId: node.id,
                                pointId: pt.id,
                                startX: e.clientX,
                                initStart: Number.isFinite(pt.startTime) ? pt.startTime : 0,
                                initDur: Number.isFinite(pt.duration) ? pt.duration : 0.35,
                              };
                            }}
                            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: 'ew-resize', background: isSel ? withAlpha(NODE_HUE.solid, 0.3) : pageColors.transparent, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '0 5px 5px 0' }}
                          >
                            {isSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: NODE_HUE.solid }} />}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  const { item, type: kind } = row;
                  const { start, duration, displayDuration, isAuto } = effectiveTiming(item, kind);
                  const hue        = kind === 'node' ? NODE_HUE : LINK_HUE;
                  const isSel      = selectedItem?.id === item.id && (
                    selectedItem?.kind === kind ||
                    (kind === 'node' && selectedItem?.kind === 'text-morph') ||
                    (kind === 'node' && selectedItem?.kind === 'node-failure') ||
                    (kind === 'link' && selectedItem?.kind === 'link-failure') ||
                    (kind === 'link' && selectedItem?.kind === 'manual-token') ||
                    (kind === 'node' && selectedItem?.kind === 'scroll-step') ||
                    (kind === 'link' && selectedItem?.kind === 'manual-token-text')
                  );
                  const isTriggered = (kind === 'node' && !!item.triggerAfterLinkId) || !!item.triggerEventId;
                  // Blueprint items aren't on the timeline yet: their bar is a faded
                  // placeholder at 0s (dragging it gives the item a start time).
                  const isBlueprint = isBlueprintItem(item, kind);
                  const boundKey   = kind === 'link' ? boundKeyByLinkId[item.id] : null;
                  const isBound    = !!boundKey;
                  const boundCount = isBound ? (boundLinkIdsByKey[boundKey]?.length ?? 1) : 0;
                  const bLeft      = start * PX_PER_SEC;
                  const baseWidth  = Math.max(duration * PX_PER_SEC, HANDLE_W + 6);
                  const displayWidthPx = Math.max(displayDuration * PX_PER_SEC, baseWidth);
                  const extensionWidth = Math.max(0, displayWidthPx - baseWidth);

                  return (
                    <div
                      key={`${kind}-${item.id}`}
                      onClick={e => handleTimelineSelect(e, kind, item.id)}
                      style={{ height: ROW_H, borderBottom: `1px solid ${pageColors.timelineRowDivider}`, position: 'relative', flexShrink: 0, background: isSel ? withAlpha(hue.solid, 0.04) : selectedIds.includes(item.id) ? withAlpha(hue.solid, 0.025) : pageColors.transparent, cursor: 'crosshair', opacity: isBlueprint ? 0.4 : 1 }}
                    >
                      {isTriggered && (
                        <div style={{
                          position: 'absolute', left: 0, top: ROW_H / 2 - 0.5,
                          width: bLeft, height: 1,
                          background: `repeating-linear-gradient(90deg, ${withAlpha(pageColors.blueLink, 0.5)} 0 4px, transparent 4px 8px)`,
                          pointerEvents: 'none',
                        }} />
                      )}
                      {kind === 'link' && item.manualTokenEnabled && (() => {
                        const textKeys = normalizeManualTokenTextKeyframes(item.manualTokenTextKeyframes)
                          .slice().sort((a, b) => a.time - b.time);
                        return textKeys.map((keyframe, keyIndex) => {
                        const isKeySelected = selectedItem?.kind === 'manual-token-text'
                          && selectedItem?.id === item.id
                          && selectedItem?.keyframeId === keyframe.id;
                        // Label the diamond with the text it switches to, clipped before the next key.
                        const nextKey = textKeys[keyIndex + 1];
                        const labelMaxW = nextKey
                          ? Math.max(0, (nextKey.time - keyframe.time) * PX_PER_SEC - 16)
                          : 140;
                        return (
                          <React.Fragment key={`manual-token-text-${item.id}-${keyframe.id}`}>
                          {labelMaxW >= 14 && (
                            <div
                              onClick={e => handleTimelineSelect(e, 'link', item.id, { manualTokenTextKeyframeId: keyframe.id })}
                              onMouseDown={e => startManualTokenTextKeyframeDrag(e, item, keyframe)}
                              title={`Token text at ${keyframe.time.toFixed(2)}s: ${keyframe.text || '(blank)'}`}
                              style={{
                                position: 'absolute',
                                left: keyframe.time * PX_PER_SEC + 8,
                                top: 0,
                                maxWidth: labelMaxW,
                                height: 14,
                                lineHeight: '14px',
                                padding: '0 4px',
                                zIndex: 8,
                                borderRadius: 3,
                                fontSize: 9,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                cursor: 'ew-resize',
                                userSelect: 'none',
                                fontStyle: keyframe.text ? 'normal' : 'italic',
                                color: isKeySelected ? pageColors.white : TOKEN_HUE.bright,
                                background: isKeySelected ? withAlpha(TOKEN_HUE.solid, 0.85) : withAlpha(pageColors.timelineSectionBackground, 0.92),
                                border: `1px solid ${withAlpha(TOKEN_HUE.solid, isKeySelected ? 0.9 : 0.45)}`,
                              }}
                            >
                              {keyframe.text || 'blank'}
                            </div>
                          )}
                          <div
                            title={`Token text at ${keyframe.time.toFixed(2)}s: ${keyframe.text || '(blank)'}`}
                            onClick={e => handleTimelineSelect(e, 'link', item.id, { manualTokenTextKeyframeId: keyframe.id })}
                            onMouseDown={e => startManualTokenTextKeyframeDrag(e, item, keyframe)}
                            style={{
                              position: 'absolute',
                              left: keyframe.time * PX_PER_SEC - 6,
                              top: 2,
                              width: 12,
                              height: 12,
                              zIndex: 8,
                              cursor: 'ew-resize',
                              transform: 'rotate(45deg)',
                              borderRadius: 2,
                              background: isKeySelected ? TOKEN_HUE.bright : withAlpha(TOKEN_HUE.solid, 0.75),
                              border: `1px solid ${isKeySelected ? pageColors.white : withAlpha(pageColors.white, 0.55)}`,
                              boxShadow: isKeySelected ? `0 0 0 2px ${withAlpha(TOKEN_HUE.solid, 0.25)}` : 'none',
                            }}
                          />
                          </React.Fragment>
                        );
                        });
                      })()}
                      <div
                        title={`${kind === 'node' ? 'Node' : 'Link'} · Start ${start.toFixed(2)}s · Duration ${duration.toFixed(2)}s${displayDuration !== duration ? ` · Timeline ${displayDuration.toFixed(2)}s` : ''}${isTriggered ? ' · Triggered by an event' : ''}${isBound ? ` · Synced with ${boundCount} links` : ''}`}
                        onMouseDown={e => {
                          if (e.shiftKey || e.ctrlKey || e.metaKey) {
                            handleTimelineSelect(e, kind, item.id);
                            return;
                          }
                          if (!isTriggered) startBlockDrag(e, item, kind, 'move');
                        }}
                        style={{
                          position: 'absolute', top: BLOCK_PAD, left: bLeft,
                          width: displayWidthPx, height: ROW_H - BLOCK_PAD * 2,
                          borderRadius: 5, cursor: isTriggered ? 'pointer' : 'grab',
                          display: 'flex', alignItems: 'center', overflow: 'visible',
                          userSelect: 'none',
                        }}
                      >
                        {extensionWidth > 0 && (
                          <div style={{
                            position: 'absolute',
                            left: baseWidth - 1,
                            top: 0,
                            width: extensionWidth + 1,
                            height: '100%',
                            borderRadius: '0 5px 5px 0',
                            background: isSel
                              ? withAlpha(pageColors.blueLink, 0.26)
                              : withAlpha(pageColors.blueLink, 0.12),
                            border: `1px dashed ${withAlpha(pageColors.blueLink, isSel ? 0.65 : 0.42)}`,
                            boxSizing: 'border-box',
                            pointerEvents: 'none',
                          }} />
                        )}

                      {/* Transform block — amber pill showing when the shape/color/label change fires */}
                      {kind === 'node' && (() => {
                        const tMode = item.transformMode;
                        if (!tMode || tMode === 'none') return null;
                        const tAutoInfo = autoTimes.nodes[item.id];
                        const tStart = item.transformStartTime ?? tAutoInfo?.transformStart ?? null;
                        if (tStart == null) return null;
                        const tDur = item.transformDuration ?? 0.4;
                        const tLeft = tStart * PX_PER_SEC - bLeft; // relative to the outer div left=bLeft
                        const tWidth = Math.max(tDur * PX_PER_SEC, HANDLE_W + 6);
                        const isManual = item.transformStartTime != null;
                        return (
                          <div
                            key="transform-block"
                            onMouseDown={e => {
                              if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                              e.stopPropagation();
                              startTransformBlockDrag(e, item, 'transform-move');
                            }}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: tLeft,
                              width: tWidth,
                              height: '100%',
                              borderRadius: 5,
                              cursor: 'grab',
                              display: 'flex',
                              alignItems: 'center',
                              overflow: 'hidden',
                              background: isSel
                                ? withAlpha(TRANSFORM_HUE.solid, 0.42)
                                : withAlpha(TRANSFORM_HUE.solid, 0.22),
                              border: `1px solid ${withAlpha(TRANSFORM_HUE.solid, isSel ? 0.9 : 0.55)}`,
                              boxSizing: 'border-box',
                            }}
                          >
                            {tWidth > 30 && (
                              <span style={{ color: TRANSFORM_HUE.solid, fontSize: 9, paddingLeft: 5, whiteSpace: 'nowrap', pointerEvents: 'none', fontWeight: 700, letterSpacing: '0.04em', opacity: isSel ? 1 : 0.8 }}>
                                ↪ {isManual ? `${tDur.toFixed(2)}s` : 'auto'}
                              </span>
                            )}
                            <div
                              onMouseDown={e => {
                                e.stopPropagation();
                                if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                                startTransformBlockDrag(e, item, 'transform-resize');
                              }}
                              style={{
                                position: 'absolute', right: 0, top: 0, bottom: 0,
                                width: HANDLE_W, cursor: 'ew-resize',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                borderRadius: '0 5px 5px 0',
                              }}
                            >
                              {isSel && <div style={{ width: 2, height: 10, borderRadius: 1, background: TRANSFORM_HUE.bright }} />}
                            </div>
                          </div>
                        );
                      })()}
                        <div
                          style={{
                            position: 'relative',
                            width: baseWidth,
                            height: '100%',
                            borderRadius: 5,
                            display: 'flex',
                            alignItems: 'center',
                            overflow: 'hidden',
                            background: isSel
                              ? withAlpha(hue.solid, 0.35)
                              : isTriggered
                                ? withAlpha(pageColors.blueLink, 0.18)
                                : isBound
                                  ? `linear-gradient(135deg, ${withAlpha(pageColors.blueLink, 0.18)}, ${withAlpha(hue.solid, isAuto ? 0.18 : 0.28)})`
                                  : isAuto
                                    ? withAlpha(hue.solid, 0.12)
                                    : withAlpha(hue.solid, 0.24),
                            border: `1px solid ${isSel ? hue.solid : isTriggered || isBound ? withAlpha(pageColors.blueLink, 0.5) : withAlpha(hue.solid, 0.3)}`,
                            boxShadow: isTriggered || isBound ? `0 0 0 1px ${withAlpha(pageColors.blueLink, 0.15)} inset` : 'none',
                            boxSizing: 'border-box',
                          }}
                        >
                        {isBound && (
                          <div style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: 0,
                            height: 2,
                            background: pageColors.blueLink,
                            opacity: 0.85,
                            pointerEvents: 'none',
                          }} />
                        )}
                        {isTriggered && (
                          <span style={{ fontSize: 10, paddingLeft: 5, opacity: 0.8, flexShrink: 0, pointerEvents: 'none' }}>⛓</span>
                        )}
                        {isBound && baseWidth > 74 && (
                          <span style={{
                            color: pageColors.blueLink,
                            fontSize: 8,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            paddingLeft: isTriggered ? 3 : 6,
                            pointerEvents: 'none',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}>
                            SYNC
                          </span>
                        )}
                        {baseWidth > (isTriggered || isBound ? 60 : 44) && (
                          <span style={{ color: isSel ? hue.bright : isTriggered || isBound ? pageColors.blueLink : hue.solid, fontSize: 10, paddingLeft: isTriggered ? 3 : 6, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                            {duration.toFixed(2)}s
                          </span>
                        )}

                        {!isTriggered && (
                          <div
                            onMouseDown={e => {
                              if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                handleTimelineSelect(e, kind, item.id);
                                return;
                              }
                              startBlockDrag(e, item, kind, 'resize');
                            }}
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W, cursor: 'ew-resize',
                              background: isSel ? withAlpha(hue.solid, 0.3) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              borderRadius: '0 5px 5px 0',
                            }}
                          >
                            {isSel && <div style={{ width: 2, height: 12, background: hue.bright, borderRadius: 1 }} />}
                          </div>
                        )}
                        {isTriggered && (
                          <div
                            onMouseDown={e => {
                              if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                handleTimelineSelect(e, kind, item.id);
                                return;
                              }
                              startBlockDrag(e, item, kind, 'resize');
                            }}
                            style={{
                              position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: HANDLE_W, cursor: 'ew-resize',
                              background: isSel ? withAlpha(pageColors.blueLink, 0.3) : pageColors.transparent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              borderRadius: '0 5px 5px 0',
                            }}
                          >
                            {isSel && <div style={{ width: 2, height: 12, background: pageColors.blueLink, borderRadius: 1 }} />}
                          </div>
                        )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div
                ref={playheadRef}
                style={{
                  position: 'absolute', left: currentTime * PX_PER_SEC, top: 0, bottom: 0,
                  width: 1, background: pageColors.dangerLineSoft,
                  pointerEvents: 'none', zIndex: 20,
                }}
              >
                <div
                  onMouseDown={e => {
                    e.preventDefault(); e.stopPropagation();
                    document.body.style.userSelect = 'none';
                    headDragRef.current = true;
                  }}
                  style={{
                    position: 'absolute', top: -1, left: -6,
                    width: 13, height: 13, borderRadius: '50%',
                    background: pageColors.dangerMain, border: `2px solid ${pageColors.dangerSoft}`,
                    cursor: 'ew-resize', pointerEvents: 'all',
                    boxShadow: `0 0 8px ${pageColors.dangerGlow}`,
                  }}
                />
                <div
                  data-time-label
                  style={{
                    position: 'absolute', top: 15, left: 5,
                    background: pageColors.dangerTooltip, color: pageColors.white,
                    fontSize: 9, padding: '1px 5px', borderRadius: 3,
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                  }}
                >
                  {currentTime.toFixed(2)}s
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Popup listing every text morph of a node, opened from the timeline bar.
function MorphsMenu({ menu, morphs, node, selectedMorphId, onClose, onToggle, onAdd, onUpdate, onRemove }) {
  const popRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (e.target.closest?.('[data-morph-menu-toggle]')) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const swatch = (morph, label, key, fallback) => (
    <label className="tl-pop__swatch">
      <input
        type="color"
        className="tl-swatch"
        value={toColorInputValue(morph[key] ?? fallback, '#ffffff')}
        onChange={e => onUpdate(morph.id, { [key]: e.target.value })}
      />
      <span>{label}</span>
    </label>
  );

  return createPortal(
    <div
      ref={popRef}
      className="tl-pop"
      style={{ left: menu.left, bottom: menu.bottom, width: 300, maxHeight: menu.maxHeight }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="tl-pop__head">
        <span>Text morphs <span className="tl-btn__count">{morphs.length}</span></span>
        <button className="tl-pop__close" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="tl-pop__list">
        {morphs.length === 0 && (
          <div className="tl-hint" style={{ padding: '6px 2px' }}>No morphs yet. Add one to change this node's text over time.</div>
        )}
        {morphs.map((morph, i) => {
          const expanded = menu.expandedId === morph.id;
          return (
            <div key={morph.id} className={`tl-morph${expanded ? ' tl-morph--open' : ''}${selectedMorphId === morph.id ? ' tl-morph--sel' : ''}`}>
              <div className="tl-morph__row" onClick={() => onToggle(morph.id)}>
                <span className="tl-morph__caret">{expanded ? '▾' : '▸'}</span>
                <span className="tl-morph__idx">{i + 1}</span>
                <span className="tl-morph__text">{morph.text ? `“${morph.text}”` : <em>empty</em>}</span>
                <span className="tl-morph__meta">{morph.startTime.toFixed(2)}s · {morph.mode}</span>
                <button
                  className="tl-pop__close"
                  title="Remove morph"
                  onClick={e => { e.stopPropagation(); onRemove(morph.id); }}
                >
                  ✕
                </button>
              </div>

              {expanded && (
                <div className="tl-morph__body">
                  <div className="tl-pop__row">
                    <span className="tl-label">Morph to</span>
                    <label className="tl-field">
                      <input
                        type="text"
                        value={morph.text}
                        autoFocus={menu.focusId === morph.id}
                        onChange={e => onUpdate(morph.id, { text: e.target.value })}
                        style={{ width: 170 }}
                      />
                    </label>
                  </div>
                  <div className="tl-pop__row">
                    <span className="tl-label">Mode</span>
                    <select
                      value={morph.mode}
                      onChange={e => onUpdate(morph.id, { mode: e.target.value })}
                      className="tl-select"
                    >
                      <option value="fade">Fade</option>
                      <option value="write">Write</option>
                    </select>
                  </div>
                  <div className="tl-pop__grid">
                    <span className="tl-label">Start</span>
                    <NumberField value={morph.startTime} step={0.05} min={0} unit="s" onChange={v => onUpdate(morph.id, { startTime: r2(Math.max(0, v)) })} />
                    <span className="tl-label">Duration</span>
                    <NumberField value={morph.duration} step={0.05} min={0.1} unit="s" onChange={v => onUpdate(morph.id, { duration: r2(Math.max(0.1, v)) })} />
                  </div>
                  <div className="tl-pop__swatches">
                    {swatch(morph, 'Fill', 'fill', node.fill)}
                    {swatch(morph, 'Border', 'stroke', node.stroke)}
                    {swatch(morph, 'Text', 'textColor', node.textColor)}
                  </div>
                  <div className="tl-pop__grid">
                    <span className="tl-label">Radius</span>
                    <NumberField
                      value={morph.cornerRadius ?? node.cornerRadius ?? 8}
                      step={1}
                      min={0}
                      onChange={v => onUpdate(morph.id, { cornerRadius: Math.max(0, Math.round(v)) })}
                    />
                    <span className="tl-label">Alpha</span>
                    <NumberField
                      value={morph.alpha ?? 1}
                      step={0.1}
                      min={0}
                      onChange={v => onUpdate(morph.id, { alpha: Math.max(0, Math.min(1, v)) })}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="tl-pop__foot">
        <button className="tl-btn tl-btn--accent" onClick={onAdd}>+ Add morph</button>
      </div>
    </div>,
    document.body
  );
}

function VSep() {
  return <div className="tl-sep" />;
}
function FieldLabel({ children }) {
  return <span className="tl-label">{children}</span>;
}
function NumberField({ value, step, min, onChange, unit }) {
  return (
    <label className="tl-field">
      <input
        type="number" value={value} step={step} min={min}
        onChange={e => onChange(Number(e.target.value))}
        onMouseDown={e => e.stopPropagation()}
      />
      {unit && <span className="tl-field__unit">{unit}</span>}
    </label>
  );
}
function InlineTextField({ value, onChange, width = 120 }) {
  return (
    <label className="tl-field">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onMouseDown={e => e.stopPropagation()}
        style={{ width }}
      />
    </label>
  );
}
function PlayBtn({ active, onClick, disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled} title={disabled ? 'Switch to live animation (Tab) to play' : active ? 'Pause' : 'Play preview'} style={{
      background: active ? 'var(--blue-main)' : 'var(--panel-blue)', border: '1px solid var(--border-strong)',
      borderRadius: 6, color: 'var(--blue-bright)', fontSize: 13, padding: '4px 12px',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, lineHeight: 1, flexShrink: 0, minWidth: 36,
    }}>
      {active ? '⏸' : '▶'}
    </button>
  );
}
function StopBtn({ onClick }) {
  return (
    <button onClick={onClick} title="Stop and rewind" style={{
      background: 'var(--panel-bg)', border: '1px solid var(--border-strong)',
      borderRadius: 6, color: 'var(--text-muted)', fontSize: 13, padding: '4px 10px',
      cursor: 'pointer', lineHeight: 1, flexShrink: 0,
    }}>
      ■
    </button>
  );
}

export default KeyframePanel;
