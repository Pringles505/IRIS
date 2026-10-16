import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useStore from '../store/useStore';
import { EVENT_KINDS, buildEventGraph } from '../events/projectEvents';
import { EVENT_KIND_COLOR } from '../events/eventColors';
import { TRIGGERABLE_EVENT_KINDS, setEventTrigger } from '../events/eventFile';
import { getTimelineCursor } from '../timelineCursor';

// Events whose start can be set by a trigger.
const TRIGGERABLE_KINDS = TRIGGERABLE_EVENT_KINDS;

const PAD = 28;
const BOX_W = 176;
const BOX_H = 40;
const COL_GAP = 64;   // horizontal room for the arrow between connected events
const ROW_H = 64;     // row pitch: box + a clear channel for lines
const GROUP_GAP = 28;
const LOOSE_COLS = 5; // events with no connections are tiled at the bottom

// How long following the playhead takes to glide to the running event.
const FOLLOW_GLIDE_MS = 380;

const fmt = t => `${t.toFixed(2)}s`;

// Flow layout: each cascade reads left to right. An event's first follow-up sits on
// the same row right after it (a straight arrow); further follow-ups branch onto new
// rows below. Events with no connections are tiled in a grid at the bottom.
function layoutCascade(events, edges) {
  const byId = new Map(events.map(event => [event.id, event]));
  const outgoing = new Map(events.map(event => [event.id, []]));
  const incoming = new Map(events.map(event => [event.id, 0]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to) + 1);
  }
  const byStart = (a, b) => byId.get(a).start - byId.get(b).start || byId.get(a).end - byId.get(b).end;
  const connected = id => outgoing.get(id).length > 0 || incoming.get(id) > 0;

  const boxes = new Map();
  let nextRow = 0;
  let maxCol = 0;
  const visit = (id, row, col) => {
    if (boxes.has(id)) return;
    boxes.set(id, { event: byId.get(id), row, col });
    maxCol = Math.max(maxCol, col);
    const children = [...outgoing.get(id)].filter(child => !boxes.has(child)).sort(byStart);
    children.forEach((child, i) => {
      if (boxes.has(child)) return;
      // First follow-up continues the row; the rest branch below it.
      const childRow = i === 0 ? row : nextRow++;
      visit(child, childRow, col + 1);
    });
  };

  const linked = events.map(e => e.id).filter(connected);
  const roots = linked.filter(id => incoming.get(id) === 0).sort(byStart);
  for (const root of [...roots, ...[...linked].sort(byStart)]) {
    if (boxes.has(root)) continue;
    const row = nextRow++;
    visit(root, row, 0);
  }

  const toXY = ({ row, col }, offsetY = 0) => ({
    x: PAD + col * (BOX_W + COL_GAP),
    y: PAD + offsetY + row * ROW_H,
  });
  for (const box of boxes.values()) Object.assign(box, toXY(box), { w: BOX_W, h: BOX_H });

  const flowHeight = nextRow * ROW_H;
  const loose = events.filter(event => !connected(event.id)).sort((a, b) => a.start - b.start);
  const looseTop = PAD + flowHeight + (nextRow ? GROUP_GAP : 0);
  loose.forEach((event, i) => {
    const col = i % LOOSE_COLS;
    const row = Math.floor(i / LOOSE_COLS);
    boxes.set(event.id, {
      event,
      loose: true,
      x: PAD + col * (BOX_W + 24),
      y: looseTop + 22 + row * (BOX_H + 16),
      w: BOX_W,
      h: BOX_H,
    });
  });
  const looseRows = Math.ceil(loose.length / LOOSE_COLS);
  const width = PAD * 2 + Math.max((maxCol + 1) * (BOX_W + COL_GAP), loose.length ? LOOSE_COLS * (BOX_W + 24) : 0);
  const height = looseTop + (loose.length ? 22 + looseRows * (BOX_H + 16) : 0) + PAD;
  return { boxes, width, height, looseTop: loose.length ? looseTop : null };
}

