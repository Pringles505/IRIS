import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuid } from 'uuid';
import ShapePreview from './ShapePreview';
import {
  MIN_CUSTOM_VERTICES, anchorAtPosition, customShapeFromBase, getAnchorPosition, getCustomShapeOutline,
  normalizeCustomShape, outlineToSvgPath, projectOntoOutline,
} from '../shapes/customShape';

const BASE_SHAPES = [
  { key: 'rectangle', label: 'Rectangle' },
  { key: 'rounded', label: 'Rounded' },
  { key: 'pill', label: 'Pill' },
  { key: 'cylinder', label: 'Cylinder' },
  { key: 'diamond', label: 'Diamond' },
  { key: 'hexagon', label: 'Hexagon' },
  { key: 'slanted', label: 'Slanted' },
  { key: 'circle', label: 'Circle' },
  { key: 'protocol', label: 'Protocol' },
];

const CANVAS_W = 540;
const CANVAS_H = 360;
const MARGIN = 44;
const GRID = 0.05;
const clamp01 = v => Math.max(0, Math.min(1, v));

// The node's built-in side anchors (the default link ports), placed on the outline.
function buildDefaultAnchors(shape, width, height) {
  const outline = getCustomShapeOutline(shape, width, height);
  return [
    { x: 0.5, y: 0 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
    { x: 0, y: 0.5 },
  ].map(({ x, y }) => {
    const p = projectOntoOutline(outline, x * width, y * height);
    return { id: uuid(), isDefault: true, x: clamp01(p.x / width), y: clamp01(p.y / height) };
  });
}

// Centered dialog for drawing a node's outline and placing its link anchors.
// Shape mode: drag points, add points on edges, delete points, round the corners,
// or start over from any built-in shape. Anchors mode: click to place an anchor
// (snapped onto the outline unless Alt is held), drag to move, delete.
export default function CustomShapeEditor({
  initial, baseShape = 'rounded', width = 150, height = 52, fill, stroke,
  anchors: initialAnchors = [], customAnchorsOnly = false, onApply, onClose,
}) {
  // Shape and anchors share one undo history. While anchorMode is 'default' the node keeps
  // its default side anchors; the first anchor edit switches to 'custom', replacing them.
  const [doc, setDoc] = useState(() => {
    const shape = normalizeCustomShape(initial) ?? customShapeFromBase(baseShape, width, height);
    const existing = (initialAnchors ?? []).map(anchor => ({ ...anchor, ...getAnchorPosition(anchor, width, height) }));
    return {
      shape,
      anchorMode: customAnchorsOnly ? 'custom' : 'default',
      anchorsTouched: false,
      anchors: customAnchorsOnly ? existing : [...buildDefaultAnchors(shape, width, height), ...existing],
    };
  });
  const { shape, anchors } = doc;
  // Any anchor edit replaces the default anchors with the edited set.
  const editedAnchors = (d, nextAnchors) => ({ ...d, anchors: nextAnchors, anchorMode: 'custom', anchorsTouched: true });
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState('shape');
  const [selected, setSelected] = useState(null);       // point index
  const [selectedAnchor, setSelectedAnchor] = useState(null); // anchor id
  const [snap, setSnap] = useState(true);
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const scale = Math.min((CANVAS_W - MARGIN * 2) / width, (CANVAS_H - MARGIN * 2) / height);
  const boxW = width * scale;
  const boxH = height * scale;
  const ox = (CANVAS_W - boxW) / 2;
  const oy = (CANVAS_H - boxH) / 2;
  const toScreen = p => ({ x: ox + p.x * boxW, y: oy + p.y * boxH });
  const outline = getCustomShapeOutline(shape, boxW, boxH);

  const pushHistory = useCallback(() => setHistory(h => [...h.slice(-49), doc]), [doc]);
  const commit = useCallback((next) => {
    pushHistory();
    setDoc(next);
  }, [pushHistory]);
  const setShape = updater => setDoc(d => ({ ...d, shape: typeof updater === 'function' ? updater(d.shape) : updater }));

  const undo = useCallback(() => {
    if (!history.length) return;
    setDoc(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setSelected(null);
    setSelectedAnchor(null);
  }, [history]);

  const removePoint = useCallback((index) => {
    if (index == null || shape.points.length <= MIN_CUSTOM_VERTICES) return;
    commit({ ...doc, shape: { ...shape, points: shape.points.filter((_, i) => i !== index) } });
    setSelected(null);
  }, [commit, doc, shape]);

  const removeAnchor = useCallback((id) => {
    if (id == null) return;
    commit(editedAnchors(doc, anchors.filter(anchor => anchor.id !== id)));
    setSelectedAnchor(null);
  }, [anchors, commit, doc]);

  const pointerToBox = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (CANVAS_W / rect.width) - ox,
      y: (e.clientY - rect.top) * (CANVAS_H / rect.height) - oy,
    };
  };

  const pointerToShape = (e) => {
    const p = pointerToBox(e);
    let x = clamp01(p.x / boxW);
    let y = clamp01(p.y / boxH);
    if (snap && !e.altKey) {
      x = Math.round(x / GRID) * GRID;
      y = Math.round(y / GRID) * GRID;
    }
    return { x, y };
  };

  // Anchors sit on the outline by default; Alt places them anywhere in the node box.
  const pointerToAnchor = (e) => {
    const p = pointerToBox(e);
    const placed = e.altKey ? p : projectOntoOutline(outline, p.x, p.y);
    return { x: clamp01(placed.x / boxW), y: clamp01(placed.y / boxH) };
  };

  const beginDrag = (e, target, nextDoc) => {
    e.preventDefault();
    e.stopPropagation();
    svgRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { ...target, moved: false };
    if (nextDoc) commit(nextDoc);
    else pushHistory();
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved = true;
    if (drag.anchorId) {
      const p = pointerToAnchor(e);
      setDoc(d => editedAnchors(d, d.anchors.map(a => (a.id === drag.anchorId ? { ...a, ...p } : a))));
      return;
    }
    const p = pointerToShape(e);
    setShape(s => ({ ...s, points: s.points.map((pt, i) => (i === drag.index ? p : pt)) }));
  };

  const endDrag = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture?.(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    // A click without movement shouldn't leave an extra undo step behind.
    if (!drag.moved && !drag.created) setHistory(h => h.slice(0, -1));
  };

  const insertAt = (e, edgeIndex) => {
    const a = shape.points[edgeIndex];
    const b = shape.points[(edgeIndex + 1) % shape.points.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const points = [...shape.points.slice(0, edgeIndex + 1), mid, ...shape.points.slice(edgeIndex + 1)];
    setSelected(edgeIndex + 1);
    beginDrag(e, { index: edgeIndex + 1, created: true }, { ...doc, shape: { ...shape, points } });
  };

  const onCanvasPointerDown = (e) => {
    if (mode !== 'anchors') {
      setSelected(null);
      return;
    }
    // Click empty space in anchor mode: place a new anchor and keep dragging it.
    const id = uuid();
    const p = pointerToAnchor(e);
    setSelectedAnchor(id);
    beginDrag(e, { anchorId: id, created: true }, editedAnchors(doc, [...anchors, { id, ...p }]));
  };

  const fitAnchorsToOutline = () => {
    commit(editedAnchors(doc, anchors.map(anchor => {
      const p = projectOntoOutline(outline, anchor.x * boxW, anchor.y * boxH);
      return { ...anchor, x: clamp01(p.x / boxW), y: clamp01(p.y / boxH) };
    })));
  };

  const restoreDefaultAnchors = () => {
    commit({
      ...doc,
      anchorMode: 'default',
      anchorsTouched: true,
      anchors: [...buildDefaultAnchors(shape, width, height), ...anchors.filter(anchor => !anchor.isDefault)],
    });
    setSelectedAnchor(null);
  };

  const apply = useCallback(() => {
    // Untouched anchors are left exactly as they were on the node.
    if (!doc.anchorsTouched) {
      onApply(shape, {});
      return;
    }
    const custom = doc.anchorMode === 'custom';
    const toStored = ({ x, y, isDefault, ...rest }) => ({ ...rest, ...anchorAtPosition(x, y, width, height) });
    onApply(shape, {
      // In default mode the built-in anchors stay implicit; only extra anchors are stored.
      anchors: anchors.filter(anchor => custom || !anchor.isDefault).map(toStored),
      customAnchorsOnly: custom,
    });
  }, [anchors, doc.anchorMode, doc.anchorsTouched, height, onApply, shape, width]);

  // Capture keys before the editor's global shortcuts (Delete would remove the node).
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (typing) { e.stopPropagation(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (mode === 'anchors') removeAnchor(selectedAnchor);
        else removePoint(selected);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [apply, mode, onClose, removeAnchor, removePoint, selected, selectedAnchor, undo]);

  const screenPts = shape.points.map(toScreen);
  const gridLines = [];
  for (let t = 0; t <= 1.0001; t += 0.1) {
    gridLines.push(
      <line key={`v${t}`} x1={ox + t * boxW} y1={oy} x2={ox + t * boxW} y2={oy + boxH} className="cse__grid" />,
      <line key={`h${t}`} x1={ox} y1={oy + t * boxH} x2={ox + boxW} y2={oy + t * boxH} className="cse__grid" />,
    );
  }
  const shapeMode = mode === 'shape';

  return createPortal(
    <div className="cse__backdrop" onMouseDown={e => e.stopPropagation()}>
      <div className="cse" role="dialog" aria-modal="true" aria-label="Custom shape editor">
        <div className="cse__head">
          <div className="cse__title">Custom shape</div>
          <div className="cse__modes" role="tablist">
            <button role="tab" aria-selected={shapeMode} className={`cse__mode${shapeMode ? ' cse__mode--on' : ''}`} onClick={() => setMode('shape')}>
              Shape
            </button>
            <button role="tab" aria-selected={!shapeMode} className={`cse__mode${!shapeMode ? ' cse__mode--on' : ''}`} onClick={() => setMode('anchors')}>
              Anchors <span className="cse__mode-count">{anchors.length}</span>
            </button>
          </div>
          <button className="cse__x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="cse__body">
          <svg
            ref={svgRef}
            className={`cse__canvas${shapeMode ? '' : ' cse__canvas--anchors'}`}
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerDown={onCanvasPointerDown}
          >
            {gridLines}
            <rect x={ox} y={oy} width={boxW} height={boxH} className="cse__bounds" />
            <g transform={`translate(${ox} ${oy})`}>
              <path d={outlineToSvgPath(outline)} fill={fill} stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
            </g>
            {shape.rounding > 0 && (
              <polygon points={screenPts.map(p => `${p.x},${p.y}`).join(' ')} className="cse__frame" />
            )}

            {shapeMode && screenPts.map((a, i) => {
              const b = screenPts[(i + 1) % screenPts.length];
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              return (
                <g key={`mid-${i}`} className="cse__mid" onPointerDown={e => insertAt(e, i)}>
                  <title>Add a point here</title>
                  <circle cx={mx} cy={my} r={7} />
                  <path d={`M ${mx - 3} ${my} H ${mx + 3} M ${mx} ${my - 3} V ${my + 3}`} />
                </g>
              );
            })}

            {screenPts.map((p, i) => (
              <circle
                key={`pt-${i}`}
                cx={p.x}
                cy={p.y}
                r={shapeMode && selected === i ? 7.5 : shapeMode ? 6 : 3.5}
                className={`cse__pt${shapeMode && selected === i ? ' cse__pt--sel' : ''}${shapeMode ? '' : ' cse__pt--muted'}`}
                onPointerDown={shapeMode ? (e => { setSelected(i); beginDrag(e, { index: i }); }) : undefined}
                onDoubleClick={shapeMode ? (e => { e.stopPropagation(); removePoint(i); }) : undefined}
              >
                {shapeMode && <title>Point {i + 1} — drag to move, double-click to delete</title>}
              </circle>
            ))}

            {anchors.map((anchor, i) => {
              const p = toScreen(anchor);
              const isSel = !shapeMode && selectedAnchor === anchor.id;
              const isDefault = anchor.isDefault && doc.anchorMode === 'default';
              const r = isSel ? 7 : 5.5;
              return (
                <g
                  key={anchor.id}
                  className={`cse__anchor${isSel ? ' cse__anchor--sel' : ''}${shapeMode ? ' cse__anchor--muted' : ''}${isDefault ? ' cse__anchor--default' : ''}`}
                  onPointerDown={shapeMode ? undefined : (e => { setSelectedAnchor(anchor.id); beginDrag(e, { anchorId: anchor.id }); })}
                  onDoubleClick={shapeMode ? undefined : (e => { e.stopPropagation(); removeAnchor(anchor.id); })}
                >
                  {!shapeMode && <title>{isDefault ? 'Default anchor — editing any anchor replaces the defaults' : `Anchor ${i + 1} — drag to move, double-click to delete`}</title>}
                  <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} transform={`rotate(45 ${p.x} ${p.y})`} />
                </g>
              );
            })}
          </svg>

          <div className="cse__side">
            {shapeMode ? (
              <>
                <div className="cse__section">Start from</div>
                <div className="cse__bases">
                  {BASE_SHAPES.map(base => (
                    <button
                      key={base.key}
                      className="cse__base"
                      title={`Replace the outline with a ${base.label.toLowerCase()}`}
                      onClick={() => { commit({ ...doc, shape: customShapeFromBase(base.key, width, height) }); setSelected(null); }}
                    >
                      <ShapePreview shape={base.key} fill={fill} stroke={stroke} boxW={40} boxH={24} />
                      <span>{base.label}</span>
                    </button>
                  ))}
                </div>

                <div className="cse__section">Corners</div>
                <label className="cse__slider">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={shape.rounding}
                    onPointerDown={pushHistory}
                    onChange={e => setShape(s => ({ ...s, rounding: Number(e.target.value) }))}
                  />
                  <span>{Math.round(shape.rounding * 100)}%</span>
                </label>

                <div className="cse__section">Points</div>
                <div className="cse__row">
                  <span className="cse__count">{shape.points.length} points</span>
                  <button
                    className="cse__btn"
                    disabled={selected == null || shape.points.length <= MIN_CUSTOM_VERTICES}
                    onClick={() => removePoint(selected)}
                    title="Delete the selected point (Delete)"
                  >
                    Delete point
                  </button>
                </div>
                <label className="cse__check">
                  <input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} />
                  Snap to grid <span className="cse__hint">(hold Alt to move freely)</span>
                </label>
              </>
            ) : (
              <>
                <div className="cse__section">Anchors</div>
                <div className="cse__row">
                  <span className="cse__count">{anchors.length} {anchors.length === 1 ? 'anchor' : 'anchors'}</span>
                  <button
                    className="cse__btn"
                    disabled={selectedAnchor == null}
                    onClick={() => removeAnchor(selectedAnchor)}
                    title="Delete the selected anchor (Delete)"
                  >
                    Delete anchor
                  </button>
                </div>
                <span className="cse__hint">
                  {doc.anchorMode === 'default'
                    ? 'Showing the default anchors. Editing any anchor replaces them with your own.'
                    : 'Custom anchors replace the default ones on this node.'}
                </span>
                <button
                  className="cse__btn"
                  disabled={!anchors.length}
                  onClick={fitAnchorsToOutline}
                  title="Move every anchor onto the nearest point of the outline"
                >
                  Fit anchors to outline
                </button>
                <button
                  className="cse__btn"
                  disabled={doc.anchorMode === 'default'}
                  onClick={restoreDefaultAnchors}
                  title="Bring back the node's default top/right/bottom/left anchors"
                >
                  Restore default anchors
                </button>
                {selectedAnchor && (() => {
                  const anchor = anchors.find(a => a.id === selectedAnchor);
                  if (!anchor) return null;
                  const setPos = (key, value) => {
                    if (!Number.isFinite(value)) return;
                    commit(editedAnchors(doc, anchors.map(a => (a.id === anchor.id ? { ...a, [key]: clamp01(value / 100) } : a))));
                  };
                  return (
                    <div className="cse__pos">
                      <label>X <input type="number" step={1} min={0} max={100} value={Math.round(anchor.x * 1000) / 10} onChange={e => setPos('x', Number(e.target.value))} />%</label>
                      <label>Y <input type="number" step={1} min={0} max={100} value={Math.round(anchor.y * 1000) / 10} onChange={e => setPos('y', Number(e.target.value))} />%</label>
                    </div>
                  );
                })()}
              </>
            )}
            <button className="cse__btn" disabled={!history.length} onClick={undo} title="Undo (Ctrl+Z)">
              Undo
            </button>
          </div>
        </div>

        <div className="cse__foot">
          <button className="cse__btn" onClick={onClose}>Cancel</button>
          <button className="cse__btn cse__btn--primary" onClick={apply}>Apply shape</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
