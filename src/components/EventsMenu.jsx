import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store/useStore';
import { EVENT_KINDS, buildProjectEvents } from '../events/projectEvents';
import { EVENT_KIND_COLOR as KIND_COLOR } from '../events/eventColors';
import EventCascade from './EventCascade';
import { applyEventFile, buildEventFile } from '../events/eventFile';


const fmt = t => `${t.toFixed(2)}s`;

const SORTERS = {
  start: (a, b) => a.start - b.start || a.end - b.end,
  end: (a, b) => a.end - b.end || a.start - b.start,
  event: (a, b) => (EVENT_KINDS[a.kind]?.label ?? a.kind).localeCompare(EVENT_KINDS[b.kind]?.label ?? b.kind)
    || a.label.localeCompare(b.label)
    || a.start - b.start,
};

// Top-bar "Events" button: a read-only list of every timed thing in the project.
export default function EventsMenu({ open, onToggle, onClose }) {
  const nodes = useStore(state => state.nodes);
  const links = useStore(state => state.links);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 52 });
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [cascadeOpen, setCascadeOpen] = useState(false);
  const [importReport, setImportReport] = useState(null); // { changes, problems } or { error }
  const fileInputRef = useRef(null);
  const projectName = useStore(state => state.activeProject?.name ?? 'project');

  const exportEventsFile = () => {
    const file = buildEventFile(nodes, links, { projectName });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/[^a-z0-9_\-]/gi, '_')}.events.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Applies an edited events file to the project (one undo step).
  const importEventsFile = (e) => {
    const input = e.target;
    const selected = input.files?.[0];
    input.value = '';
    if (!selected) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const store = useStore.getState();
        const result = applyEventFile(store.nodes, store.links, JSON.parse(String(reader.result)));
        if (result.changes.length) {
          store._pushHistory();
          useStore.setState({ nodes: result.nodes, links: result.links });
        }
        setImportReport({ changes: result.changes, problems: result.problems });
      } catch (err) {
        setImportReport({ error: `Couldn't read the file: ${err.message}` });
      }
    };
    reader.readAsText(selected);
  };
  const [sort, setSort] = useState({ key: 'start', dir: 1 });
  const toggleSort = key => setSort(prev => (
    prev.key === key ? { key, dir: -prev.dir } : { key, dir: 1 }
  ));

  const events = useMemo(() => {
    if (!open) return [];
    try {
      return buildProjectEvents(nodes, links);
    } catch (err) {
      console.error('[EventsMenu] could not build events:', err);
      return [];
    }
  }, [open, nodes, links]);

  const kindsPresent = useMemo(() => [...new Set(events.map(e => e.kind))], [events]);
  const q = query.trim().toLowerCase();
  const visible = events
    .filter(event => (
      (kindFilter === 'all' || event.kind === kindFilter)
      && (!q || `${event.label} ${event.detail ?? ''} ${EVENT_KINDS[event.kind]?.label ?? ''}`.toLowerCase().includes(q))
    ))
    .sort((a, b) => SORTERS[sort.key](a, b) * sort.dir);
  const sortHeader = (key, label) => (
    <button
      className={`ev-sort${sort.key === key ? ' ev-sort--active' : ''}`}
      onClick={() => toggleSort(key)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      <span className="ev-sort__arrow">{sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
    </button>
  );

  useEffect(() => {
    if (!open) return undefined;
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 480;
      setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom });
    }
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
      <button
        ref={btnRef}
        onClick={onToggle}
        className={`ev-btn${open ? ' ev-btn--open' : ''}`}
        title="Everything in the project with a start and end time"
      >
        Events
      </button>

      {cascadeOpen && <EventCascade onClose={() => setCascadeOpen(false)} />}

      {open && (
        <div ref={panelRef} className="ev-panel" style={{ left: pos.left, top: pos.top }}>
          <div className="ev-head">
            <span className="ev-title">Events <span className="ev-count">{events.length}</span></span>
            <button
              className="ev-cascade-btn"
              onClick={() => { setCascadeOpen(true); onClose(); }}
              title="See how events trigger each other"
            >
              View Event Cascade
            </button>
            <div className="ev-filters">
              <input
                className="ev-search"
                placeholder="Search…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <select className="ev-select" value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
                <option value="all">All kinds</option>
                {kindsPresent.map(kind => (
                  <option key={kind} value={kind}>{EVENT_KINDS[kind]?.label ?? kind}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ev-filebar">
            <button className="ev-filebtn" onClick={exportEventsFile} title="Download the events as an editable JSON file">
              Export events file
            </button>
            <button className="ev-filebtn" onClick={() => fileInputRef.current?.click()} title="Apply an edited events file to the project">
              Import events file
            </button>
            <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importEventsFile} />
          </div>
          {importReport && (
            <div className={`ev-report${importReport.error || importReport.problems?.length ? ' ev-report--warn' : ''}`}>
              <div className="ev-report__head">
                <span>
                  {importReport.error
                    ?? (importReport.changes.length
                      ? `Applied ${importReport.changes.length} ${importReport.changes.length === 1 ? 'change' : 'changes'}`
                      : 'No changes to apply')}
                </span>
                <button className="tl-pop__close" onClick={() => setImportReport(null)} title="Dismiss">✕</button>
              </div>
              {importReport.problems?.map((problem, i) => <div key={i} className="ev-report__line">{problem}</div>)}
            </div>
          )}

          <div className="ev-cols">
            {sortHeader('event', 'Event')}
            {sortHeader('start', 'Start')}
            {sortHeader('end', 'End')}
          </div>

          <div className="ev-list">
            {visible.length === 0 && (
              <div className="ev-empty">
                {events.length === 0 ? 'No events yet — add nodes or links to the canvas.' : 'No events match.'}
              </div>
            )}
            {visible.map(event => (
              <div key={event.id} className="ev-row" title={`${EVENT_KINDS[event.kind]?.label ?? event.kind}: ${event.label}${event.detail ? ` ${event.detail}` : ''}`}>
                <div className="ev-main">
                  <span className="ev-kind" style={{ color: KIND_COLOR[event.kind] ?? 'var(--text-muted)' }}>
                    <span className="ev-dot" />
                    {EVENT_KINDS[event.kind]?.label ?? event.kind}
                  </span>
                  <span className="ev-label">
                    {event.label}
                    {event.detail && <span className="ev-detail"> {event.detail}</span>}
                  </span>
                </div>
                <span className="ev-time">{fmt(event.start)}</span>
                <span className="ev-time">{event.end === event.start ? '—' : fmt(event.end)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
