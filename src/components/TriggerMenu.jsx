import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useStore from '../store/useStore';
import { EVENT_KINDS, buildProjectEvents } from '../events/projectEvents';
import { EVENT_KIND_COLOR } from '../events/eventColors';

// The event id a node or link is currently triggered by (a node's link trigger is the
// link's draw event).
export function getNodeTriggerEventId(item) {
  if (item?.triggerAfterLinkId) return `link:${item.triggerAfterLinkId}`;
  return item?.triggerEventId ?? null;
}

const fmt = t => `${t.toFixed(2)}s`;

// "Trigger" button for the timeline bar. Opens a list of the project's events;
// picking one makes the node (or link) start when that event happens.
export default function TriggerMenu({ node, ownerKind = 'node', onSelect }) {
  // Read the live project so newly added links, tokens, morphs, … are always listed.
  const nodes = useStore(state => state.nodes);
  const links = useStore(state => state.links);
  const [menu, setMenu] = useState(null);
  const [query, setQuery] = useState('');
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const currentId = getNodeTriggerEventId(node);

  // Every event is listed and selectable (same list as the Events dropdown). Loops are
  // allowed; the engine stops resolving a trigger cycle after a few passes.
  const events = useMemo(() => {
    if (!menu) return [];
    try {
      return buildProjectEvents(nodes, links);
    } catch (err) {
      console.error('[TriggerMenu] could not build events:', err);
      return [];
    }
  }, [menu, nodes, links]);

  const q = query.trim().toLowerCase();
  const visible = events.filter(event => (
    !q || `${event.label} ${event.detail ?? ''} ${EVENT_KINDS[event.kind]?.label ?? ''}`.toLowerCase().includes(q)
  ));
  const current = currentId ? events.find(event => event.id === currentId) : null;

  const toggle = () => {
    if (menu) { setMenu(null); return; }
    // Start each opening with the full list (a search left over from last time would
    // otherwise hide everything added since).
    setQuery('');
    const rect = btnRef.current.getBoundingClientRect();
    const width = 440;
    setMenu({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      // The timeline sits at the bottom of the window, so open upwards.
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.max(200, rect.top - 16),
    });
  };

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = e => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = e => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const pick = event => {
    onSelect(event);
    setMenu(null);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className={`tl-btn${currentId ? ' tl-btn--accent' : ''}${menu ? ' tl-btn--pressed' : ''}`}
        title={currentId ? 'Triggered by an event — click to change' : `Start this ${ownerKind} when an event happens`}
      >
        Trigger
      </button>

      {menu && createPortal(
        <div
          ref={popRef}
          className="tl-pop trg-pop"
          style={{ left: menu.left, bottom: menu.bottom, width: 440, maxHeight: menu.maxHeight }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="tl-pop__head">
            <span>Trigger on event</span>
            <button className="tl-pop__close" onClick={() => setMenu(null)} title="Close">✕</button>
          </div>
          <input
            autoFocus
            className="ev-search trg-search"
            placeholder="Search events…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {currentId && !current && (
            <div className="tl-hint" style={{ fontSize: 11 }}>The current trigger event no longer exists.</div>
          )}

          <div className="trg-list">
            <button className={`trg-row${!currentId ? ' trg-row--active' : ''}`} onClick={() => pick(null)}>
              <span className="trg-kind" style={{ color: 'var(--text-dim)' }}>None</span>
              <span className="trg-label">Not triggered — runs at its own time</span>
              <span className="trg-time" />
            </button>
            {visible.map(event => {
              const active = event.id === currentId;
              return (
                <button
                  key={event.id}
                  className={`trg-row${active ? ' trg-row--active' : ''}`}
                  onClick={() => pick(event)}
                >
                  <span className="trg-kind" style={{ color: EVENT_KIND_COLOR[event.kind] }}>{EVENT_KINDS[event.kind]?.label ?? event.kind}</span>
                  <span className="trg-label" title={`${event.label}${event.detail ? ` ${event.detail}` : ''}`}>
                    {event.label}
                    {event.detail && <span className="ev-detail"> {event.detail}</span>}
                  </span>
                  <span className="trg-time">
                    {fmt(event.start)}{event.end !== event.start ? ` – ${fmt(event.end)}` : ''}
                  </span>
                </button>
              );
            })}
            {visible.length === 0 && <div className="ev-empty">No events match.</div>}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
