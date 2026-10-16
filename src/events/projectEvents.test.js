import { describe, expect, it } from 'vitest';
import { buildProjectEvents } from './projectEvents';

const node = (id, overrides = {}) => ({
  id, type: 'node', label: id, x: 0, y: 0, width: 100, height: 50, ...overrides,
});
const link = (id, fromId, toId, overrides = {}) => ({ id, fromId, toId, joints: [], ...overrides });

describe('buildProjectEvents', () => {
  it('lists node fade-ins and link draws with start and end times', () => {
    const events = buildProjectEvents([node('a'), node('b')], [link('l', 'a', 'b')]);
    const kinds = events.map(e => e.kind);
    expect(kinds.filter(k => k === 'node')).toHaveLength(2);
    expect(kinds).toContain('link');
    for (const event of events) expect(event.end).toBeGreaterThanOrEqual(event.start);
  });

  it('includes morphs, failures and manual tokens with their times', () => {
    const events = buildProjectEvents(
      [
        node('a', {
          textMorphs: [{ id: 'm', text: 'Hi', mode: 'fade', startTime: 3, duration: 0.5 }],
          failureKeyframes: [{ id: 'f', startTime: 5, duration: 1 }],
        }),
        node('b'),
      ],
      [link('l', 'a', 'b', {
        manualTokenEnabled: true,
        manualTokenTextKeyframes: [{ id: 'k', time: 2, text: 'K2' }],
        failureKeyframes: [{ id: 'lf', startTime: 6, duration: 0.5 }],
      })]
    );
    const byKind = kind => events.filter(e => e.kind === kind);
    expect(byKind('morph')[0]).toMatchObject({ ownerId: 'a', start: 3, end: 3.5 });
    expect(byKind('failure').map(e => e.ownerKind).sort()).toEqual(['link', 'node']);
    expect(byKind('token')).toHaveLength(1);
    expect(byKind('token-text')[0]).toMatchObject({ start: 2, end: 2 });
  });

  it('sorts events by start time', () => {
    const events = buildProjectEvents([node('a'), node('b'), node('c')], [link('l1', 'a', 'b'), link('l2', 'b', 'c')]);
    const starts = events.map(e => e.start);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });
});

import { buildEventGraph } from './projectEvents';

describe('buildEventGraph', () => {
  it('connects the cascade: link triggers a node, its token triggers another link', () => {
    const { edges } = buildEventGraph(
      [node('n1'), node('n2'), node('n3', { triggerAfterLinkId: 'l12' })],
      [
        link('l12', 'n1', 'n2', { manualTokenEnabled: true }),
        link('l21', 'n2', 'n1', { triggerEventId: 'token:l12' }),
      ]
    );
    const pairs = edges.map(e => `${e.kind} ${e.from} -> ${e.to}`);
    expect(pairs).toContain('trigger link:l12 -> node:n3');
    expect(pairs).not.toContain('part link:l12 -> token:l12');
    expect(pairs).toContain('trigger token:l12 -> link:l21');
  });

  it('only connects events that exist', () => {
    const { edges } = buildEventGraph([node('a', { triggerEventId: 'failure:gone:f' })], []);
    expect(edges).toEqual([]);
  });
});

import { EVENT_KINDS } from './projectEvents';
import { EVENT_KIND_COLOR } from './eventColors';

