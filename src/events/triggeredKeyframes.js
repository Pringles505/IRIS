// Keyframes (currently node and link failures) can be triggered by an event: the
// failure then starts exactly when that event finishes. The resolved start time is
// written back onto the keyframe, so playback, the timeline, exports and the event
// list all read the same value without special handling.
import { buildProjectEvents } from './projectEvents';

const r2 = v => Math.round(v * 100) / 100;

export function hasTriggeredKeyframes(nodes = [], links = []) {
  return [...nodes, ...links].some(item => (item.failureKeyframes ?? []).some(kf => kf?.triggerEventId));
}

// Returns { nodes, links, changed } with every triggered failure moved to the end of its
// event. Passes repeat until chains (one failure triggering another) settle; each pass
// settles at least one more failure, so only a trigger cycle reaches the limit.
export function resolveTriggeredKeyframes(nodes = [], links = []) {
  if (!hasTriggeredKeyframes(nodes, links)) return { nodes, links, changed: false };
  let current = { nodes, links };
  let changed = false;

  const triggeredCount = [...nodes, ...links]
    .reduce((sum, item) => sum + (item.failureKeyframes ?? []).filter(kf => kf?.triggerEventId).length, 0);
  for (let pass = 0; pass < triggeredCount + 1; pass += 1) {
    const eventById = new Map(buildProjectEvents(current.nodes, current.links).map(event => [event.id, event]));
    let passChanged = false;
    const resolveItem = item => {
      const keyframes = item.failureKeyframes ?? [];
      if (!keyframes.some(kf => kf?.triggerEventId)) return item;
      let itemChanged = false;
      const next = keyframes.map(kf => {
        if (!kf?.triggerEventId) return kf;
        // A failure can't be triggered by itself.
        if (kf.triggerEventId.startsWith('failure:') && kf.triggerEventId.endsWith(`:${kf.id}`)) return kf;
        const event = eventById.get(kf.triggerEventId);
        if (!event) return kf;
        const start = r2(Math.max(0, event.end));
        if (Math.abs((kf.startTime ?? 0) - start) < 0.005) return kf;
        itemChanged = true;
        return { ...kf, startTime: start };
      });
      if (!itemChanged) return item;
      passChanged = true;
      return { ...item, failureKeyframes: next };
    };
    const nextNodes = current.nodes.map(resolveItem);
    const nextLinks = current.links.map(resolveItem);
    if (!passChanged) break;
    current = { nodes: nextNodes, links: nextLinks };
    changed = true;
  }
  return { ...current, changed };
}
