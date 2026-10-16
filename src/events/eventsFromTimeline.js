// Project events: everything in a project that has a creation ("start") and a
// destruction / completion ("end") time — node fade-ins, link draws, morphs,
// failures, tokens, transforms, popups, scroll steps and graph keys.
//
// Events are derived from the AnimationEngine timeline playback uses, so their
// times always match what plays. Instant events (e.g. a token text key, or a blueprint
// node that is always on screen) have start === end. This module is read-only: it does not schedule anything.

import { computeManualTokenTimingByLinkId, normalizeManualTokenTextKeyframes } from '../animation/manualTokenTiming';
import { normalizeNodeFailureKeyframes } from '../animation/nodeFailureTiming';
import { normalizeScrollSteps } from '../animation/scrollStepTiming';
import { getNodeTextMorphs } from '../text/textMorphs';

export const EVENT_KINDS = {
  node: { label: 'Node', verb: 'appears' },
  link: { label: 'Link', verb: 'draws' },
  transform: { label: 'Transform', verb: 'transforms' },
  popup: { label: 'Popup', verb: 'opens popup' },
  morph: { label: 'Morph', verb: 'morphs' },
  failure: { label: 'Failure', verb: 'fails' },
  token: { label: 'Token', verb: 'travels' },
  'token-text': { label: 'Token text', verb: 'changes text' },
  'variable-token': { label: 'Variable hop', verb: 'hops' },
  'scroll-step': { label: 'Scroll step', verb: 'scrolls' },
  'graph-point': { label: 'Graph point', verb: 'plots' },
  'graph-domain': { label: 'Graph domain', verb: 'draws domain' },
  'graph-calc': { label: 'Graph calc', verb: 'calculates' },
};

const r3 = v => Math.round(v * 1000) / 1000;
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function nodeName(node) {
  return (node?.label ?? '').trim() || (node?.variableLabel ?? '').trim() || 'Untitled node';
}

function linkName(link, nodeById) {
  return `${nodeName(nodeById.get(link.fromId))} → ${nodeName(nodeById.get(link.toId))}`;
}

// Builds events from an already-computed timeline. Kept free of AnimationEngine so the
// engine itself can resolve event triggers with it (no import cycle).
export function buildEventsFromTimeline(nodes = [], links = [], timeline = [], webs = []) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const linkById = new Map(links.map(link => [link.id, link]));
  const events = [];

  const add = (kind, owner, label, start, end, extra = {}) => {
    if (!Number.isFinite(start)) return;
    const safeEnd = Number.isFinite(end) ? Math.max(start, end) : start;
    events.push({
      id: `${kind}:${owner.id}${extra.subId ? `:${extra.subId}` : ''}`,
      kind,
      ownerKind: owner.kind,
      ownerId: owner.id,
      label,
      start: r3(start),
      end: r3(safeEnd),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.triggerEventId ? { triggerEventId: extra.triggerEventId } : {}),
      ...(extra.blueprint ? { blueprint: true } : {}),
    });
  };

  for (const event of timeline) {
    if (event.type === 'node') {
      const node = nodeById.get(event.id);
      if (!node) continue;
      const owner = { kind: 'node', id: node.id };
      const name = nodeName(node);
      // A blueprint node is simply there from the start (an instant event at 0).
      add('node', owner, name, event.start, event.blueprint ? event.start : event.start + event.duration, { blueprint: event.blueprint });
      if (event.transformStart != null && event.transformEnd != null) {
        add('transform', owner, name, event.transformStart, event.transformEnd);
      }
      if (event.popupStart != null && event.popupEnd != null) {
        add('popup', owner, name, event.popupStart, event.popupEnd);
      }
      for (const morph of getNodeTextMorphs(node, { start: event.start, duration: event.duration })) {
        add('morph', owner, name, morph.startTime, morph.startTime + morph.duration, {
          subId: morph.id,
          detail: morph.text ? `→ “${morph.text}”` : '→ blank',
        });
      }
    } else if (event.type === 'link') {
      const link = linkById.get(event.id);
      if (!link) continue;
      add('link', { kind: 'link', id: link.id }, linkName(link, nodeById), event.start, event.blueprint ? event.start : event.start + event.duration, { blueprint: event.blueprint });
    }
  }

  // Failures (nodes and links)
  for (const node of nodes) {
    for (const failure of normalizeNodeFailureKeyframes(node.failureKeyframes)) {
      add('failure', { kind: 'node', id: node.id }, nodeName(node), failure.startTime, failure.startTime + failure.duration, { subId: failure.id, triggerEventId: failure.triggerEventId });
    }
  }
  for (const link of links) {
    for (const failure of normalizeNodeFailureKeyframes(link.failureKeyframes)) {
      add('failure', { kind: 'link', id: link.id }, linkName(link, nodeById), failure.startTime, failure.startTime + failure.duration, { subId: failure.id, triggerEventId: failure.triggerEventId });
    }
  }

  // Manual tokens and their text keys
  const manualTracks = computeManualTokenTimingByLinkId(links, timeline);
  for (const [linkId, track] of Object.entries(manualTracks)) {
    const link = linkById.get(linkId);
    if (!link) continue;
    const owner = { kind: 'link', id: link.id };
    const name = linkName(link, nodeById);
    add('token', owner, name, track.start, track.start + track.duration, {
      detail: track.baseText ? `“${track.baseText}”` : undefined,
      triggerEventId: track.triggerEventId ?? undefined,
    });
    for (const keyframe of normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes)) {
      add('token-text', owner, name, keyframe.time, keyframe.time, {
        subId: keyframe.id,
        detail: keyframe.text ? `→ “${keyframe.text}”` : '→ blank',
      });
    }
  }

  // Variable token hops
  for (const web of webs ?? []) {
    const source = nodeById.get(web.sourceNodeId);
    for (const linkId of web.tokenPath ?? []) {
      const timing = web.tokenTiming?.[linkId];
      const link = linkById.get(linkId);
      if (!timing || timing.skipped || !link) continue;
      add('variable-token', { kind: 'node', id: web.sourceNodeId }, nodeName(source), timing.start, timing.start + timing.duration, {
        subId: linkId,
        detail: linkName(link, nodeById),
      });
    }
  }

  // Scroll steps and graph keys
  for (const node of nodes) {
    const owner = { kind: 'node', id: node.id };
    const name = nodeName(node);
    if (node.type === 'area' && node.scrollEnabled && node.scrollMode === 'stepped') {
      for (const step of normalizeScrollSteps(node.scrollSteps)) {
        add('scroll-step', owner, name, step.time, step.time + step.duration, { subId: step.id });
      }
    }
    if (node.type === 'graph') {
      for (const point of node.graphPoints ?? []) {
        const start = finite(point.startTime, 0);
        add('graph-point', owner, name, start, start + finite(point.duration, 0.35), { subId: point.id });
      }
      for (const domain of node.graphDomains ?? []) {
        const start = finite(domain.startTime, 0);
        add('graph-domain', owner, name, start, start + finite(domain.duration, 0.4), { subId: domain.id });
        if (domain.calc) {
          const calcStart = finite(domain.calc.time, 0);
          add('graph-calc', owner, name, calcStart, calcStart + finite(domain.calc.duration, 1), { subId: `${domain.id}-calc` });
        }
      }
    }
  }

  return events.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
}