// Straight lines only: horizontal when on the same row, otherwise a right-angle step
// (across, down, across) through the gap between columns.
function edgePath(edge, boxes) {
  const a = boxes.get(edge.from);
  const b = boxes.get(edge.to);
  if (!a || !b) return null;
  const sx = a.x + a.w;
  const sy = a.y + a.h / 2;
  const tx = b.x;
  const ty = b.y + b.h / 2;
  if (Math.abs(sy - ty) < 0.5 && tx > sx) return `M ${sx} ${sy} H ${tx}`;
  if (tx > sx + 12) {
    const midX = sx + Math.min(COL_GAP / 2, (tx - sx) / 2);
    return `M ${sx} ${sy} H ${midX} V ${ty} H ${tx}`;
  }
  // Target is behind the source (e.g. a second parent further right): loop around below.
  const below = Math.max(a.y + a.h, b.y + b.h) + (ROW_H - BOX_H) / 2;
  return `M ${sx} ${sy} H ${sx + 14} V ${below} H ${tx - 14} V ${ty} H ${tx}`;
}

// Everything upstream and downstream of an event (its whole cascade).
function cascadeOf(id, edges) {
  if (!id) return null;
  const related = new Set([id]);
  const walk = (key, other) => {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      for (const edge of edges) {
        if (edge[key] !== current || seen.has(edge[other])) continue;
        seen.add(edge[other]);
        related.add(edge[other]);
        stack.push(edge[other]);
      }
    }
  };
  walk('from', 'to'); // downstream
  walk('to', 'from'); // upstream
  return related;
}

