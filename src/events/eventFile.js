// The events file: a plain JSON description of a project's animation as events, meant
// to be read and edited by people or models. Editing `triggeredBy` rewires what starts
// what; editing `start` / `duration` moves untriggered items. Applying the file writes
// those changes back into the project, which changes the order of the animation.
import { buildEventGraph } from './projectEvents';

export const EVENT_FILE_VERSION = 1;

// Which events can be changed through the file.
export const TRIGGERABLE_EVENT_KINDS = new Set(['node', 'link', 'token', 'failure']);
const TRIGGERABLE = TRIGGERABLE_EVENT_KINDS;
const TIMEABLE = new Set(['node', 'link', 'token', 'failure', 'morph']);

const EPS = 0.005;
const r2 = v => Math.round(v * 100) / 100;

const INSTRUCTIONS = [
  'Each event has a start and end time in seconds. Times are computed from the project; they are not stored here.',
  'To change what starts an event, set "triggeredBy" to another event id, or null for no trigger.',
  'An event that is triggered starts when its trigger event finishes (tokens: when the token arrives).',
  'Only events with "canTrigger": true accept a trigger (node appears, link draws, tokens, failures).',
  'A token with no trigger follows its link draw; once triggered, it starts when its trigger finishes, independent of the link.',
  'For events with "canTime": true and no trigger, change "start" and/or "duration" to move or resize them.',
  'Leave everything else as it is. Ids must match existing events; unknown ids are reported and skipped.',
];

// The trigger currently set on the item behind an event, as an event id (or null).
function currentTrigger(event, nodeById, linkById) {
  if (event.kind === 'node') {
    const node = nodeById.get(event.ownerId);
    if (node?.triggerAfterLinkId) return `link:${node.triggerAfterLinkId}`;
    return node?.triggerEventId ?? null;
  }
  if (event.kind === 'link') return linkById.get(event.ownerId)?.triggerEventId ?? null;
  if (event.kind === 'token') return linkById.get(event.ownerId)?.manualTokenTriggerEventId ?? null;
  if (event.kind === 'failure') return event.triggerEventId ?? null;
  return null;
}

export function buildEventFile(nodes = [], links = [], { projectName = '' } = {}) {
  const { events } = buildEventGraph(nodes, links);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const linkById = new Map(links.map(link => [link.id, link]));
  return {
    format: 'iris-events',
    version: EVENT_FILE_VERSION,
    project: projectName,
    instructions: INSTRUCTIONS,
    events: events.map(event => ({
      id: event.id,
      kind: event.kind,
      target: { kind: event.ownerKind, id: event.ownerId },
      label: event.label,
      ...(event.detail ? { detail: event.detail } : {}),
      start: event.start,
      end: event.end,
      duration: r2(event.end - event.start),
      triggeredBy: currentTrigger(event, nodeById, linkById),
      canTrigger: TRIGGERABLE.has(event.kind),
      canTime: TIMEABLE.has(event.kind),
    })),
  };
}

// Sets (or clears, with null) the trigger of the item behind `targetEventId`.
// Returns new { nodes, links } — inputs are not mutated.
export function setEventTrigger(nodes, links, targetEventId, sourceEventId) {
  const [kind, ownerId, subId] = targetEventId.split(':');
  const trigger = sourceEventId || null;
  if (kind === 'node') {
    return {
      links,
      nodes: nodes.map(node => {
        if (node.id !== ownerId) return node;
        if (!trigger) return { ...node, triggerAfterLinkId: null, triggerEventId: null };
        // A link's draw keeps using the classic link trigger.
        if (trigger.startsWith('link:')) {
          return { ...node, triggerAfterLinkId: trigger.slice(5), triggerEventId: null, animStartTime: null };
        }
        return { ...node, triggerEventId: trigger, triggerAfterLinkId: null, animStartTime: null };
      }),
    };
  }
  if (kind === 'link') {
    return {
      nodes,
      links: links.map(link => (link.id !== ownerId ? link : {
        ...link,
        triggerEventId: trigger,
        ...(trigger ? { animStartTime: null } : {}),
      })),
    };
  }
  if (kind === 'token') {
    if (trigger === targetEventId) return { nodes, links }; // a token can't trigger itself
    return {
      nodes,
      links: links.map(link => (link.id !== ownerId ? link : { ...link, manualTokenTriggerEventId: trigger })),
    };
  }
  if (kind === 'failure') {
    const update = item => (item.id !== ownerId ? item : {
      ...item,
      failureKeyframes: (item.failureKeyframes ?? []).map(kf => {
        if (kf.id !== subId) return kf;
        if (!trigger) {
          const { triggerEventId, ...rest } = kf;
          return rest;
        }
        return { ...kf, triggerEventId: trigger };
      }),
    });
    return { nodes: nodes.map(update), links: links.map(update) };
  }
  return { nodes, links };
}