// ── Event connections ──────────────────────────────────────────────────────
// How events relate to each other, for the event cascade:
//   trigger — the source event starts the target (node/link/token/failure triggers)
//   part    — the target belongs to the source (a token's text keys,
//             a node's morphs / failures / transforms / popups, …)
export const EVENT_EDGE_KINDS = {
  trigger: { label: 'Triggers' },
  part: { label: 'Part of' },
};

// A token is deliberately not linked to its link: the line added nothing but clutter.
const PART_PARENTS = {
  'token-text': event => `token:${event.ownerId}`,
  morph: event => `node:${event.ownerId}`,
  transform: event => `node:${event.ownerId}`,
  popup: event => `node:${event.ownerId}`,
  failure: event => `${event.ownerKind}:${event.ownerId}`,
  'variable-token': event => `node:${event.ownerId}`,
  'scroll-step': event => `node:${event.ownerId}`,
  'graph-point': event => `node:${event.ownerId}`,
  'graph-domain': event => `node:${event.ownerId}`,
  'graph-calc': event => `node:${event.ownerId}`,
};

export function buildEventEdges(nodes = [], links = [], events = []) {
  const ids = new Set(events.map(event => event.id));
  const edges = [];
  const seen = new Set();
  const add = (from, to, kind) => {
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) return;
    const id = `${kind}:${from}->${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, from, to, kind });
  };

  for (const node of nodes) {
    if (node.triggerAfterLinkId) add(`link:${node.triggerAfterLinkId}`, `node:${node.id}`, 'trigger');
    else if (node.triggerEventId) add(node.triggerEventId, `node:${node.id}`, 'trigger');
  }
  for (const link of links) {
    if (link.triggerEventId) add(link.triggerEventId, `link:${link.id}`, 'trigger');
    // A triggered token is independent of its link's draw.
    if (link.manualTokenEnabled && link.manualTokenTriggerEventId) add(link.manualTokenTriggerEventId, `token:${link.id}`, 'trigger');
  }
  // Failures can be triggered by an event too (see triggeredKeyframes.js).
  for (const item of [...nodes, ...links]) {
    for (const keyframe of item.failureKeyframes ?? []) {
      if (keyframe?.triggerEventId) add(keyframe.triggerEventId, `failure:${item.id}:${keyframe.id}`, 'trigger');
    }
  }
  for (const event of events) {
    // A triggered event is connected by its trigger alone, not as part of its owner.
    if (event.triggerEventId) continue;
    const parent = PART_PARENTS[event.kind]?.(event);
    if (parent) add(parent, event.id, 'part');
  }
  return edges;
}
