import { describe, expect, it } from 'vitest';
import { AnimationEngine } from './AnimationEngine';

const node = (id, overrides = {}) => ({
  id,
  type: 'node',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  label: id,
  ...overrides,
});

const link = (id, fromId, toId, overrides = {}) => ({
  id,
  fromId,
  toId,
  joints: [],
  ...overrides,
});

const eventById = (engine, id) => engine.getTimeline().find(ev => ev.id === id);

describe('AnimationEngine timeline', () => {
  it('sequences free nodes one after another from the initial delay', () => {
    const engine = new AnimationEngine([node('a'), node('b')], [], {
      initialDelay: 0.3, nodeDuration: 0.5, nodeGap: 0.1,
    });
    const a = eventById(engine, 'a');
    const b = eventById(engine, 'b');
    expect(a.start).toBeCloseTo(0.3);
    expect(a.duration).toBeCloseTo(0.5);
    expect(b.start).toBeCloseTo(0.3 + 0.5 + 0.1);
  });

  it('respects explicit animStartTime and animDuration', () => {
    const engine = new AnimationEngine(
      [node('a', { animStartTime: 4, animDuration: 2 })], []
    );
    const a = eventById(engine, 'a');
    expect(a.start).toBe(4);
    expect(a.duration).toBe(2);
  });

  it('schedules links after the node phase plus the link start pause', () => {
    const engine = new AnimationEngine(
      [node('a'), node('b')],
      [link('l1', 'a', 'b')],
      { initialDelay: 0, nodeDuration: 1, nodeGap: 0, linkStartPause: 0.2, linkDuration: 0.5 }
    );
    const l1 = eventById(engine, 'l1');
    // Two nodes (1s each, no gap) then the pause.
    expect(l1.start).toBeCloseTo(2.2);
    expect(l1.duration).toBeCloseTo(0.5);
  });

  it('starts an on-end triggered node when its trigger link finishes', () => {
    const engine = new AnimationEngine(
      [
        node('a'),
        node('b', { triggerAfterLinkId: 'l1', triggerMode: 'on-end', triggerDelay: 0 }),
      ],
      [link('l1', 'a', 'b', { animStartTime: 3, animDuration: 1 })]
    );
    const b = eventById(engine, 'b');
    expect(b.start).toBeCloseTo(4);
  });

  it('excludes mirror nodes from the timeline', () => {
    const engine = new AnimationEngine(
      [node('a'), node('m', { type: 'mirror' })], []
    );
    expect(eventById(engine, 'm')).toBeUndefined();
    expect(eventById(engine, 'a')).toBeDefined();
  });

  it('keeps total duration at least contentDuration plus holdAfter', () => {
    const engine = new AnimationEngine([node('a')], [], { holdAfter: 1.2 });
    expect(engine.getTotalDuration()).toBeGreaterThanOrEqual(
      engine.getContentDuration() + 1.2 - 1e-9
    );
  });

  it('extends content duration to cover failure keyframes', () => {
    const engine = new AnimationEngine(
      [node('a', { failureKeyframes: [{ id: 'f1', startTime: 9, duration: 1 }] })], []
    );
    expect(engine.getContentDuration()).toBeGreaterThanOrEqual(10);
  });

  it('extends content duration to cover link failure keyframes', () => {
    const engine = new AnimationEngine(
      [node('a'), node('b')],
      [{ id: 'l1', fromId: 'a', toId: 'b', failureKeyframes: [{ id: 'f1', startTime: 12, duration: 1 }] }]
    );
    expect(engine.getContentDuration()).toBeGreaterThanOrEqual(13);
  });
});

describe('AnimationEngine event triggers', () => {
  const startOf = (engine, id) => engine.getTimeline().find(e => e.type === 'node' && e.id === id).start;

  it('starts a node when another node failure completes', () => {
    const engine = new AnimationEngine([
      node('a', { failureKeyframes: [{ id: 'f', startTime: 4, duration: 1 }] }),
      node('b', { triggerEventId: 'failure:a:f', triggerMode: 'on-end' }),
    ], []);
    expect(startOf(engine, 'b')).toBeCloseTo(5);
  });

  it('applies the trigger delay', () => {
    const engine = new AnimationEngine([
      node('a', { failureKeyframes: [{ id: 'f', startTime: 4, duration: 1 }] }),
      node('b', { triggerEventId: 'failure:a:f', triggerMode: 'on-end', triggerDelay: 0.5 }),
    ], []);
    expect(startOf(engine, 'b')).toBeCloseTo(5.5);
  });

  it('settles chains of triggers', () => {
    const engine = new AnimationEngine([
      node('a', { animStartTime: 2, animDuration: 1 }),
      node('b', { triggerEventId: 'node:a', triggerMode: 'on-end' }),
      node('c', { triggerEventId: 'node:b', triggerMode: 'on-end' }),
    ], []);
    const bEnd = startOf(engine, 'b') + engine.getTimeline().find(e => e.id === 'b').duration;
    expect(startOf(engine, 'b')).toBeCloseTo(3);
    expect(startOf(engine, 'c')).toBeCloseTo(bEnd);
  });

  it('starts a token-triggered node only once the token has arrived', () => {
    const engine = new AnimationEngine(
      [node('a'), node('b'), node('c', { triggerEventId: 'token:l', triggerMode: 'overlap' })],
      [link('l', 'a', 'b', { manualTokenEnabled: true, manualTokenDuration: 2 })]
    );
    const linkEvent = engine.getTimeline().find(e => e.type === 'link' && e.id === 'l');
    expect(startOf(engine, 'c')).toBeCloseTo(linkEvent.start + 2);
  });

  it('starts an event-triggered link when the event ends', () => {
    const engine = new AnimationEngine(
      [node('a', { failureKeyframes: [{ id: 'f', startTime: 6, duration: 1 }] }), node('b')],
      [link('l', 'a', 'b', { triggerEventId: 'failure:a:f' })]
    );
    expect(engine.getTimeline().find(e => e.type === 'link' && e.id === 'l').start).toBeCloseTo(7);
  });

  it('moves link-triggered nodes along with an event-triggered link', () => {
    const engine = new AnimationEngine(
      [
        node('a', { failureKeyframes: [{ id: 'f', startTime: 6, duration: 1 }] }),
        node('b', { triggerAfterLinkId: 'l', triggerMode: 'on-end' }),
      ],
      [link('l', 'a', 'b', { triggerEventId: 'failure:a:f', animDuration: 0.5 })]
    );
    expect(startOf(engine, 'b')).toBeCloseTo(7.5);
  });

  it('falls back gracefully when the event no longer exists', () => {
    const engine = new AnimationEngine([node('b', { triggerEventId: 'failure:gone:f' })], []);
    expect(Number.isFinite(startOf(engine, 'b'))).toBe(true);
  });
});