describe('event colors', () => {
  it('gives every event kind its own color', () => {
    const colors = Object.keys(EVENT_KINDS).map(kind => EVENT_KIND_COLOR[kind]);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

import { resolveTriggeredKeyframes } from './triggeredKeyframes';

describe('triggered failures', () => {
  it('starts a link failure when its link finishes drawing, without moving the link', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('l', 'a', 'b', {
      animStartTime: 1,
      animDuration: 0.5,
      failureKeyframes: [{ id: 'f', startTime: 0, duration: 0.8, triggerEventId: 'link:l' }],
    })];
    const { links: resolved, changed } = resolveTriggeredKeyframes(nodes, links);
    expect(changed).toBe(true);
    expect(resolved[0].failureKeyframes[0].startTime).toBeCloseTo(1.5);
    expect(resolved[0].animStartTime).toBe(1);
  });

  it('records the trigger as a connection in the event graph', () => {
    const { edges } = buildEventGraph(
      [node('a'), node('b')],
      [link('l', 'a', 'b', { failureKeyframes: [{ id: 'f', startTime: 2, duration: 0.8, triggerEventId: 'link:l' }] })]
    );
    expect(edges.map(e => `${e.kind} ${e.from} -> ${e.to}`)).toContain('trigger link:l -> failure:l:f');
  });
});

describe('failure trigger connections', () => {
  it('shows a failure triggered by another event only under that trigger', () => {
    const { edges } = buildEventGraph(
      [node('a', { failureKeyframes: [{ id: 'nf', startTime: 4, duration: 1 }] }), node('b')],
      [link('l', 'a', 'b', { failureKeyframes: [{ id: 'f', startTime: 5, duration: 0.8, triggerEventId: 'failure:a:nf' }] })]
    );
    const pairs = edges.map(e => `${e.kind} ${e.from} -> ${e.to}`);
    expect(pairs).toContain('trigger failure:a:nf -> failure:l:f');
    expect(pairs).not.toContain('part link:l -> failure:l:f');
  });
});

describe('tokens finish before the next event', () => {
  const tok = { manualTokenEnabled: true, manualTokenDuration: 2 };
  const at = (events, id) => events.find(e => e.id === id);

  it('a node triggered by a link waits for the link token to arrive', () => {
    const events = buildProjectEvents([node('a'), node('b', { triggerAfterLinkId: 'l' })], [link('l', 'a', 'b', tok)]);
    expect(at(events, 'node:b').start).toBeGreaterThanOrEqual(at(events, 'token:l').end - 1e-6);
  });

  it('the next link in the sequence waits for the token', () => {
    const events = buildProjectEvents([node('a'), node('b'), node('c')], [link('l', 'a', 'b', tok), link('m', 'b', 'c')]);
    expect(at(events, 'link:m').start).toBeGreaterThanOrEqual(at(events, 'token:l').end - 1e-6);
  });

  it('an item triggered by a link draw event waits for its token', () => {
    const events = buildProjectEvents(
      [node('a'), node('b'), node('c')],
      [link('l', 'a', 'b', tok), link('m', 'b', 'c', { triggerEventId: 'link:l' })]
    );
    expect(at(events, 'link:m').start).toBeGreaterThanOrEqual(at(events, 'token:l').end - 1e-6);
  });

  it('a token with its own trigger does not hold back its link', () => {
    const events = buildProjectEvents(
      [node('a'), node('b', { triggerAfterLinkId: 'l' }), node('c', { animStartTime: 10 })],
      [link('l', 'a', 'b', { ...tok, manualTokenTriggerEventId: 'node:c' })]
    );
    expect(at(events, 'node:b').start).toBeLessThan(at(events, 'token:l').end);
  });
});

describe('long trigger chains', () => {
  it('settles chains of any length in order, then waits for the token', () => {
    const N = 10;
    const nodes = [node('n0')];
    const links = [];
    for (let i = 1; i <= N; i += 1) {
      links.push(link(`l${i}`, `n${i - 1}`, `n${i}`, {
        triggerEventId: `node:n${i - 1}`,
        ...(i === N ? { manualTokenEnabled: true, manualTokenDuration: 2 } : {}),
      }));
      nodes.push(node(`n${i}`, { triggerAfterLinkId: `l${i}` }));
    }
    nodes.push(node('after', { triggerEventId: `token:l${N}` }));
    // Listed last-first, the worst order for resolving the chain.
    const events = buildProjectEvents([...nodes].reverse(), [...links].reverse());
    const at = id => events.find(e => e.id === id);
    for (let i = 1; i <= N; i += 1) {
      expect(at(`link:l${i}`).start).toBeCloseTo(at(`node:n${i - 1}`).end, 2);
    }
    expect(at('node:after').start).toBeCloseTo(at(`token:l${N}`).end, 2);
  });
});
