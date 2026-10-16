import { describe, expect, it } from 'vitest';
import { applyEventFile, buildEventFile, setEventTrigger } from './eventFile';
import { buildProjectEvents } from './projectEvents';
import { resolveTriggeredKeyframes } from './triggeredKeyframes';

const node = (id, overrides = {}) => ({ id, type: 'node', label: id, x: 0, y: 0, width: 100, height: 50, ...overrides });
const link = (id, fromId, toId, overrides = {}) => ({ id, fromId, toId, joints: [], ...overrides });
const project = () => ({
  nodes: [node('a'), node('b'), node('c')],
  links: [link('l', 'a', 'b', { manualTokenEnabled: true }), link('m', 'b', 'c')],
});
const startOf = (nodes, links, id) => buildProjectEvents(nodes, links).find(e => e.id === id).start;

describe('events file', () => {
  it('lists events with their current triggers', () => {
    const { nodes, links } = project();
    nodes[2].triggerAfterLinkId = 'l';
    const file = buildEventFile(nodes, links, { projectName: 'Demo' });
    expect(file.format).toBe('iris-events');
    expect(file.events.find(e => e.id === 'node:c').triggeredBy).toBe('link:l');
    expect(file.events.find(e => e.id === 'node:a').triggeredBy).toBeNull();
    expect(file.events.find(e => e.id === 'token:l').canTrigger).toBe(true);
    expect(file.events.find(e => e.id === 'token:l').triggeredBy).toBeNull();
  });

  it('applying an unchanged file changes nothing', () => {
    const { nodes, links } = project();
    const result = applyEventFile(nodes, links, buildEventFile(nodes, links));
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.nodes).toEqual(nodes);
    expect(result.links).toEqual(links);
  });

  it('rewires the animation order through triggeredBy', () => {
    const { nodes, links } = project();
    const file = buildEventFile(nodes, links);
    file.events.find(e => e.id === 'link:m').triggeredBy = 'token:l';
    const result = applyEventFile(nodes, links, file);
    expect(result.links.find(l => l.id === 'm').triggerEventId).toBe('token:l');
    const token = buildProjectEvents(result.nodes, result.links).find(e => e.id === 'token:l');
    expect(startOf(result.nodes, result.links, 'link:m')).toBeCloseTo(token.end);
  });

  it('moves untriggered items when start changes and reports bad edits', () => {
    const { nodes, links } = project();
    nodes[0].textMorphs = [{ id: 'm', text: 'Hi', mode: 'fade', startTime: 3, duration: 0.5 }];
    const file = buildEventFile(nodes, links);
    file.events.find(e => e.id === 'node:b').start = 3;
    file.events.find(e => e.kind === 'morph').triggeredBy = 'node:b';
    file.events.push({ id: 'node:ghost', triggeredBy: null });
    const result = applyEventFile(nodes, links, file);
    expect(result.nodes.find(n => n.id === 'b').animStartTime).toBe(3);
    expect(result.problems.length).toBe(2);
  });

  it('sets a failure trigger from the cascade', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('l', 'a', 'b', { animStartTime: 1, animDuration: 0.5, failureKeyframes: [{ id: 'f', startTime: 0, duration: 1 }] })];
    const wired = setEventTrigger(nodes, links, 'failure:l:f', 'link:l');
    const resolved = resolveTriggeredKeyframes(wired.nodes, wired.links);
    expect(resolved.links[0].failureKeyframes[0].startTime).toBeCloseTo(1.5);
  });

  it('triggers a token from any event, independent of its link', () => {
    const { nodes, links } = project();
    const file = buildEventFile(nodes, links);
    const nodeC = file.events.find(e => e.id === 'node:c');
    file.events.find(e => e.id === 'token:l').triggeredBy = 'node:c';
    const result = applyEventFile(nodes, links, file);
    expect(result.problems).toEqual([]);
    expect(result.links.find(l => l.id === 'l').manualTokenTriggerEventId).toBe('node:c');
    expect(startOf(result.nodes, result.links, 'token:l')).toBeCloseTo(nodeC.end, 2);
    // The link itself still draws at its own time.
    expect(startOf(result.nodes, result.links, 'link:l')).toBe(startOf(nodes, links, 'link:l'));
  });

  it('a triggered token can trigger other events', () => {
    const { nodes, links } = project();
    let next = setEventTrigger(nodes, links, 'token:l', 'node:c');
    next = setEventTrigger(next.nodes, next.links, 'link:m', 'token:l');
    const events = buildProjectEvents(next.nodes, next.links);
    const token = events.find(e => e.id === 'token:l');
    expect(events.find(e => e.id === 'link:m').start).toBeCloseTo(token.end, 2);
  });

  it('a token cannot trigger itself', () => {
    const { nodes, links } = project();
    const next = setEventTrigger(nodes, links, 'token:l', 'token:l');
    expect(next.links.find(l => l.id === 'l').manualTokenTriggerEventId).toBeUndefined();
  });
});