function setEventTiming(nodes, links, event, start, duration) {
  const [kind, ownerId, subId] = event.id.split(':');
  if (kind === 'node' || kind === 'link') {
    const patch = item => (item.id !== ownerId ? item : {
      ...item,
      ...(start != null ? { animStartTime: r2(Math.max(0, start)) } : {}),
      ...(duration != null ? { animDuration: r2(Math.max(0.05, duration)) } : {}),
    });
    return kind === 'node' ? { nodes: nodes.map(patch), links } : { nodes, links: links.map(patch) };
  }
  if (kind === 'token') {
    // Token start = anchor (link draw or trigger) + delay, so moving it shifts the delay.
    return {
      nodes,
      links: links.map(link => {
        if (link.id !== ownerId) return link;
        const delay = Number.isFinite(link.manualTokenDelay) ? link.manualTokenDelay : 0;
        return {
          ...link,
          ...(start != null ? { manualTokenDelay: r2(delay + start - event.start) } : {}),
          ...(duration != null ? { manualTokenDuration: r2(Math.max(0.05, duration)) } : {}),
        };
      }),
    };
  }
  if (kind === 'failure') {
    const patch = item => (item.id !== ownerId ? item : {
      ...item,
      failureKeyframes: (item.failureKeyframes ?? []).map(kf => (kf.id !== subId ? kf : {
        ...kf,
        ...(start != null ? { startTime: r2(Math.max(0, start)) } : {}),
        ...(duration != null ? { duration: r2(Math.max(0.1, duration)) } : {}),
      })),
    });
    return { nodes: nodes.map(patch), links: links.map(patch) };
  }
  if (kind === 'morph') {
    return {
      links,
      nodes: nodes.map(node => (node.id !== ownerId ? node : {
        ...node,
        textMorphs: (node.textMorphs ?? []).map(morph => (morph.id !== subId ? morph : {
          ...morph,
          ...(start != null ? { startTime: r2(Math.max(0, start)) } : {}),
          ...(duration != null ? { duration: r2(Math.max(0.1, duration)) } : {}),
        })),
      })),
    };
  }
  return { nodes, links };
}

// Applies an edited events file. Only fields that differ from the project are changed.
// Returns { nodes, links, changes: [string], problems: [string] }.
export function applyEventFile(nodes = [], links = [], file) {
  const problems = [];
  const changes = [];
  if (!file || !Array.isArray(file.events)) {
    return { nodes, links, changes, problems: ['Not an events file: missing "events" list.'] };
  }
  const current = new Map(buildEventFile(nodes, links).events.map(event => [event.id, event]));
  let result = { nodes, links };

  for (const entry of file.events) {
    const event = current.get(entry?.id);
    if (!event) {
      problems.push(`Unknown event "${entry?.id}" — skipped.`);
      continue;
    }

    const hasTrigger = Object.prototype.hasOwnProperty.call(entry, 'triggeredBy');
    const nextTrigger = hasTrigger ? (entry.triggeredBy || null) : event.triggeredBy;
    if (hasTrigger && nextTrigger !== event.triggeredBy) {
      if (!event.canTrigger) {
        problems.push(`"${event.id}" (${event.kind}) can't be triggered — change ignored.`);
      } else if (nextTrigger && !current.has(nextTrigger)) {
        problems.push(`"${event.id}": trigger "${nextTrigger}" doesn't exist — change ignored.`);
      } else {
        result = setEventTrigger(result.nodes, result.links, event.id, nextTrigger);
        changes.push(nextTrigger ? `${event.id} is now triggered by ${nextTrigger}` : `${event.id} is no longer triggered`);
      }
    }

    const startChanged = Number.isFinite(entry.start) && Math.abs(entry.start - event.start) > EPS;
    const durationChanged = Number.isFinite(entry.duration) && Math.abs(entry.duration - event.duration) > EPS;
    if (!startChanged && !durationChanged) continue;
    if (!event.canTime) {
      problems.push(`"${event.id}" (${event.kind}) timing is read-only — change ignored.`);
      continue;
    }
    // A triggered item's start comes from its trigger; only its duration can change.
    const startAllowed = startChanged && !nextTrigger;
    if (startChanged && nextTrigger) problems.push(`"${event.id}" is triggered, so its start follows the trigger — start ignored.`);
    if (!startAllowed && !durationChanged) continue;
    result = setEventTiming(result.nodes, result.links, event, startAllowed ? entry.start : null, durationChanged ? entry.duration : null);
    changes.push(`${event.id} timing → ${startAllowed ? `start ${r2(entry.start)}s ` : ''}${durationChanged ? `duration ${r2(entry.duration)}s` : ''}`.trim());
  }

  return { ...result, changes, problems };
}