describe('AnimationEngine.getStateAtTime', () => {
  it('holds entry at 0 before start and completes after end', () => {
    const engine = new AnimationEngine(
      [node('a', { animStartTime: 1, animDuration: 1 })], []
    );
    expect(engine.getStateAtTime(0).nodeStates.a.opacity).toBe(0);
    const done = engine.getStateAtTime(5).nodeStates.a;
    expect(done.opacity).toBeCloseTo(1);
    expect(done.scale).toBeCloseTo(1);
  });

  it('reports link progress 0 before and 1 after the draw window', () => {
    const engine = new AnimationEngine(
      [node('a'), node('b')],
      [link('l1', 'a', 'b', { animStartTime: 2, animDuration: 1 })]
    );
    expect(engine.getStateAtTime(0).linkStates.l1.progress).toBe(0);
    expect(engine.getStateAtTime(10).linkStates.l1.progress).toBeCloseTo(1);
  });

  it('pops a disableAnimation link fully drawn at its keyframe', () => {
    const engine = new AnimationEngine(
      [node('a'), node('b')],
      [link('l1', 'a', 'b', { animStartTime: 2, animDuration: 1, disableAnimation: true })]
    );
    expect(engine.getStateAtTime(1.99).linkStates.l1.progress).toBe(0);
    expect(engine.getStateAtTime(2.01).linkStates.l1.progress).toBe(1);
  });
});

describe('AnimationEngine variable webs', () => {
  it('caches getVariableWebs and computes hop timing from the final timeline', () => {
    const nodes = [
      node('v', { type: 'variable', variableLabel: 'x', animStartTime: 0, animDuration: 1 }),
      node('a'),
    ];
    const links = [link('l1', 'v', 'a', { animStartTime: 0, animDuration: 2 })];
    const engine = new AnimationEngine(nodes, links);
    const webs = engine.getVariableWebs();
    expect(engine.getVariableWebs()).toBe(webs); // cached
    expect(webs).toHaveLength(1);
    // Hop waits for both the variable draw end (1) and the link draw end (2).
    expect(webs[0].tokenTiming.l1.start).toBeCloseTo(2);
  });
});

describe('blueprint items', () => {
  const bpNode = (id, o = {}) => ({ id, type: 'node', label: id, x: 0, y: 0, width: 100, height: 50, ...o });
  const bpLink = (id, fromId, toId, o = {}) => ({ id, fromId, toId, joints: [], ...o });

  it('are fully visible at every time and take no slot in the sequence', () => {
    const nodes = [bpNode('a', { blueprint: true }), bpNode('b', { blueprint: true }), bpNode('c')];
    const links = [bpLink('l', 'a', 'b', { blueprint: true })];
    const engine = new AnimationEngine(nodes, links);
    const state = engine.getStateAtTime(0);
    expect(state.nodeStates.a.opacity).toBe(1);
    expect(state.nodeStates.b.opacity).toBe(1);
    expect(state.linkStates.l.progress).toBe(1);
    // The live node starts where it would without the blueprint items.
    const alone = new AnimationEngine([bpNode('c')], []);
    const startOf = (eng, id) => eng.getTimeline().find(e => e.id === id).start;
    expect(startOf(engine, 'c')).toBe(startOf(alone, 'c'));
  });

  it('join the timeline once triggered', () => {
    const nodes = [bpNode('a'), bpNode('b', { blueprint: true, triggerEventId: 'node:a' })];
    const engine = new AnimationEngine(nodes, []);
    const a = engine.getTimeline().find(e => e.id === 'a');
    const b = engine.getTimeline().find(e => e.id === 'b');
    expect(b.blueprint).toBeFalsy();
    expect(b.start).toBeGreaterThan(a.start);
    expect(engine.getStateAtTime(0).nodeStates.b.opacity).toBe(0);
  });
});