// Large popup showing how the project's events lead into each other: triggers as solid
// arrows, events that belong to another event as dashed arrows.
export default function EventCascade({ onClose }) {
  const nodes = useStore(state => state.nodes);
  const links = useStore(state => state.links);
  const blueprintMode = useStore(state => state.editorMode === 'blueprint');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [editing, setEditing] = useState(false);
  // Collapsed: a small movable window without a backdrop, to watch while playing.
  const [floating, setFloating] = useState(false);
  const [floatPos, setFloatPos] = useState(() => ({
    x: Math.max(16, window.innerWidth - 600),
    y: Math.max(16, window.innerHeight - 460),
  }));
  const [now, setNow] = useState(() => getTimelineCursor());
  const canvasRef = useRef(null);
  // Zoom of the diagram (1 = 100%). Drawing uses a viewBox, so hit-testing and wiring
  // keep working in layout coordinates at any zoom.
  const [zoom, setZoom] = useState(1);
  const clampZoom = z => Math.max(0.2, Math.min(2, Math.round(z * 100) / 100));
  const [selectedEdge, setSelectedEdge] = useState(null); // trigger edge id
  const [drag, setDrag] = useState(null);                 // { fromId, x, y } while wiring
  const svgRef = useRef(null);

  const graph = useMemo(() => {
    try {
      return buildEventGraph(nodes, links);
    } catch (err) {
      console.error('[EventCascade] could not build the event graph:', err);
      return { events: [], edges: [] };
    }
  }, [nodes, links]);

  const visibleEvents = useMemo(() => {
    if (!connectedOnly) return graph.events;
    const connected = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]));
    return graph.events.filter(event => connected.has(event.id));
  }, [connectedOnly, graph]);

  const layout = useMemo(() => layoutCascade(visibleEvents, graph.edges), [visibleEvents, graph.edges]);
  const highlight = useMemo(() => cascadeOf(hovered, graph.edges), [hovered, graph.edges]);

  // Follow the playhead: events running at the current time are highlighted in yellow.
  useEffect(() => {
    let frame;
    let last = null;
    const tick = () => {
      // ~20 updates a second is plenty for the indicator and keeps playback smooth.
      const t = getTimelineCursor();
      if (last === null || Math.abs(t - last) >= 0.05 || (t === 0 && last !== 0)) { last = t; setNow(t); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  // Blueprint mode is for building, not playing, so nothing is highlighted there; and a
  // blueprint item is always on screen, never "running", so it is never highlighted.
  const activeIds = useMemo(() => new Set(blueprintMode ? [] :
    graph.events
      .filter(event => !event.blueprint && (event.end === event.start
        ? Math.abs(now - event.start) < 0.06
        : now >= event.start && now <= event.end))
      .map(event => event.id)
  ), [blueprintMode, graph.events, now]);
  const activeKey = [...activeIds].sort().join('|');

  // Camera, like the main canvas: the diagram is drawn at `pan` (screen px inside the
  // canvas) and scaled by `zoom`, so it can be moved freely whatever its size.
  // Plain wheel / two-finger swipe and middle-drag pan; Ctrl/Cmd + wheel (or pinch)
  // zooms toward the pointer.
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const viewRef = useRef({ pan, zoom });
  viewRef.current = { pan, zoom };

  // Zoom to `next`, keeping the diagram point under (px, py) in place.
  const zoomAt = (next, px, py) => {
    const { pan: current, zoom: z } = viewRef.current;
    const clamped = clampZoom(next);
    if (clamped === z) return;
    stopGlide();
    setPan({ x: px - (px - current.x) * (clamped / z), y: py - (py - current.y) * (clamped / z) });
    setZoom(clamped);
  };
  const zoomAtCenter = (next) => {
    const canvas = canvasRef.current;
    zoomAt(next, (canvas?.clientWidth ?? 0) / 2, (canvas?.clientHeight ?? 0) / 2);
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  // Following the playhead glides the camera to the running event (a quick ease-out,
  // like the old smooth scroll). Any manual pan or zoom cancels a glide in progress.
  const glideRef = useRef(null);
  const stopGlide = () => {
    if (glideRef.current) cancelAnimationFrame(glideRef.current);
    glideRef.current = null;
  };
  const glideTo = (target) => {
    stopGlide();
    const from = viewRef.current.pan;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { setPan(target); return; }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / FOLLOW_GLIDE_MS);
      const k = 1 - (1 - t) ** 3;
      setPan({ x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k });
      glideRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    glideRef.current = requestAnimationFrame(step);
  };
  const stopGlideRef = useRef(stopGlide);
  stopGlideRef.current = stopGlide;
  useEffect(() => () => stopGlideRef.current(), []);

  // Keep the newest running event in view as the animation plays.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeIds.size) return;
    const boxes = [...activeIds].map(id => layout.boxes.get(id)).filter(Boolean);
    if (!boxes.length) return;
    const raw = boxes.reduce((a, b) => (b.event.start > a.event.start ? b : a));
    const box = { x: pan.x + raw.x * zoom, y: pan.y + raw.y * zoom, w: raw.w * zoom, h: raw.h * zoom };
    const inView = box.x >= 0 && box.x + box.w <= canvas.clientWidth
      && box.y >= 0 && box.y + box.h <= canvas.clientHeight;
    if (!inView) {
      glideTo({
        x: canvas.clientWidth / 2 - (raw.x + raw.w / 2) * zoom,
        y: canvas.clientHeight / 2 - (raw.y + raw.h / 2) * zoom,
      });
    }
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitToWindow = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(layout.width, 600);
    const h = Math.max(layout.height, 1);
    const next = clampZoom(Math.min(1, (canvas.clientWidth - 8) / w, (canvas.clientHeight - 8) / h));
    stopGlide();
    setZoom(next);
    setPan({ x: (canvas.clientWidth - w * next) / 2, y: (canvas.clientHeight - h * next) / 2 });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = canvas.getBoundingClientRect();
        zoomAtRef.current(viewRef.current.zoom * Math.pow(0.998, e.deltaY), e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      stopGlideRef.current();
      const lineH = e.deltaMode === 1 ? 20 : 1;
      // Shift + wheel pans sideways on a plain mouse wheel.
      const sideways = e.shiftKey && !e.deltaX;
      const dx = sideways ? e.deltaY : e.deltaX;
      const dy = sideways ? 0 : e.deltaY;
      setPan(p => ({ x: p.x - dx * lineH, y: p.y - dy * lineH }));
    };

    // Grab and drag to move around: the middle button anywhere, or the left button on
    // empty space (boxes, trigger lines and wire handles keep the left button). Pointer
    // events are used throughout: cancelling a pointerdown stops the browser from
    // sending the matching mousedown, so a mouse-event pan would never start.
    const INTERACTIVE = '.ecx__box, .ecx__hit, .ecx__handle, button, input';
    let drag = null;
    const onDown = e => {
      const middle = e.button === 1;
      const leftOnEmpty = e.button === 0 && !e.target.closest(INTERACTIVE);
      if (!middle && !leftOnEmpty) return;
      // Middle presses never reach boxes or handles (and don't start autoscroll).
      if (middle) e.stopPropagation();
      e.preventDefault();
      stopGlideRef.current();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: viewRef.current.pan };
      canvas.classList.add('ecx__canvas--panning');
      // Keep receiving moves when the pointer leaves the window mid-drag.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    };
    const onMove = e => {
      if (!drag || e.pointerId !== drag.id) return;
      setPan({ x: drag.pan.x + (e.clientX - drag.x), y: drag.pan.y + (e.clientY - drag.y) });
    };
    const onUp = e => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.classList.remove('ecx__canvas--panning');
    };
    // Belt and braces for browsers that still start middle-click autoscroll / paste.
    const blockMiddle = e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); } };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown, true);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('mousedown', blockMiddle, true);
    canvas.addEventListener('auxclick', blockMiddle, true);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown, true);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('mousedown', blockMiddle, true);
      canvas.removeEventListener('auxclick', blockMiddle, true);
    };
  }, [floating]); // collapsing/expanding remounts the canvas

  const startMoveWindow = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, label')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, px: floatPos.x, py: floatPos.y };
    const onMove = me => setFloatPos({
      x: Math.max(0, Math.min(window.innerWidth - 120, start.px + me.clientX - start.x)),
      y: Math.max(0, Math.min(window.innerHeight - 40, start.py + me.clientY - start.y)),
    });
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const triggerCount = graph.edges.filter(edge => edge.kind === 'trigger').length;

  // Rewiring writes straight to the project (one undo step per change).
  const rewire = (targetEventId, sourceEventId) => {
    const store = useStore.getState();
    const next = setEventTrigger(store.nodes, store.links, targetEventId, sourceEventId);
    store._pushHistory();
    useStore.setState({ nodes: next.nodes, links: next.links });
  };
  const removeSelectedTrigger = () => {
    const edge = graph.edges.find(e => e.id === selectedEdge);
    if (!edge) return;
    rewire(edge.to, null);
    setSelectedEdge(null);
  };

  const toSvgPoint = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const boxAt = ({ x, y }) => [...layout.boxes.values()].find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;

  const startWire = (e, fromId) => {
    e.preventDefault();
    e.stopPropagation();
    svgRef.current.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    setDrag({ fromId, x: p.x, y: p.y });
    setSelectedEdge(null);
  };
  const moveWire = (e) => {
    if (!drag) return;
    const p = toSvgPoint(e);
    setDrag(d => d && { ...d, x: p.x, y: p.y });
  };
  const endWire = (e) => {
    if (!drag) return;
    if (svgRef.current?.hasPointerCapture?.(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    const target = boxAt(toSvgPoint(e));
    if (target && target.event.id !== drag.fromId && TRIGGERABLE_KINDS.has(target.event.kind)) {
      rewire(target.event.id, drag.fromId);
    }
    setDrag(null);
  };

  useEffect(() => {
    const onKey = e => {
      // The collapsed window leaves the keyboard to the editor.
      if (floating) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (drag) setDrag(null);
        else if (selectedEdge) setSelectedEdge(null);
        else onClose();
        return;
      }
      if (editing && selectedEdge && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        e.stopPropagation();
        removeSelectedTrigger();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const edgeEls = graph.edges.map(edge => {
    const d = edgePath(edge, layout.boxes);
    if (!d) return null;
    const dim = highlight && !(highlight.has(edge.from) && highlight.has(edge.to));
    return { edge, d, dim };
  }).filter(Boolean);

  const windowEl = (
      <div
        className={`ecx${floating ? ' ecx--floating' : ''}`}
        role="dialog"
        aria-modal={!floating}
        aria-label="Event cascade"
        style={floating ? { left: floatPos.x, top: floatPos.y } : undefined}
      >
        <div className="ecx__head" onMouseDown={floating ? startMoveWindow : undefined}>
          <div>
            <div className="cse__title">Event Cascade</div>
            <div className="ecx__sub">
              <span className="ecx__now" title="Current time">▶ {fmt(now)}</span>
              {!floating && <> · {graph.events.length} events · {triggerCount} {triggerCount === 1 ? 'trigger' : 'triggers'}</>}
            </div>
          </div>
          {!floating && (
          <>
          <div className="ecx__legend">
            <span>
              <svg width="28" height="10"><path d="M1 5 H20" className="ecx__edge ecx__edge--trigger" /><path d="M19 1.5 L26 5 L19 8.5 z" className="ecx__arrow" /></svg>
              Triggers
            </span>
            <span>
              <svg width="28" height="10"><path d="M1 5 H20" className="ecx__edge ecx__edge--part" /><path d="M19 1.5 L26 5 L19 8.5 z" className="ecx__arrow ecx__arrow--part" /></svg>
              Part of
            </span>
          </div>
          <label className="cse__check">
            <input type="checkbox" checked={connectedOnly} onChange={e => setConnectedOnly(e.target.checked)} />
            Connected only
          </label>
          {editing && selectedEdge && (
            <button className="cse__btn ecx__remove" onClick={removeSelectedTrigger} title="Remove the selected trigger (Delete)">
              Remove trigger
            </button>
          )}
          <button
            className={`cse__btn${editing ? ' cse__btn--primary' : ''}`}
            onClick={() => { setEditing(v => !v); setSelectedEdge(null); setDrag(null); }}
            title="Rewire what triggers what"
          >
            {editing ? 'Done editing' : 'Edit triggers'}
          </button>
          </>
          )}
          <div className="ecx__zoombar">
            <button className="cse__btn" onClick={() => zoomAtCenter(zoom / 1.25)} title="Zoom out (Ctrl + scroll)">−</button>
            <button className="cse__btn ecx__zoomval" onClick={() => zoomAtCenter(1)} title="Reset to 100%">{Math.round(zoom * 100)}%</button>
            <button className="cse__btn" onClick={() => zoomAtCenter(zoom * 1.25)} title="Zoom in (Ctrl + scroll)">+</button>
            <button className="cse__btn" onClick={fitToWindow} title="Zoom out to fit the whole cascade">Fit</button>
          </div>
          <button
            className="cse__btn ecx__collapse"
            onClick={() => { setFloating(v => !v); setEditing(false); setSelectedEdge(null); setDrag(null); }}
            title={floating ? 'Expand to the full view' : 'Collapse into a small movable window to follow the animation'}
          >
            {floating ? 'Expand' : 'Collapse'}
          </button>
          <button className="cse__x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="ecx__canvas" ref={canvasRef}>
          {visibleEvents.length === 0 ? (
            <div className="ev-empty">
              {graph.events.length === 0 ? 'No events yet — add nodes or links to the canvas.' : 'No connected events yet — use Trigger on a node or link.'}
            </div>
          ) : (
            <svg
              ref={svgRef}
              width={Math.max(layout.width, 600) * zoom}
              height={layout.height * zoom}
              viewBox={`0 0 ${Math.max(layout.width, 600)} ${layout.height}`}
              className={`ecx__svg${editing ? ' ecx__svg--editing' : ''}`}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
              onPointerMove={moveWire}
              onPointerUp={endWire}
              onPointerCancel={() => setDrag(null)}
              onPointerDown={() => setSelectedEdge(null)}
            >
              <defs>
                <marker id="ecx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="ecx__arrow" />
                </marker>
                <marker id="ecx-arrow-part" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="ecx__arrow ecx__arrow--part" />
                </marker>
              </defs>

              {layout.looseTop != null && (
                <text x={PAD} y={layout.looseTop + 12} className="ecx__section">Not connected</text>
              )}

              {[...layout.boxes.values()].map(({ event, x, y, w, h, loose }) => {
                const color = EVENT_KIND_COLOR[event.kind] ?? 'var(--text-muted)';
                const dim = !editing && highlight && !highlight.has(event.id);
                const instant = event.end === event.start;
                const dropTarget = drag && drag.fromId !== event.id && TRIGGERABLE_KINDS.has(event.kind);
                const label = event.label.length * 6.2 > w - 18
                  ? `${event.label.slice(0, Math.max(4, Math.floor((w - 18) / 6.2) - 1))}…`
                  : event.label;
                return (
                  <g
                    key={event.id}
                    className={`ecx__box${event.blueprint ? ' ecx__box--blueprint' : ''}${dim ? ' ecx__dim' : ''}${loose ? ' ecx__box--loose' : ''}${dropTarget ? ' ecx__box--target' : ''}${activeIds.has(event.id) ? ' ecx__box--active' : ''}`}
                    onMouseEnter={() => setHovered(event.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <title>
                      {`${EVENT_KINDS[event.kind]?.label ?? event.kind}: ${event.label}${event.detail ? ` ${event.detail}` : ''}\n${event.blueprint ? 'Blueprint: always visible. Drag a trigger onto it to animate it.' : instant ? fmt(event.start) : `${fmt(event.start)} – ${fmt(event.end)}`}`}
                    </title>
                    <rect x={x} y={y} width={w} height={h} rx={7} className="ecx__rect" style={{ stroke: color }} />
                    <rect x={x} y={y} width={4} height={h} rx={2} style={{ fill: color }} />
                    <text x={x + 11} y={y + 16} className="ecx__kind" style={{ fill: color }}>
                      {EVENT_KINDS[event.kind]?.label ?? event.kind}
                      {/* Blueprint items are always on screen until something triggers them. */}
                      <tspan className="ecx__time" dx="6">{event.blueprint ? 'blueprint' : instant ? fmt(event.start) : `${fmt(event.start)}–${fmt(event.end)}`}</tspan>
                    </text>
                    <text x={x + 11} y={y + 31} className="ecx__label">{label}</text>
                  </g>
                );
              })}

              {/* Edit mode: wide invisible hit areas so trigger arrows are easy to click. */}
              {editing && (
                <g>
                  {edgeEls.filter(({ edge }) => edge.kind === 'trigger').map(({ edge, d }) => (
                    <path
                      key={`hit-${edge.id}`}
                      d={d}
                      className="ecx__hit"
                      onPointerDown={e => { e.stopPropagation(); setSelectedEdge(edge.id); }}
                    />
                  ))}
                </g>
              )}

              {/* Lines go on top of the boxes, each with a dark halo so they stay readable. */}
              <g className="ecx__edges">
                {edgeEls.map(({ edge, d, dim }) => (
                  <path key={`halo-${edge.id}`} d={d} className={`ecx__halo${dim ? ' ecx__dim' : ''}`} />
                ))}
                {edgeEls.map(({ edge, d, dim }) => (
                  <path
                    key={edge.id}
                    d={d}
                    className={`ecx__edge ecx__edge--${edge.kind}${dim ? ' ecx__dim' : ''}${highlight && !dim ? ' ecx__edge--hot' : ''}${edge.id === selectedEdge ? ' ecx__edge--selected' : ''}`}
                    markerEnd={edge.kind === 'trigger' ? 'url(#ecx-arrow)' : 'url(#ecx-arrow-part)'}
                  />
                ))}
              </g>

              {editing && [...layout.boxes.values()].map(({ event, x, y, w, h }) => (
                <circle
                  key={`handle-${event.id}`}
                  cx={x + w}
                  cy={y + h / 2}
                  r={6}
                  className="ecx__handle"
                  onPointerDown={e => startWire(e, event.id)}
                >
                  <title>Drag onto a node, link or failure to trigger it with this event</title>
                </circle>
              ))}

              {drag && (() => {
                const from = layout.boxes.get(drag.fromId);
                if (!from) return null;
                return (
                  <path
                    d={`M ${from.x + from.w} ${from.y + from.h / 2} L ${drag.x} ${drag.y}`}
                    className="ecx__edge ecx__edge--trigger ecx__wire"
                    markerEnd="url(#ecx-arrow)"
                  />
                );
              })()}
            </svg>
          )}
        </div>
      </div>
  );

  return createPortal(
    floating ? windowEl : (
      <div className="cse__backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        {windowEl}
      </div>
    ),
    document.body
  );
}